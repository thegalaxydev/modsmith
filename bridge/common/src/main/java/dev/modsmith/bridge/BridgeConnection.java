package dev.modsmith.bridge;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import net.minecraft.SharedConstants;

public final class BridgeConnection implements WebSocket.Listener {
	private static final Gson GSON = new Gson();
	private final String url;
	private final String token;
	private final String session;
	private final boolean client;
	private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
		Thread t = new Thread(r, "Modsmith-Bridge");
		t.setDaemon(true);
		return t;
	});
	private final StringBuilder partial = new StringBuilder();
	private volatile WebSocket socket;
	private volatile boolean welcomed;
	private CompletableFuture<?> sendChain = CompletableFuture.completedFuture(null);

	public BridgeConnection(String url, String token, String session, boolean client) {
		this.url = url;
		this.token = token;
		this.session = session;
		this.client = client;
	}

	public void start() {
		Thread t = new Thread(this::connectLoop, "Modsmith-Bridge-Connect");
		t.setDaemon(true);
		t.start();
	}

	private void connectLoop() {
		HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
		int attempt = 0;
		while (true) {
			if (socket == null) {
				try {
					socket = http.newWebSocketBuilder().buildAsync(URI.create(url), this).join();
					attempt = 0;
				} catch (CompletionException e) {
					attempt++;
					if (attempt == 1 || attempt % 12 == 0) {
						Bridge.LOGGER.warn("Modsmith bridge could not connect: {}", e.getCause() == null ? e.getMessage() : e.getCause().getMessage());
					}
				}
			}
			try {
				Thread.sleep(socket == null ? 5000 : 2000);
			} catch (InterruptedException e) {
				return;
			}
		}
	}

	@Override
	public void onOpen(WebSocket webSocket) {
		JsonObject hello = new JsonObject();
		hello.addProperty("type", "hello");
		hello.addProperty("protocol", Bridge.PROTOCOL);
		hello.addProperty("session", session);
		hello.addProperty("token", token);
		JsonObject game = new JsonObject();
		game.addProperty("minecraft", SharedConstants.getCurrentVersion().getName());
		game.addProperty("loader", Bridge.platform().loaderName());
		game.addProperty("loaderVersion", Bridge.platform().loaderVersion());
		game.addProperty("side", client ? "client" : "server");
		game.addProperty("bridgeVersion", Bridge.platform().bridgeVersion());
		game.addProperty("development", Bridge.platform().isDevelopment());
		JsonArray caps = new JsonArray();
		Bridge.HANDLERS.keySet().forEach(caps::add);
		game.add("capabilities", caps);
		hello.add("game", game);
		webSocket.sendText(GSON.toJson(hello), true);
		webSocket.request(1);
	}

	@Override
	public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
		partial.append(data);
		if (last) {
			String text = partial.toString();
			partial.setLength(0);
			worker.execute(() -> handleMessage(text));
		}
		webSocket.request(1);
		return null;
	}

	@Override
	public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
		Bridge.LOGGER.info("Modsmith bridge closed: {} {}", statusCode, reason);
		welcomed = false;
		socket = null;
		return null;
	}

	@Override
	public void onError(WebSocket webSocket, Throwable error) {
		Bridge.LOGGER.warn("Modsmith bridge error: {}", error.toString());
		welcomed = false;
		socket = null;
	}

	private void handleMessage(String text) {
		JsonObject msg;
		try {
			msg = JsonParser.parseString(text).getAsJsonObject();
		} catch (RuntimeException e) {
			return;
		}
		String type = msg.has("type") ? msg.get("type").getAsString() : "";
		if ("welcome".equals(type)) {
			welcomed = msg.has("ok") && msg.get("ok").getAsBoolean();
			if (welcomed) {
				Bridge.LOGGER.info("Modsmith bridge connected");
			} else {
				Bridge.LOGGER.warn("Modsmith bridge rejected: {}", msg.has("error") ? msg.get("error").getAsString() : "unknown");
			}
			return;
		}
		if (!"request".equals(type) || !welcomed) {
			return;
		}
		int id = msg.get("id").getAsInt();
		String method = msg.get("method").getAsString();
		JsonObject params = msg.has("params") && msg.get("params").isJsonObject() ? msg.getAsJsonObject("params") : new JsonObject();
		Handler handler = Bridge.HANDLERS.get(method);
		if (handler == null) {
			respond(id, null, "Unknown bridge method " + method);
			return;
		}
		CompletableFuture<JsonElement> future;
		try {
			future = handler.handle(params);
		} catch (Exception e) {
			respond(id, null, describe(e));
			return;
		}
		future.whenComplete((result, error) -> {
			if (error != null) {
				respond(id, null, describe(error));
			} else {
				respond(id, result, null);
			}
		});
	}

	private static String describe(Throwable error) {
		Throwable t = error;
		while ((t instanceof CompletionException || t instanceof java.util.concurrent.ExecutionException) && t.getCause() != null) {
			t = t.getCause();
		}
		return t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage();
	}

	private void respond(int id, JsonElement result, String error) {
		JsonObject res = new JsonObject();
		res.addProperty("type", "response");
		res.addProperty("id", id);
		res.addProperty("ok", error == null);
		if (error == null) {
			res.add("result", result);
		} else {
			res.addProperty("error", error);
		}
		send(GSON.toJson(res));
	}

	public void sendEvent(String event, Object data) {
		if (!welcomed) {
			return;
		}
		JsonObject ev = new JsonObject();
		ev.addProperty("type", "event");
		ev.addProperty("event", event);
		ev.add("data", GSON.toJsonTree(data));
		send(GSON.toJson(ev));
	}

	private synchronized void send(String text) {
		WebSocket ws = socket;
		if (ws == null) {
			return;
		}
		sendChain = sendChain.handle((v, e) -> null).thenCompose(v -> ws.sendText(text, true));
	}
}
