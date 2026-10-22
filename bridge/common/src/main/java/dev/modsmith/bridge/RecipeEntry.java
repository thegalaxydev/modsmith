package dev.modsmith.bridge;

import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.item.crafting.Recipe;

record RecipeEntry(ResourceLocation id, Recipe<?> recipe) {
}
