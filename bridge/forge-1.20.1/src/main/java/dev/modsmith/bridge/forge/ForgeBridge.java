package dev.modsmith.bridge.forge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.modsmith.bridge.Bridge;
import dev.modsmith.bridge.BridgePlatform;
import dev.modsmith.bridge.ServerRef;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.event.server.ServerStartedEvent;
import net.minecraftforge.event.server.ServerStoppedEvent;
import net.minecraftforge.fml.ModList;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.loading.FMLEnvironment;
import net.minecraftforge.forgespi.language.IModInfo;

@Mod(Bridge.MOD_ID)
public class ForgeBridge implements BridgePlatform {
	public ForgeBridge() {
		if (!Bridge.start(this)) {
			return;
		}
		MinecraftForge.EVENT_BUS.addListener(ForgeBridge::onServerStarted);
		MinecraftForge.EVENT_BUS.addListener(ForgeBridge::onServerStopped);
		MinecraftForge.EVENT_BUS.addListener(ForgeBridge::onServerTick);
		if (isClient()) {
			try {
				Class.forName("dev.modsmith.bridge.forge.ForgeClientHooks").getMethod("register").invoke(null);
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

	private static void onServerTick(TickEvent.ServerTickEvent event) {
		if (event.phase == TickEvent.Phase.END) {
			ServerRef.tick();
		}
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
		return "forge";
	}

	@Override
	public String loaderVersion() {
		return version("forge");
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
