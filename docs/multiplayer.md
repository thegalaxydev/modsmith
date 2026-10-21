# Multiplayer test sessions

**More actions › Multiplayer test…** starts a dedicated server and one to four clients of the open project, connects the clients to the server and groups their output. It needs a server and a client run configuration (the starter's Dedicated Server and Test Client, or release ones).

## Starting a session

The dialog asks for:

- the server configuration;
- the client configuration;
- how many clients (1 to 4);
- a player name for each client (3 to 16 letters, digits or underscores, different from each other; Player1, Player2 and so on by default).

**Start** checks trust and the server's EULA the same way Play does and asks for anything missing. It then runs `session.start`, which:

1. Checks everything before starting anything: the profiles exist and have the right sides, the names are valid, the project is trusted, the EULA is accepted and none of the instance folders is already in use.
2. Sets `online-mode=false` and `server-port` in the server's `server.properties`, keeping the rest of the file. The port is the one already in the file, or 25565, or the next free port after it.
3. Starts the server and waits for its `Done (…)` line (up to 10 minutes). If the server stops first, the session fails and says so.
4. Starts the clients one after another, each joined to `127.0.0.1:<port>`.

If any step fails or the task is cancelled, the instances the session already started are stopped.

## Separate identities

Each client gets:

| | |
| --- | --- |
| Player name | `--username <name>` |
| UUID | The offline UUID Minecraft derives from the name (`OfflinePlayer:<name>`), passed as `--uuid` |
| Game folder | The configuration's instance folder for the first client, with `-2`, `-3` and `-4` added for the others (for example `.modsmith/instances/dev-client-client-2`), so worlds, options, logs and crash reports stay apart |
| Launch files | Classpath argument files and hot reload snapshots are kept per client |

Clients join with `--quickPlayMultiplayer` on Minecraft 1.20 and later, and with `--server` and `--port` on older versions. Release clients use the same names instead of "Player".

Every instance of a session carries `session`, `slot` and `player` in `instance.list`. The server has slot 0.

## Working with a session

- The toolbar shows the session's players while it runs. Its Stop button runs `session.stop`, which stops the clients and then the server. During startup it cancels the task.
- The Console's source list has a **Multiplayer** entry for each session. It merges the output of the server and every client in time order, with the source in front of each line. Server commands can still be typed while it is selected. Each instance can also be picked on its own.
- When more than one client is running, the Inspector shows a list to choose which client it inspects. Each client has its own bridge connection.
- The first client is the one docked in the Minecraft tab and used by Play's controls. The others open in their own windows.
- Hot reload (**Apply changes**) applies to the docked client; other clients with the debug port on need their own ports, which the service picks automatically when the profile's port is taken.

## API

| Method | |
| --- | --- |
| `session.start` | `{ path, server, client, clients?, names? }`. Long-running; the result lists the server and client instances |
| `session.list` | `{ path? }`. Sessions started since the service started, newest first, with their status (`starting`, `running`, `failed` or `stopped`), port and instances |
| `session.stop` | `{ id }` |

All three are also MCP tools.
