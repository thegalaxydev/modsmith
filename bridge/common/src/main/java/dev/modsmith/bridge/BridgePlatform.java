package dev.modsmith.bridge;

import com.google.gson.JsonArray;

public interface BridgePlatform {
	boolean isClient();

	boolean isDevelopment();

	String loaderName();

	String loaderVersion();

	String bridgeVersion();

	JsonArray mods();
}
