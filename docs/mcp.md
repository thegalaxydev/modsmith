# MCP setup

Modsmith includes an MCP server (official TypeScript SDK v2, `@modelcontextprotocol/server`) over stdio. It connects to the running Modsmith service, starting it if needed, so assistant actions share instances, operations and activity history with the UI and CLI. It hosts tools; it does not run a model.

## Configuration

Print the configuration for this installation:

```bash
node bin/modsmith.cjs mcp config
```

For an installed app it points at the bundled runtime:

```json
{
  "mcpServers": {
    "modsmith": {
      "command": "C:\\Users\\you\\AppData\\Local\\Modsmith\\node.exe",
      "args": ["C:\\Users\\you\\AppData\\Local\\Modsmith\\app\\dist\\mcp\\main.cjs"],
      "env": {}
    }
  }
}
```

Claude Code:

```bash
claude mcp add modsmith -- "C:\Users\you\AppData\Local\Modsmith\node.exe" "C:\Users\you\AppData\Local\Modsmith\app\dist\mcp\main.cjs"
```

The command is the runtime that started the service, so in a development checkout it is your Node and `dist\mcp\main.cjs` (run `npm run build` first). The same snippet is in Settings > MCP in the app.

## Tools

One tool per service method marked for MCP in `src/shared/api.ts`, named with underscores (`workspace_inspect`, `project_create`, `instance_launch`, `registry_search`, `world_give_item`, `viewport_capture`, ...). Arguments are validated by the SDK from the same zod schemas the service uses.

Long-running tools (`project_create`, `project_build`, `profile_resolve`, `instance_launch`, `scenario_run`, pack import, snapshots) return an operation. Use `operation_wait`, `operation_status`, `operation_log` and `operation_cancel`.

Typical assistant workflow:

1. `project_create` → `operation_wait`
2. `dependency_search` → `dependency_add` → `profile_resolve`
3. `instance_launch` → `operation_wait` → `bridge_status` until connected
4. `world_open` (create a flat world) → `game_status` until `inWorld`
5. `registry_search`, `world_give_item`, `world_run_command`, `world_inspect_target`, `viewport_capture` (returns the PNG as image content)
6. `logs_read`, `crash_inspect`
7. `instance_stop`

## Safety

- Gradle runs only in trusted workspaces. `workspace_trust` exists for the case where the user has approved it.
- File tools are scoped to the workspace root, including symlink resolution.
- Destructive tools (`workspace_delete_file`, `profile_remove`, `world_restore`) require `confirm: true` and are annotated as destructive.
- `instance_accept_eula` must only be called after the user accepts the Minecraft EULA.
- Setting or clearing the CurseForge API key is not available through MCP.
- Results that contain logs, mod metadata, file contents or remote catalog data are prefixed with a note that they are untrusted data, not instructions.
- Every MCP call is recorded in the activity history (source `mcp`) with secrets redacted.

## Resources

`modsmith://capabilities`, `modsmith://catalog`, `modsmith://workspaces`, `modsmith://instances`, and templates:
`modsmith://workspace/{workspace}/manifest|lock|diagnostics|results`, `modsmith://instance/{instance}/logs|crash`, `modsmith://instance/{instance}/registry/{registry}` (`{workspace}` is the URL-encoded absolute path).

## External MCP servers

Consuming external MCP servers from an in-app assistant is a separate, planned extension point and is not implemented.
