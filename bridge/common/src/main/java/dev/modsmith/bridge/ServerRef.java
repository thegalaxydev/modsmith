package dev.modsmith.bridge;

import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentLinkedQueue;
import net.minecraft.server.MinecraftServer;

public final class ServerRef {
	private static volatile MinecraftServer current;
	private static volatile long ticks;
	private static final ConcurrentLinkedQueue<Map.Entry<Long, CompletableFuture<Long>>> WAITERS = new ConcurrentLinkedQueue<>();

	private ServerRef() {
	}

	public static MinecraftServer get() {
		return current;
	}

	public static long ticks() {
		return ticks;
	}

	public static void started(MinecraftServer server) {
		current = server;
		ticks = 0;
		Bridge.event("server.started", Map.of("dedicated", server.isDedicatedServer()));
	}

	public static void stopped(MinecraftServer server) {
		if (current == server) {
			current = null;
			for (Map.Entry<Long, CompletableFuture<Long>> w : WAITERS) {
				w.getValue().completeExceptionally(new IllegalStateException("Server stopped"));
			}
			WAITERS.clear();
			Bridge.event("server.stopped", Map.of());
		}
	}

	public static void tick() {
		long now = ++ticks;
		Iterator<Map.Entry<Long, CompletableFuture<Long>>> it = WAITERS.iterator();
		while (it.hasNext()) {
			Map.Entry<Long, CompletableFuture<Long>> w = it.next();
			if (now >= w.getKey()) {
				it.remove();
				w.getValue().complete(now);
			}
		}
	}

	public static CompletableFuture<Long> waitTicks(long count) {
		CompletableFuture<Long> f = new CompletableFuture<>();
		WAITERS.add(Map.entry(ticks + count, f));
		return f;
	}
}
