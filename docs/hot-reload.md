# Java hot reload

**Apply changes** can replace Java method bodies in a running development client or server without a restart. It works for Fabric (Loom) and NeoForge (ModDevGradle) development runs.

## Turning it on

Hot reload uses the JVM's debug port (JDWP). A profile's **Hot reload and debugger** switch (`profile.debug.enabled`) opens it. If a development run without the port has code changes, the Code row in Apply changes offers **Turn on and restart**. That does three things:

1. Checks the profile's port (`instance.debug_port_check`).
2. Asks before using another port if that one is busy.
3. Saves the setting and restarts the run.

When a run with the debug port starts, the service records the project's compiled classes (the `classes` folders of the run's classpath) under `.modsmith/hotswap/<profile>-<side>/`. That copy is what the game loaded, and later changes are compared against it.

## What Apply does

The popover lists Code (changed Java source files since launch), Assets and Game data, each with a checkbox, and one **Apply** button. For code, `instance.hotswap` runs as a task:

1. **Compile.** Gradle runs `classes` (and `<sourceSet>Classes` for other source sets on the classpath, such as Loom's `client`). A compile error fails the task and goes to Problems; nothing is applied.
2. **Compare.** Each changed class file is parsed and compared with the recorded copy. Method bodies are compared with constant-pool references resolved, so an unrelated constant shifting does not count as a change.
3. **Decide.** If any class has a change the JVM cannot apply, nothing is sent to the game. The task result lists every reason, and Modsmith offers a restart.
4. **Redefine.** Otherwise Modsmith connects to the debug port and sends every changed, already loaded class in one `RedefineClasses` command, which the JVM applies all-or-nothing. Then it disconnects. Classes the game has not loaded yet, and new classes, load the new version from disk when first used.

The Tasks panel shows the result per class: Updated (with the changed methods), Loads when used, New class, Needs restart (with reasons) or Rejected.

## Changes that need a restart

| Change | Why |
| --- | --- |
| Field added, removed or with different modifiers | The JVM cannot change an object's layout |
| Method added, removed, renamed or with a different signature or modifiers | Standard HotSwap only replaces bodies of existing methods |
| Superclass, interfaces or class modifiers changed | The class hierarchy is fixed once loaded |
| Nested, permitted or record classes changed | Since Java 11 these class attributes cannot change |
| Static initializer added or changed | It already ran when the class loaded and would not run again |
| Mixin classes (`@Mixin`) | Mixins are applied to their targets when the game starts |
| A changed method that calls `Registry.register`, `DeferredRegister.register…` and similar | Registration only runs at startup |
| Class removed | The running game still has the old class |

If the JVM itself rejects a change the classifier allowed (for example a class that another mod transforms when loading), the task reports the JVM's reason and nothing is applied.

## Limits

- Only one debugger can use the port at a time. While an IDE debugger is attached, hot reload reports that the port did not answer.
- Release runs use the built JAR, so they need a rebuild and restart.
- Changed resources are not hot-reloaded by the code step. Choose Assets or Game data in the same popover.

## Verification

- The classifier is tested with class files compiled from small Java variants (`test/fixtures/hotswap`, regenerated with `node scripts/hotswap-fixtures.mjs <javac>`), in TypeScript and Rust.
- Both JDWP clients are tested against a real JVM on every installed Java 17, 21 and 25. The tests redefine a method, check that a batch containing a field change is rejected as a whole while the old code keeps running, and re-attach after detaching.
- In the app (Rust service), on the NeoForge 1.21.1 and Fabric 1.21.1 test projects running dedicated development servers:
  - A changed `String probe()` body logged the new value within two seconds, without a restart.
  - Adding a field asked for a restart and left the running code unchanged.
  - **Turn on and restart** asked before switching from a busy port 5005 to 5006.
