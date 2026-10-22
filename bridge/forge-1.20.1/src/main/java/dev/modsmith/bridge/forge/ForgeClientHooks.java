package dev.modsmith.bridge.forge;

import dev.modsmith.bridge.ClientTickQueue;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.event.TickEvent;

public final class ForgeClientHooks {
	private ForgeClientHooks() {
	}

	public static void register() {
		MinecraftForge.EVENT_BUS.addListener(ForgeClientHooks::onClientTick);
	}

	private static void onClientTick(TickEvent.ClientTickEvent event) {
		if (event.phase == TickEvent.Phase.START) {
			ClientTickQueue.drain();
		}
	}
}
