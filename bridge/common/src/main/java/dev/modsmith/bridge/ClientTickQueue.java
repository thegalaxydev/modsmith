package dev.modsmith.bridge;

import java.util.concurrent.ConcurrentLinkedQueue;
import net.minecraft.client.Minecraft;

public final class ClientTickQueue {
	private static final ConcurrentLinkedQueue<Runnable> QUEUE = new ConcurrentLinkedQueue<>();

	private ClientTickQueue() {
	}

	public static void addWhenIdle(Runnable r) {
		QUEUE.add(r);
	}

	public static boolean idle() {
		return Minecraft.getInstance().getOverlay() == null;
	}

	public static void drain() {
		if (!idle()) {
			return;
		}
		Runnable r;
		while ((r = QUEUE.poll()) != null) {
			try {
				r.run();
			} catch (RuntimeException e) {
				Bridge.LOGGER.error("Modsmith client tick action failed", e);
			}
		}
	}
}
