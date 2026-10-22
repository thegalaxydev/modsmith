# Linux

Modsmith builds and runs on Linux with the same Tauri shell and Rust service as on Windows. This page covers what differs.

Status: built and tested on Ubuntu 26.04 under WSL2 (WSLg, which runs X11 apps through XWayland). Not yet tried on a native GNOME or KDE desktop. See "Verification" below.

## Installing

Each release has an AppImage and a `.deb` (see the [download page](https://thegalaxydev.github.io/modsmith/download/)). On distributions that use APT, the Modsmith APT repository is the better choice once it is published: Modsmith then updates through the software center or `apt`, and software centers such as KDE Discover show its name, developer, icon, license and description. When a `.deb` is opened as a file, Discover shows a name made from the file name, a generic icon and an unknown author and license; those come from Discover and PackageKit, not from the package.

```bash
sudo install -d -m 0755 /etc/apt/keyrings
wget -qO- https://thegalaxydev.github.io/modsmith/apt/modsmith-archive-keyring.gpg | sudo tee /etc/apt/keyrings/modsmith.gpg > /dev/null
wget -qO- https://thegalaxydev.github.io/modsmith/apt/modsmith.sources | sudo tee /etc/apt/sources.list.d/modsmith.sources > /dev/null
sudo apt update
sudo apt install modsmith
```

Check the key with `gpg --show-keys /etc/apt/keyrings/modsmith.gpg` against the fingerprint on the download page. The repository keeps the three newest releases. To remove it, delete `/etc/apt/sources.list.d/modsmith.sources` and `/etc/apt/keyrings/modsmith.gpg`.

## Build dependencies

Debian and Ubuntu (other distributions have equivalent packages):

```bash
sudo apt install build-essential pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libssl-dev libdbus-1-dev
```

Then, from the repository root:

```bash
npm install
```

```bash
npm run tauri:build
```

On Linux this produces a `.deb` and an AppImage under `target/release/bundle/` (configured in `src-tauri/tauri.linux.conf.json`). `npm start` runs the development build.

At runtime Modsmith needs WebKitGTK 4.1, a Secret Service provider (GNOME Keyring or KWallet) to remember a CurseForge API key, and Java for Gradle and Minecraft, the same versions as on Windows.

## The docked game window

The Minecraft tab embeds the game window on X11. `crates/x11win` finds the GLFW window by its `_NET_WM_PID`, creates a host window inside the Modsmith window over the tab, withdraws the game window from the window manager and reparents it into the host. Clicking the game gives it keyboard focus and clicking anywhere else in Modsmith takes focus back; this uses a passive button grab on the Modsmith window, the same click-to-focus technique window managers use. Stopping a docked client asks it to close through `WM_DELETE_WINDOW` before falling back to killing the process group.

Closing Modsmith, or ending it with `SIGTERM`, `SIGINT` or `SIGHUP`, first hands a docked game back to the desktop as a normal window. If Modsmith is killed outright (`kill -9`) or crashes while the game is docked, the X server destroys Modsmith's window together with the game window inside it and Minecraft exits. The same happens on Windows, because a destroyed window takes the windows it owns with it.

Wayland does not let one application place another application's window inside its own, so embedding needs X11:

- On a Wayland session Modsmith starts itself through XWayland (`GDK_BACKEND=x11`) and launches Minecraft without `WAYLAND_DISPLAY`, so GLFW also uses XWayland. Both then share one X server and docking works as on X11. XWayland windows can look slightly soft with fractional scaling.
- Settings, Interface, "Use native Wayland" (or `MODSMITH_NATIVE_WAYLAND=1`) runs Modsmith as a native Wayland app instead. The game then opens in its own window, as it already does when docking is unavailable. The choice is stored in `shell.json` in the data folder and applies after a restart.

## Other differences

- Data and cache folders follow XDG: `~/.config/modsmith` and `~/.cache/modsmith`.
- Gradle and Minecraft are started in their own process groups so that stopping them also stops their child processes.
- The CurseForge API key is stored in the desktop keyring through Secret Service instead of Windows DPAPI. `MODSMITH_CURSEFORGE_API_KEY` still works when no keyring is available.
- Java is discovered from `JAVA_HOME`, `PATH`, `/usr/lib/jvm`, `~/.jdks` and `~/.gradle/jdks`.
- Linked modpack discovery also looks in `~/.local/share/ModrinthApp/profiles`, `~/.local/share/PrismLauncher/instances` and the Flatpak Prism Launcher folder. The CurseForge app has no Linux version.

## Verification

Tested on Ubuntu 26.04 in WSL2 with WSLg (Wayland session, so Modsmith and Minecraft both ran through XWayland), Java 25, a Fabric 1.21.1 project created and built by the Rust service:

- `npm run tauri:build` produced `Modsmith_0.1.0_amd64.deb` (6 MB) and `Modsmith_0.1.0_amd64.AppImage` (85 MB).
- The interface ran in WebKitGTK 2.52 with normal GPU compositing and connected to the service.
- Play started the development client and it docked in the Minecraft tab: the game window became a child of a host window inside the Modsmith window, and the "Embedded" state showed.
- Mouse and keyboard input reached the game (a click opened Options, Esc closed it). Clicking the game gave it keyboard focus; clicking the file tree or the sidebar gave focus back to Modsmith.
- In a world, the docked game held the pointer grab and mouse look worked: relative motion turned the player 85 degrees.
- The game followed the tab when the side panel was collapsed and expanded (1514 by 780, then 1207 by 780).
- Detach left the game as a normal window and it stayed there; Embed docked it again.
- `kill` (SIGTERM) on Modsmith while docked released the game, which kept running; reopening Modsmith docked the running game again.
- Stop asked the game to quit through the bridge; it exited with code 0.

Not verified yet:

- A native GNOME Wayland session and a KDE X11 session.
- Storing a CurseForge key in the desktop keyring. The first use of Secret Service asks the user to create or unlock a keyring.
- The in-game fullscreen toggle while docked (Modsmith tells the user fullscreen is unavailable while embedded, as on Windows).
- Release-build clients and NeoForge on Linux.
