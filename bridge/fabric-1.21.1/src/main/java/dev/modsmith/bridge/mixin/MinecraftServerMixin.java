package dev.modsmith.bridge.mixin;

import dev.modsmith.bridge.ServerRef;
import java.util.function.BooleanSupplier;
import net.minecraft.server.MinecraftServer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(MinecraftServer.class)
public abstract class MinecraftServerMixin {
	@Inject(method = "runServer", at = @At("HEAD"))
	private void modsmith$start(CallbackInfo ci) {
		ServerRef.started((MinecraftServer) (Object) this);
	}

	@Inject(method = "tickServer", at = @At("TAIL"))
	private void modsmith$tick(BooleanSupplier hasTimeLeft, CallbackInfo ci) {
		ServerRef.tick();
	}

	@Inject(method = "stopServer", at = @At("TAIL"))
	private void modsmith$stop(CallbackInfo ci) {
		ServerRef.stopped((MinecraftServer) (Object) this);
	}
}
