package dev.modsmith.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.loader.api.FabricLoader;
import net.fabricmc.loader.api.ModContainer;

public class BridgeMod implements ModInitializer, BridgePlatform {
	@Override
	public void onInitialize() {
		Bridge.start(this);
	}

	@Override
	public boolean isClient() {
		return FabricLoader.getInstance().getEnvironmentType() == EnvType.CLIENT;
	}

	@Override
	public boolean isDevelopment() {
		return FabricLoader.getInstance().isDevelopmentEnvironment();
	}

	@Override
	public String loaderName() {
		return "fabric";
	}

	@Override
	public String loaderVersion() {
		return version("fabricloader");
	}

	@Override
	public String bridgeVersion() {
		return version(Bridge.MOD_ID);
	}

	private static String version(String id) {
		return FabricLoader.getInstance().getModContainer(id).map(m -> m.getMetadata().getVersion().getFriendlyString()).orElse("unknown");
	}

	@Override
	public JsonArray mods() {
		JsonArray arr = new JsonArray();
		List<ModContainer> mods = new ArrayList<>(FabricLoader.getInstance().getAllMods());
		mods.sort(Comparator.comparing(m -> m.getMetadata().getId()));
		for (ModContainer m : mods) {
			JsonObject o = new JsonObject();
			o.addProperty("id", m.getMetadata().getId());
			o.addProperty("version", m.getMetadata().getVersion().getFriendlyString());
			o.addProperty("name", m.getMetadata().getName());
			o.addProperty("environment", m.getMetadata().getEnvironment().name().toLowerCase(Locale.ROOT));
			o.addProperty("nested", m.getContainingMod().isPresent());
			arr.add(o);
		}
		return arr;
	}
}
