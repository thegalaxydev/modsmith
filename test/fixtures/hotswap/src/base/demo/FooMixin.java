package demo;

import org.spongepowered.asm.mixin.Mixin;

@Mixin(Foo.class)
public class FooMixin {
    public int extra() {
        return 1;
    }
}
