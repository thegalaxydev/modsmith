package dev.modsmith.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.datafixers.util.Pair;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import net.minecraft.commands.CommandSource;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.core.HolderSet;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceKey;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.TagKey;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.crafting.Ingredient;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

public final class CommonHandlers {
	private static final int MAX_NBT = 64 * 1024;

	private CommonHandlers() {
	}

	public static void register(Map<String, Handler> h, boolean client) {
		h.put("game.status", p -> CompletableFuture.completedFuture(status(client)));
		h.put("game.mods", p -> CompletableFuture.completedFuture(mods()));
		h.put("game.telemetry", p -> telemetry());
		h.put("game.wait_ticks", p -> {
			requireServer();
			long n = Math.max(1, p.has("ticks") ? p.get("ticks").getAsLong() : 1);
			return ServerRef.waitTicks(n).thenApply(t -> {
				JsonObject o = new JsonObject();
				o.addProperty("tick", t);
				return o;
			});
		});
		h.put("registry.search", CommonHandlers::registrySearch);
		h.put("world.give_item", CommonHandlers::giveItem);
		h.put("world.run_command", p -> runCommand(p.get("command").getAsString()));
		h.put("world.reload_datapacks", p -> runCommand("reload"));
		h.put("world.block_at", p -> {
			MinecraftServer server = requireServer();
			BlockPos pos = new BlockPos(p.get("x").getAsInt(), p.get("y").getAsInt(), p.get("z").getAsInt());
			return CompletableFuture.supplyAsync(() -> describeBlock(levelFor(server, p), pos, true), server);
		});
		h.put("world.entities", CommonHandlers::entities);
		h.put("world.recipes", CommonHandlers::recipes);
		h.put("world.tags", CommonHandlers::tags);
		h.put("world.save", p -> {
			MinecraftServer server = requireServer();
			return CompletableFuture.supplyAsync(() -> {
				boolean ok = server.saveEverything(true, true, true);
				JsonObject o = new JsonObject();
				o.addProperty("saved", ok);
				return o;
			}, server);
		});
		h.put("player.inventory", p -> {
			MinecraftServer server = requireServer();
			return CompletableFuture.supplyAsync(() -> {
				ServerPlayer player = player(server, p);
				JsonArray items = new JsonArray();
				for (int i = 0; i < player.getInventory().getContainerSize(); i++) {
					ItemStack s = player.getInventory().getItem(i);
					if (s.isEmpty()) {
						continue;
					}
					JsonObject o = new JsonObject();
					o.addProperty("slot", i);
					o.addProperty("item", BuiltInRegistries.ITEM.getKey(s.getItem()).toString());
					o.addProperty("count", s.getCount());
					items.add(o);
				}
				JsonObject out = new JsonObject();
				out.addProperty("player", player.getName().getString());
				out.add("items", items);
				return out;
			}, server);
		});
		if (!client) {
			h.put("world.inspect_target", p -> {
				MinecraftServer server = requireServer();
				return CompletableFuture.supplyAsync(() -> {
					ServerPlayer player = player(server, p);
					HitResult hit = player.pick(20.0, 1.0f, false);
					return describeHit(hit, player.serverLevel(), "logical-server", player);
				}, server);
			});
			h.put("game.shutdown", p -> {
				MinecraftServer server = requireServer();
				server.execute(() -> server.halt(false));
				return CompletableFuture.completedFuture(new JsonObject());
			});
		}
	}

	public static MinecraftServer requireServer() {
		MinecraftServer server = ServerRef.get();
		if (server == null) {
			throw new IllegalStateException(Bridge.platform().isClient() ? "No local world is loaded. Remote multiplayer servers cannot be inspected or modified through the bridge." : "The server is not running yet");
		}
		return server;
	}

	static ServerLevel levelFor(MinecraftServer server, JsonObject p) {
		if (p.has("dimension")) {
			ServerLevel l = server.getLevel(ResourceKey.create(net.minecraft.core.registries.Registries.DIMENSION, Compat.id(p.get("dimension").getAsString())));
			if (l == null) {
				throw new IllegalArgumentException("Unknown dimension " + p.get("dimension").getAsString());
			}
			return l;
		}
		UUID local = Bridge.localPlayer.get();
		if (local != null) {
			ServerPlayer sp = server.getPlayerList().getPlayer(local);
			if (sp != null) {
				return sp.serverLevel();
			}
		}
		return server.overworld();
	}

	static ServerPlayer player(MinecraftServer server, JsonObject p) {
		if (p.has("player") && !p.get("player").isJsonNull() && !p.get("player").getAsString().isEmpty()) {
			ServerPlayer sp = server.getPlayerList().getPlayerByName(p.get("player").getAsString());
			if (sp == null) {
				throw new IllegalArgumentException("Player not found: " + p.get("player").getAsString());
			}
			return sp;
		}
		UUID local = Bridge.localPlayer.get();
		if (local != null) {
			ServerPlayer sp = server.getPlayerList().getPlayer(local);
			if (sp != null) {
				return sp;
			}
		}
		List<ServerPlayer> players = server.getPlayerList().getPlayers();
		if (players.isEmpty()) {
			throw new IllegalStateException("No player is in the world");
		}
		return players.get(0);
	}

	private static JsonObject status(boolean client) {
		JsonObject o = new JsonObject();
		o.addProperty("side", client ? "client" : "server");
		MinecraftServer server = ServerRef.get();
		o.addProperty("serverRunning", server != null);
		o.addProperty("worldLoaded", server != null && server.overworld() != null && (!client || Bridge.localPlayer.get() != null));
		o.addProperty("ticks", ServerRef.ticks());
		if (server != null) {
			o.addProperty("players", server.getPlayerCount());
			o.addProperty("dedicated", server.isDedicatedServer());
		}
		return o;
	}

	private static JsonArray mods() {
		return Bridge.platform().mods();
	}

	private static CompletableFuture<JsonElement> telemetry() {
		JsonObject o = new JsonObject();
		Runtime rt = Runtime.getRuntime();
		JsonObject mem = new JsonObject();
		mem.addProperty("usedMb", (rt.totalMemory() - rt.freeMemory()) / 1048576);
		mem.addProperty("totalMb", rt.totalMemory() / 1048576);
		mem.addProperty("maxMb", rt.maxMemory() / 1048576);
		o.add("memory", mem);
		MinecraftServer server = ServerRef.get();
		if (server == null) {
			return CompletableFuture.completedFuture(o);
		}
		return CompletableFuture.supplyAsync(() -> {
			float mspt = Compat.averageTickTime(server);
			o.addProperty("mspt", mspt);
			o.addProperty("tps", Math.min(20.0, mspt <= 0 ? 20.0 : 1000.0 / mspt));
			o.addProperty("ticks", ServerRef.ticks());
			o.addProperty("players", server.getPlayerCount());
			int entities = 0;
			for (ServerLevel level : server.getAllLevels()) {
				for (Entity ignored : level.getAllEntities()) {
					entities++;
				}
			}
			o.addProperty("entities", entities);
			return o;
		}, server);
	}

	@SuppressWarnings({"unchecked", "rawtypes"})
	static Registry<Object> findRegistry(String name) {
		ResourceLocation id = Compat.id(name.contains(":") ? name : "minecraft:" + name);
		Registry<?> builtin = BuiltInRegistries.REGISTRY.get(id);
		if (builtin != null) {
			return (Registry<Object>) builtin;
		}
		MinecraftServer server = ServerRef.get();
		if (server != null) {
			Optional<? extends Registry<Object>> dyn = server.registryAccess().registry((ResourceKey) ResourceKey.createRegistryKey(id));
			if (dyn.isPresent()) {
				return dyn.get();
			}
		}
		throw new IllegalArgumentException("Unknown registry " + id + (server == null ? " (dynamic registries need a loaded world)" : ""));
	}

	private static CompletableFuture<JsonElement> registrySearch(JsonObject p) {
		String name = p.has("registry") ? p.get("registry").getAsString() : "item";
		String query = p.has("query") ? p.get("query").getAsString().toLowerCase(Locale.ROOT) : "";
		int limit = p.has("limit") ? Math.min(2000, p.get("limit").getAsInt()) : 100;
		Registry<Object> reg = findRegistry(name);
		List<ResourceLocation> keys = new ArrayList<>();
		for (ResourceLocation k : reg.keySet()) {
			if (query.isEmpty() || k.toString().contains(query)) {
				keys.add(k);
			}
		}
		keys.sort(Comparator.comparing(ResourceLocation::toString));
		JsonArray entries = new JsonArray();
		for (ResourceLocation k : keys.subList(0, Math.min(limit, keys.size()))) {
			JsonObject e = new JsonObject();
			e.addProperty("id", k.toString());
			Object v = reg.get(k);
			if (v instanceof Item item) {
				e.addProperty("name", item.getDescription().getString());
			} else if (v instanceof net.minecraft.world.level.block.Block block) {
				e.addProperty("name", block.getName().getString());
			}
			entries.add(e);
		}
		JsonObject out = new JsonObject();
		out.addProperty("registry", reg.key().location().toString());
		out.addProperty("total", reg.keySet().size());
		out.addProperty("matched", keys.size());
		out.add("entries", entries);
		return CompletableFuture.completedFuture(out);
	}

	private static CompletableFuture<JsonElement> giveItem(JsonObject p) {
		MinecraftServer server = requireServer();
		String itemId = p.get("item").getAsString();
		int count = p.has("count") ? p.get("count").getAsInt() : 1;
		Item item = BuiltInRegistries.ITEM.getOptional(Compat.id(itemId)).orElseThrow(() -> new IllegalArgumentException("Unknown item " + itemId));
		return CompletableFuture.supplyAsync(() -> {
			ServerPlayer player = player(server, p);
			int remaining = count;
			int dropped = 0;
			while (remaining > 0) {
				int n = Math.min(remaining, Compat.maxStackSize(item));
				ItemStack stack = new ItemStack(item, n);
				if (!player.getInventory().add(stack) && !stack.isEmpty()) {
					dropped += stack.getCount();
					player.drop(stack, false);
				}
				remaining -= n;
			}
			player.containerMenu.broadcastChanges();
			JsonObject o = new JsonObject();
			o.addProperty("player", player.getName().getString());
			o.addProperty("item", itemId);
			o.addProperty("count", count);
			o.addProperty("dropped", dropped);
			return o;
		}, server);
	}

	public static CompletableFuture<JsonElement> runCommand(String command) {
		MinecraftServer server = requireServer();
		String cmd = command.startsWith("/") ? command.substring(1) : command;
		return CompletableFuture.supplyAsync(() -> {
			List<String> output = new ArrayList<>();
			int[] result = {0};
			boolean[] success = {false};
			CommandSource capture = new CommandSource() {
				@Override
				public void sendSystemMessage(Component message) {
					output.add(message.getString());
				}

				@Override
				public boolean acceptsSuccess() {
					return true;
				}

				@Override
				public boolean acceptsFailure() {
					return true;
				}

				@Override
				public boolean shouldInformAdmins() {
					return false;
				}
			};
			CommandSourceStack base = server.createCommandSourceStack();
			UUID local = Bridge.localPlayer.get();
			ServerPlayer sp = local == null ? null : server.getPlayerList().getPlayer(local);
			if (sp != null) {
				base = sp.createCommandSourceStack().withPermission(4);
			}
			CommandSourceStack stack = Compat.withCallback(base.withSource(capture), (ok, r) -> {
				success[0] = ok;
				result[0] = r;
			});
			server.getCommands().performPrefixedCommand(stack, cmd);
			JsonObject o = new JsonObject();
			o.addProperty("command", cmd);
			o.addProperty("success", success[0]);
			o.addProperty("result", result[0]);
			o.addProperty("executor", sp != null ? sp.getName().getString() : "server");
			JsonArray out = new JsonArray();
			output.forEach(out::add);
			o.add("output", out);
			return o;
		}, server);
	}

	@SuppressWarnings({"unchecked", "rawtypes"})
	public static JsonObject describeBlock(Level level, BlockPos pos, boolean includeEntity) {
		BlockState state = level.getBlockState(pos);
		JsonObject o = new JsonObject();
		o.addProperty("kind", "block");
		o.addProperty("block", BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());
		o.add("pos", posJson(pos));
		o.addProperty("dimension", level.dimension().location().toString());
		JsonObject props = new JsonObject();
		for (Map.Entry<Property<?>, Comparable<?>> e : state.getValues().entrySet()) {
			Property prop = e.getKey();
			props.addProperty(prop.getName(), prop.getName((Comparable) e.getValue()));
		}
		o.add("properties", props);
		JsonArray tags = new JsonArray();
		state.getTags().map(t -> t.location().toString()).sorted().forEach(tags::add);
		o.add("tags", tags);
		o.addProperty("lightLevel", level.getMaxLocalRawBrightness(pos));
		level.getBiome(pos).unwrapKey().ifPresent(k -> o.addProperty("biome", k.location().toString()));
		if (includeEntity) {
			BlockEntity be = level.getBlockEntity(pos);
			if (be != null) {
				JsonObject b = new JsonObject();
				b.addProperty("type", String.valueOf(BuiltInRegistries.BLOCK_ENTITY_TYPE.getKey(be.getType())));
				CompoundTag tag = Compat.saveBlockEntity(be, level);
				String snbt = tag.toString();
				b.addProperty("nbt", snbt.length() > MAX_NBT ? snbt.substring(0, MAX_NBT) + "...(truncated)" : snbt);
				o.add("blockEntity", b);
			}
		}
		return o;
	}

	public static JsonObject describeEntity(Entity entity, boolean includeNbt) {
		JsonObject o = new JsonObject();
		o.addProperty("kind", "entity");
		o.addProperty("type", BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString());
		o.addProperty("uuid", entity.getUUID().toString());
		o.addProperty("name", entity.getName().getString());
		Vec3 pos = entity.position();
		JsonObject p = new JsonObject();
		p.addProperty("x", pos.x);
		p.addProperty("y", pos.y);
		p.addProperty("z", pos.z);
		o.add("pos", p);
		o.addProperty("dimension", entity.level().dimension().location().toString());
		if (entity instanceof LivingEntity living) {
			o.addProperty("health", living.getHealth());
			o.addProperty("maxHealth", living.getMaxHealth());
		}
		if (includeNbt) {
			String snbt = entity.saveWithoutId(new CompoundTag()).toString();
			o.addProperty("nbt", snbt.length() > MAX_NBT ? snbt.substring(0, MAX_NBT) + "...(truncated)" : snbt);
		}
		return o;
	}

	public static JsonObject describeHit(HitResult hit, ServerLevel level, String source, Entity viewer) {
		JsonObject o;
		if (hit instanceof BlockHitResult bhr && hit.getType() == HitResult.Type.BLOCK) {
			o = describeBlock(level, bhr.getBlockPos(), true);
			o.addProperty("face", bhr.getDirection().getName());
		} else if (hit instanceof EntityHitResult ehr) {
			Entity e = level.getEntity(ehr.getEntity().getUUID());
			o = describeEntity(e != null ? e : ehr.getEntity(), e != null);
		} else {
			o = new JsonObject();
			o.addProperty("kind", "miss");
		}
		o.addProperty("source", source);
		if (viewer != null) {
			o.addProperty("viewer", viewer.getName().getString());
		}
		return o;
	}

	private static JsonObject posJson(BlockPos pos) {
		JsonObject p = new JsonObject();
		p.addProperty("x", pos.getX());
		p.addProperty("y", pos.getY());
		p.addProperty("z", pos.getZ());
		return p;
	}

	private static CompletableFuture<JsonElement> entities(JsonObject p) {
		MinecraftServer server = requireServer();
		double radius = p.has("radius") ? p.get("radius").getAsDouble() : 32;
		int limit = p.has("limit") ? p.get("limit").getAsInt() : 100;
		return CompletableFuture.supplyAsync(() -> {
			ServerPlayer player = player(server, p);
			AABB box = player.getBoundingBox().inflate(radius);
			List<Entity> list = player.serverLevel().getEntities((Entity) null, box, e -> e != player);
			list.sort(Comparator.comparingDouble(e -> e.distanceToSqr(player)));
			JsonArray arr = new JsonArray();
			for (Entity e : list.subList(0, Math.min(limit, list.size()))) {
				JsonObject o = describeEntity(e, false);
				o.addProperty("distance", Math.sqrt(e.distanceToSqr(player)));
				arr.add(o);
			}
			JsonObject out = new JsonObject();
			out.addProperty("total", list.size());
			out.add("entities", arr);
			return out;
		}, server);
	}

	private static CompletableFuture<JsonElement> recipes(JsonObject p) {
		MinecraftServer server = requireServer();
		String query = p.has("query") ? p.get("query").getAsString().toLowerCase(Locale.ROOT) : "";
		int limit = p.has("limit") ? p.get("limit").getAsInt() : 100;
		return CompletableFuture.supplyAsync(() -> {
			JsonArray arr = new JsonArray();
			int matched = 0;
			List<RecipeEntry> all = Compat.recipes(server);
			all.sort(Comparator.comparing(r -> r.id().toString()));
			for (RecipeEntry holder : all) {
				ItemStack result = holder.recipe().getResultItem(server.registryAccess());
				String resultId = result.isEmpty() ? "" : BuiltInRegistries.ITEM.getKey(result.getItem()).toString();
				if (!query.isEmpty() && !holder.id().toString().contains(query) && !resultId.contains(query)) {
					continue;
				}
				matched++;
				if (arr.size() >= limit) {
					continue;
				}
				JsonObject o = new JsonObject();
				o.addProperty("id", holder.id().toString());
				o.addProperty("type", String.valueOf(BuiltInRegistries.RECIPE_TYPE.getKey(holder.recipe().getType())));
				o.addProperty("result", resultId);
				o.addProperty("count", result.getCount());
				JsonArray ingredients = new JsonArray();
				for (Ingredient ing : holder.recipe().getIngredients()) {
					JsonArray options = new JsonArray();
					ItemStack[] items = ing.getItems();
					for (int i = 0; i < Math.min(8, items.length); i++) {
						options.add(BuiltInRegistries.ITEM.getKey(items[i].getItem()).toString());
					}
					ingredients.add(options);
				}
				o.add("ingredients", ingredients);
				arr.add(o);
			}
			JsonObject out = new JsonObject();
			out.addProperty("matched", matched);
			out.add("recipes", arr);
			return out;
		}, server);
	}

	@SuppressWarnings({"unchecked", "rawtypes"})
	private static CompletableFuture<JsonElement> tags(JsonObject p) {
		MinecraftServer server = requireServer();
		String name = p.has("registry") ? p.get("registry").getAsString() : "item";
		String query = p.has("query") ? p.get("query").getAsString().toLowerCase(Locale.ROOT) : "";
		int limit = p.has("limit") ? p.get("limit").getAsInt() : 100;
		return CompletableFuture.supplyAsync(() -> {
			ResourceLocation id = Compat.id(name.contains(":") ? name : "minecraft:" + name);
			Optional<Registry<Object>> found = (Optional<Registry<Object>>) (Optional) server.registryAccess().registry((ResourceKey) ResourceKey.createRegistryKey(id));
			if (found.isEmpty()) {
				throw new IllegalArgumentException("Unknown registry " + id);
			}
			Registry<Object> reg = found.get();
			List<Pair<TagKey<Object>, HolderSet.Named<Object>>> list = new ArrayList<>(reg.getTags().filter(t -> query.isEmpty() || t.getFirst().location().toString().contains(query)).toList());
			list.sort(Comparator.comparing(t -> t.getFirst().location().toString()));
			JsonArray arr = new JsonArray();
			for (Pair<TagKey<Object>, HolderSet.Named<Object>> t : list.subList(0, Math.min(limit, list.size()))) {
				JsonObject o = new JsonObject();
				o.addProperty("tag", t.getFirst().location().toString());
				o.addProperty("size", t.getSecond().size());
				JsonArray members = new JsonArray();
				int n = 0;
				for (Holder<Object> holder : t.getSecond()) {
					if (n++ >= 64) {
						break;
					}
					holder.unwrapKey().ifPresent(k -> members.add(k.location().toString()));
				}
				o.add("members", members);
				arr.add(o);
			}
			JsonObject out = new JsonObject();
			out.addProperty("registry", id.toString());
			out.addProperty("matched", list.size());
			out.add("tags", arr);
			return out;
		}, server);
	}
}
