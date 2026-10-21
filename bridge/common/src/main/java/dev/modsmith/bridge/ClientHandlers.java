package dev.modsmith.bridge;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.NativeImage;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.client.gui.screens.PauseScreen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.Difficulty;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.GameRules;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.LevelSettings;
import net.minecraft.world.level.WorldDataConfiguration;
import net.minecraft.world.level.levelgen.WorldOptions;
import net.minecraft.world.level.levelgen.presets.WorldPresets;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.HitResult;

public final class ClientHandlers {
	private ClientHandlers() {
	}

	private record Target(HitResult hit, ResourceKey<Level> dimension, UUID viewer) {
	}

	private static Boolean savedPauseOnLostFocus;

	public static void register(Map<String, Handler> h) {
		Minecraft mc = Minecraft.getInstance();
		Bridge.localPlayer = () -> {
			var p = Minecraft.getInstance().player;
			return p == null ? null : p.getUUID();
		};
		h.put("game.shutdown", p -> {
			mc.execute(mc::stop);
			return CompletableFuture.completedFuture(new JsonObject());
		});
		h.put("client.screenshot", p -> CompletableFuture.supplyAsync(() -> {
			NativeImage image = Screenshot.takeScreenshot(mc.getMainRenderTarget());
			try {
				JsonObject o = new JsonObject();
				o.addProperty("width", image.getWidth());
				o.addProperty("height", image.getHeight());
				o.addProperty("png", Base64.getEncoder().encodeToString(image.asByteArray()));
				return (JsonElement) o;
			} catch (java.io.IOException e) {
				throw new IllegalStateException("Could not encode screenshot: " + e.getMessage());
			} finally {
				image.close();
			}
		}, mc));
		h.put("client.reload_resources", p -> CompletableFuture.supplyAsync(mc::reloadResourcePacks, mc).thenCompose(f -> f).thenApply(v -> {
			JsonObject o = new JsonObject();
			o.addProperty("reloaded", true);
			return (JsonElement) o;
		}));
		h.put("client.keep_running", p -> CompletableFuture.supplyAsync(() -> {
			boolean enabled = !p.has("enabled") || p.get("enabled").getAsBoolean();
			JsonObject o = new JsonObject();
			if (enabled) {
				if (savedPauseOnLostFocus == null) {
					savedPauseOnLostFocus = mc.options.pauseOnLostFocus;
				}
				mc.options.pauseOnLostFocus = false;
				boolean paused = mc.screen instanceof PauseScreen;
				if (paused) {
					mc.setScreen(null);
				}
				o.addProperty("unpaused", paused);
			} else if (savedPauseOnLostFocus != null) {
				mc.options.pauseOnLostFocus = savedPauseOnLostFocus;
				savedPauseOnLostFocus = null;
			}
			o.addProperty("pauseOnLostFocus", mc.options.pauseOnLostFocus);
			return (JsonElement) o;
		}, mc));
		h.put("client.status", p -> CompletableFuture.supplyAsync(() -> {
			JsonObject o = new JsonObject();
			o.addProperty("fps", mc.getFps());
			o.addProperty("loading", mc.getOverlay() != null);
			o.addProperty("screen", mc.screen == null ? "none" : mc.screen.getClass().getSimpleName());
			o.addProperty("inWorld", mc.level != null);
			o.addProperty("integratedServer", mc.getSingleplayerServer() != null);
			o.addProperty("remoteServer", mc.level != null && mc.getSingleplayerServer() == null);
			if (mc.player != null) {
				o.addProperty("player", mc.player.getName().getString());
				o.addProperty("dimension", mc.player.level().dimension().location().toString());
				JsonObject pos = new JsonObject();
				pos.addProperty("x", mc.player.getX());
				pos.addProperty("y", mc.player.getY());
				pos.addProperty("z", mc.player.getZ());
				o.add("pos", pos);
			}
			return (JsonElement) o;
		}, mc));
		h.put("world.open", p -> {
			String name = p.get("name").getAsString();
			boolean create = p.has("create") && p.get("create").getAsBoolean();
			boolean flat = !p.has("flat") || p.get("flat").getAsBoolean();
			long seed = p.has("seed") ? p.get("seed").getAsLong() : 0L;
			CompletableFuture<JsonElement> accepted = new CompletableFuture<>();
			ClientTickQueue.addWhenIdle(() -> {
				if (mc.level != null) {
					accepted.completeExceptionally(new IllegalStateException("A world is already loaded"));
					return;
				}
				JsonObject o = new JsonObject();
				o.addProperty("requested", name);
				o.addProperty("created", create);
				o.addProperty("note", "Queued until the client finishes loading resources; poll game.status until inWorld is true");
				accepted.complete(o);
				try {
					if (create) {
						LevelSettings settings = new LevelSettings(name, GameType.CREATIVE, false, Difficulty.PEACEFUL, true, new GameRules(), WorldDataConfiguration.DEFAULT);
						mc.createWorldOpenFlows().createFreshLevel(name, settings, new WorldOptions(seed, false, false), registries -> registries.registryOrThrow(Registries.WORLD_PRESET).getHolderOrThrow(flat ? WorldPresets.FLAT : WorldPresets.NORMAL).value().createWorldDimensions(), new TitleScreen());
					} else {
						mc.createWorldOpenFlows().openWorld(name, () -> mc.setScreen(new TitleScreen()));
					}
				} catch (RuntimeException e) {
					Bridge.LOGGER.error("Modsmith world.open failed", e);
					Bridge.event("world.open_failed", java.util.Map.of("name", name, "error", String.valueOf(e.getMessage())));
				}
			});
			return accepted;
		});
		h.put("world.inspect_target", p -> CompletableFuture.supplyAsync(() -> {
			if (mc.level == null || mc.player == null) {
				throw new IllegalStateException("No world is loaded");
			}
			return new Target(mc.hitResult, mc.level.dimension(), mc.player.getUUID());
		}, mc).thenCompose(t -> {
			MinecraftServer server = ServerRef.get();
			if (server != null && mc.getSingleplayerServer() == server) {
				return CompletableFuture.supplyAsync(() -> {
					ServerLevel level = server.getLevel(t.dimension());
					return (JsonElement) CommonHandlers.describeHit(t.hit(), level, "logical-server", server.getPlayerList().getPlayer(t.viewer()));
				}, server);
			}
			return CompletableFuture.supplyAsync(() -> {
				JsonObject o;
				if (t.hit() instanceof BlockHitResult bhr && t.hit().getType() == HitResult.Type.BLOCK) {
					o = CommonHandlers.describeBlock(mc.level, bhr.getBlockPos(), false);
				} else if (t.hit() instanceof EntityHitResult ehr) {
					Entity e = ehr.getEntity();
					o = CommonHandlers.describeEntity(e, false);
				} else {
					o = new JsonObject();
					o.addProperty("kind", "miss");
				}
				o.addProperty("source", "client-replica");
				o.addProperty("note", "Connected to a remote server: values come from the client's replicated world and may be incomplete. Block entity data is not available.");
				return (JsonElement) o;
			}, mc);
		}));
	}
}
