package dev.modsmith.bridge.neoforge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.modsmith.bridge.Bridge;
import dev.modsmith.bridge.BridgePlatform;
import dev.modsmith.bridge.ServerRef;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import net.neoforged.fml.ModList;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.loading.FMLEnvironment;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.server.ServerStartedEvent;
import net.neoforged.neoforge.event.server.ServerStoppedEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;
import net.neoforged.neoforgespi.language.IModInfo;

@Mod(Bridge.MOD_ID)
public class NeoForgeBridge implements BridgePlatform {
	public NeoForgeBridge() {
		if (!Bridge.start(this)) {
			return;
		}
		NeoForge.EVENT_BUS.addListener(NeoForgeBridge::onServerStarted);
		NeoForge.EVENT_BUS.addListener(NeoForgeBridge::onServerStopped);
		NeoForge.EVENT_BUS.addListener(NeoForgeBridge::onServerTick);
		if (isClient()) {
			try {
				Class.forName("dev.modsmith.bridge.neoforge.NeoForgeClientHooks").getMethod("register").invoke(null);
			} catch (ReflectiveOperationException e) {
				Bridge.LOGGER.error("Failed to register client hooks", e);
			}
		}
	}

	private static void onServerStarted(ServerStartedEvent event) {
		ServerRef.started(event.getServer());
	}

	private static void onServerStopped(ServerStoppedEvent event) {
		ServerRef.stopped(event.getServer());
	}

	private static void onServerTick(ServerTickEvent.Post event) {
		ServerRef.tick();
	}

	@Override
	public boolean isClient() {
		return FMLEnvironment.dist.isClient();
	}

	@Override
	public boolean isDevelopment() {
		return !FMLEnvironment.production;
	}

	@Override
	public String loaderName() {
		return "neoforge";
	}

	@Override
	public String loaderVersion() {
		return version("neoforge");
	}

	@Override
	public String bridgeVersion() {
		return version(Bridge.MOD_ID);
	}

	private static String version(String id) {
		return ModList.get().getModContainerById(id).map(c -> c.getModInfo().getVersion().toString()).orElse("unknown");
	}

	@Override
	public JsonArray mods() {
		JsonArray arr = new JsonArray();
		List<IModInfo> mods = new ArrayList<>(ModList.get().getMods());
		mods.sort(Comparator.comparing(IModInfo::getModId));
		for (IModInfo m : mods) {
			JsonObject o = new JsonObject();
			o.addProperty("id", m.getModId());
			o.addProperty("version", m.getVersion().toString());
			o.addProperty("name", m.getDisplayName());
			o.addProperty("environment", "*");
			o.addProperty("nested", false);
			arr.add(o);
		}
		return arr;
	}
}
