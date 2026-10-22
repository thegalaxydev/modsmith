package dev.modsmith.bridge;

import java.util.ArrayList;
import java.util.List;
import java.util.function.BiConsumer;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.core.registries.Registries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.crafting.Recipe;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.LevelSettings;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.levelgen.WorldOptions;
import net.minecraft.world.level.levelgen.presets.WorldPresets;

final class Compat {
	private Compat() {
	}

	@SuppressWarnings("removal")
	static ResourceLocation id(String id) {
		return new ResourceLocation(id);
	}

	static CompoundTag saveBlockEntity(BlockEntity be, Level level) {
		return be.saveWithFullMetadata();
	}

	static int maxStackSize(Item item) {
		return item.getMaxStackSize();
	}

	static List<RecipeEntry> recipes(MinecraftServer server) {
		List<RecipeEntry> out = new ArrayList<>();
		for (Recipe<?> recipe : server.getRecipeManager().getRecipes()) {
			out.add(new RecipeEntry(recipe.getId(), recipe));
		}
		return out;
	}

	static void createFreshLevel(Minecraft mc, String name, LevelSettings settings, WorldOptions options, boolean flat) {
		mc.createWorldOpenFlows().createFreshLevel(name, settings, options, registries -> registries.registryOrThrow(Registries.WORLD_PRESET).getHolderOrThrow(flat ? WorldPresets.FLAT : WorldPresets.NORMAL).value().createWorldDimensions());
	}

	static void openWorld(Minecraft mc, String name) {
		mc.createWorldOpenFlows().loadLevel(new TitleScreen(), name);
	}

	static float averageTickTime(MinecraftServer server) {
		return server.getAverageTickTime();
	}

	static CommandSourceStack withCallback(CommandSourceStack stack, BiConsumer<Boolean, Integer> callback) {
		return stack.withCallback((context, ok, r) -> callback.accept(ok, r));
	}
}
