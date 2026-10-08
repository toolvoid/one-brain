# One Brain

One Brain is a local desktop app for saving, searching, linking, and visualizing memories from six AI sources: ChatGPT, Claude, Codex, Gemini, Groq, and DeepSeek. Memory data is stored in SQLite; the graph shows AI anchors, individual memories, and their links.

## Run locally

Requirements: Node.js and npm.

```sh
npm install
npm run dev
```

The dev script starts Vite and Electron. On Linux it already passes Electron's `--ozone-platform=x11` flag. The Electron main process opens the SQLite database and starts the local MCP server.

## Project structure

```text
src/
  App.jsx                 Sidebar, search, memory actions, MCP settings
  components/BrainGraph.jsx  Three.js memory graph
  main.jsx                React entry point
electron/
  main.js                 Electron window and IPC handlers
  preload.js              Safe renderer API via contextBridge
  db.js                   SQLite memories, links, and full-text search
  mcp-server.js           Authenticated Streamable HTTP MCP server
scripts/
  mcp-stdio.js            stdio-to-HTTP bridge for MCP clients
index.html                Vite page
vite.config.mjs           Vite configuration
```

## Connect an AI client

Start One Brain with `npm run dev` and open the gear icon's **Connect AI** section. The MCP server listens on `127.0.0.1` (port 3737 by default; if busy, it chooses and saves another port). The app creates a bearer token in Electron's user-data folder. The stdio bridge reads the token and selected port there; keep the token private and out of source control.

Configure an MCP client to launch `scripts/mcp-stdio.js` with Node. Use the absolute path to this project on your machine.

Codex CLI (`~/.codex/config.toml`):

```toml
[mcp_servers.one-brain]
command = "node"
args = ["/absolute/path/to/one-brain/scripts/mcp-stdio.js"]
```

VS Code Copilot (`.vscode/mcp.json`):

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

The server provides `search_memories`, `get_memory`, `add_memory`, and `list_sources`. Alternatively, use the client-specific snippets in **Connect AI**; Claude Code can connect directly to the authenticated HTTP endpoint shown there.

## Troubleshooting

**Linux Electron sandbox error:** For local development with trusted code, launch Electron with `--no-sandbox` (this disables Chromium's sandbox). Start Vite in one terminal, then run Electron in another:

```sh
./node_modules/.bin/vite
./node_modules/.bin/wait-on http://localhost:5173 && ./node_modules/.bin/electron . --ozone-platform=x11 --no-sandbox
```

**Port 5173 is busy:** Vite uses `strictPort`, and Electron loads this same port. Check which process is listening, stop that process if appropriate, then rerun `npm run dev`:

```sh
lsof -nP -iTCP:5173 -sTCP:LISTEN
```
