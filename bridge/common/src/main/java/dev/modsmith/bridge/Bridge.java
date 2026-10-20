package dev.modsmith.bridge;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class Bridge {
	public static final String MOD_ID = "modsmith_bridge";
	public static final int PROTOCOL = 1;
	public static final Logger LOGGER = LoggerFactory.getLogger("ModsmithBridge");
	public static final Map<String, Handler> HANDLERS = new LinkedHashMap<>();
	public static volatile Supplier<UUID> localPlayer = () -> null;
	public static volatile BridgeConnection connection;
	private static volatile BridgePlatform platform;

	private Bridge() {
	}

	public static BridgePlatform platform() {
		return platform;
	}

	public static boolean start(BridgePlatform p) {
		platform = p;
		String url = System.getenv("MODSMITH_BRIDGE_URL");
		String token = System.getenv("MODSMITH_BRIDGE_TOKEN");
		String session = System.getenv("MODSMITH_BRIDGE_SESSION");
		if (url == null || token == null || session == null) {
			LOGGER.info("Modsmith bridge is inactive (not launched by Modsmith)");
			return false;
		}
		if (!url.startsWith("ws://127.0.0.1:") && !url.startsWith("ws://localhost:")) {
			LOGGER.warn("Modsmith bridge refused non-loopback endpoint");
			return false;
		}
		CommonHandlers.register(HANDLERS, p.isClient());
		if (p.isClient()) {
			try {
				Class.forName("dev.modsmith.bridge.ClientHandlers").getMethod("register", Map.class).invoke(null, HANDLERS);
			} catch (ReflectiveOperationException e) {
				LOGGER.error("Failed to register client bridge handlers", e);
			}
		}
		connection = new BridgeConnection(url, token, session, p.isClient());
		connection.start();
		LOGGER.info("Modsmith bridge enabled on {} with {} methods", p.loaderName(), HANDLERS.size());
		return true;
	}

	public static void event(String name, Object data) {
		BridgeConnection c = connection;
		if (c != null) {
			c.sendEvent(name, data);
		}
	}
}
