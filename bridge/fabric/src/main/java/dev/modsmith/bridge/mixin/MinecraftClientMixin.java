package dev.modsmith.bridge.mixin;

import dev.modsmith.bridge.ClientTickQueue;
import net.minecraft.client.Minecraft;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Minecraft.class)
public abstract class MinecraftClientMixin {
	@Inject(method = "tick", at = @At("HEAD"))
	private void modsmith$tick(CallbackInfo ci) {
		ClientTickQueue.drain();
	}
}
