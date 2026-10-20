package dev.modsmith.bridge.neoforge;

import dev.modsmith.bridge.ClientTickQueue;
import net.neoforged.neoforge.client.event.ClientTickEvent;
import net.neoforged.neoforge.common.NeoForge;

public final class NeoForgeClientHooks {
	private NeoForgeClientHooks() {
	}

	public static void register() {
		NeoForge.EVENT_BUS.addListener(NeoForgeClientHooks::onClientTick);
	}

	private static void onClientTick(ClientTickEvent.Pre event) {
		ClientTickQueue.drain();
	}
}
