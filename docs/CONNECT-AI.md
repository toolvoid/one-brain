# Connect AI clients

Use **Settings → Connections** in One Brain to discover and configure supported clients. Managed integrations can preview the files they will update, write a local MCP configuration, and add One Brain instructions where supported. Clients appear as pending until approved in One Brain.

## MCP clients

The MCP service listens on `127.0.0.1` (port 3737 by default; it selects and saves another port if needed). A per-client bearer token is kept in the One Brain user-data directory. The stdio bridge reads that token and port and connects to `/mcp`; keep One Brain running while using it. The service offers `search_memories`, `search_memory`, `list_recent`, `get_memory`, `add_memory`, `save_memory`, and `list_sources` tools.

For a development checkout, a Codex CLI config can use:

```toml
[mcp_servers.one-brain]
command = "node"
args = ["/absolute/path/to/one-brain/scripts/mcp-stdio.js"]
```

VS Code Copilot uses `.vscode/mcp.json`:

```json
{
  "servers": {
    "one-brain": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/one-brain/scripts/mcp-stdio.js"]
    }
  }
}
```

For packaged installs, use **Connections** so the client points to the installed bridge and user-data location. Claude Code and Claude Desktop are among the managed clients; direct endpoint details and authentication are shown in the app.

## Memory proxy

The local proxy listens on `127.0.0.1` (port 3738 by default) and provides OpenAI-compatible routes for configured providers: OpenAI, Groq, DeepSeek, Gemini, OpenRouter, and Claude. Configure provider keys in One Brain, then configure an API client to use the local endpoint and its client token. Memory injection is a separate setting and is off by default. Provider requests go to the selected provider.

## Quick Context

Enable the Quick Context hotkey in Connections. Select text in another app and use the configured shortcut to search/copy context for manual paste. Wayland may require a desktop-level shortcut; see [Troubleshooting](TROUBLESHOOTING.md).

Never paste bearer tokens into shared configuration or commit them. See [Security](SECURITY.md), the [documentation index](README.md), and the preserved [privacy policy](privacy.md), [error code reference](ERRORS.md), and [extension listing](extension-store-listing.md).
