package demo;

import net.minecraft.core.Registry;

public class ModItems {
    public static void register() {
        Registry.register("first");
    }

    public static String name() {
        return "items";
    }
}
