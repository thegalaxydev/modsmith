package demo;

public class Loop {
    public static void main(String[] args) throws Exception {
        Foo foo = new Foo();
        while (true) {
            System.out.println("value " + foo.value());
            Thread.sleep(50);
        }
    }
}
