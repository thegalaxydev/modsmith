# Java

Modsmith needs two kinds of Java, both chosen per catalog entry in `resources/catalog/compatibility.json`:

- `gradleJavaMin`: the JDK that runs Gradle. Every Fabric entry needs JDK 25, because Loom 1.18 refuses older Gradle JVMs.
- `runtimeJavaMin`: the Java that runs Minecraft. It is 8, 16, 17, 21 or 25 depending on the Minecraft version. A profile can raise it with `java.minMajor` or pin a home with `java.home`.

## Detection

`java.list` probes `JAVA_HOME`, every `java` on `PATH`, the usual vendor folders (`%ProgramFiles%\Java`, `Eclipse Adoptium`, `Microsoft`, `Zulu` and others on Windows, `/Library/Java/JavaVirtualMachines` on macOS, `/usr/lib/jvm` on Linux), `~/.jdks`, `~/.gradle/jdks`, homes added with `java.add`, and `<data dir>/jdks`, where Modsmith puts the Java it downloads. Each candidate is run once with `-XshowSettings:properties -version`, and the list is cached for six hours (`refresh: true` rescans).

When a build or launch needs Java N, Modsmith picks the lowest installed 64-bit Java at or above N (a JDK for Gradle).

## Downloading Eclipse Temurin

`java.install { major, imageType }` downloads Eclipse Temurin from the Adoptium API. `imageType` is `jdk` (the default) or `jre`. It is a long-running operation whose result is the installed Java, in the same shape `java.list` returns.

1. `GET /v3/assets/latest/<major>/hotspot?architecture=<arch>&image_type=<jdk|jre>&os=<os>&vendor=eclipse` gives the package name, size and SHA-256 checksum. `os` is `windows`, `mac` or `linux`; `arch` is `x64` or `aarch64` (or `x32`, `arm`, `ppc64le`).
2. `GET /v3/binary/latest/<major>/ga/<os>/<arch>/<jdk|jre>/hotspot/normal/eclipse` redirects to the archive. It is downloaded to `<cache dir>/downloads/temurin/`, with progress reported on the operation. The download must match the published size and SHA-256, or it is discarded and retried, up to three times.
3. The archive (`.zip` on Windows, `.tar.gz` elsewhere) is unpacked into a temporary folder under `<data dir>/jdks/`. Entries that would escape that folder, including symbolic links, are refused. The single top-level folder (for example `jdk-25.0.1+8` or `jdk-21.0.5+11-jre`) is then moved into place, replacing an older copy with the same name. On macOS the Java home is `Contents/Home` inside it.
4. The archive is deleted, Java detection is refreshed, and the operation fails if the new runtime does not start.

`MODSMITH_ADOPTIUM_API` overrides the API base URL (default `https://api.adoptium.net/v3`). The tests point it at `test/fakeapi.ts`, which serves generated archives containing a stub `java` executable.

## Finding out what is missing

`java.requirements` reports which Java an action needs and whether it is installed:

- `{ catalogEntryId }`: creating a project from that entry (the Gradle JDK).
- `{ path }`: building the workspace (the Gradle JDK).
- `{ path, profile, mode? }`: launching the profile. This is the runtime Java, plus the Gradle JDK when the workspace is a Gradle project or the launch is a development launch.

The result has `requirements` (`purpose`, `major`, `jdk`, and the `java` that would be used, or `null`) and `install`: the `java.install` calls that would satisfy the missing ones, one per major version.

## In the app

- The home screen shows a short getting-started checklist: whether the JDK for new Fabric projects is installed (with a download button), an optional CurseForge API key, and creating, opening or importing a project. It can be dismissed, which is remembered on that computer.
- Before building, running data generation, launching a profile or creating a project, the app calls `java.requirements`. If something is missing, it lists the downloads and asks before running `java.install`.
- The New project wizard and Settings > Java also have download buttons.

## MCP and CLI

The MCP tools are `java_install` and `java_requirements`. When no suitable Java is installed, `project_create`, `project_build` and `instance_launch` fail with a message that names the call to make, for example:

```
No JDK 25+ found. Loom 1.18-SNAPSHOT requires Gradle to run on Java 25 or newer. Download Eclipse Temurin 25 with java_install {"major":25}, or install a JDK 25 and refresh Java detection.
```

From the command line:

```bash
modsmith java install 25
```

```bash
modsmith java install 21 --jre
```
