package demo;

import java.util.function.Supplier;

public class Foo extends Base implements Runnable {
    static int COUNT = 1;
    private int value = 2;

    public int value() {
        return value + 1;
    }

    public void run() {
        Supplier<String> s = () -> "a";
        s.get();
    }

    private int helper() {
        return COUNT;
    }
}
