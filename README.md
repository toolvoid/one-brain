# One Brain

One Brain is a local desktop app for saving, searching, linking, and visualizing memories from six AI sources: ChatGPT, Claude, Codex, Gemini, Groq, and DeepSeek. Memory data is stored in SQLite; the graph shows AI anchors, individual memories, and their links.

## Run locally

Requirements: Node.js and npm.

```sh
npm install
npm run dev
```

## Build the desktop app

Create an unpacked app folder for the current operating system:

```sh
npm run pack
```

Create the platform's installers and browser-extension builds:

```sh
npm run dist
```

Desktop packages are written to `release/`. Build on each target operating system for its native installer. The packaged app includes the MCP stdio bridge and launches it with its bundled Electron runtime, so users do not need to install Node.js separately.

## Build the browser extension

```sh
npm run build:extension
```

Load `extension/dist/chrome` as an unpacked extension in Chrome or `extension/dist/firefox` as a temporary/unpacked extension in Firefox. Keep `extension/keys/chrome.pem` private and backed up if you need to keep the same Chrome extension ID across rebuilds. After loading the extension, open its popup, choose a site, and pair it using the code shown in **Connections** in One Brain. Approve the new extension client in the app to finish pairing.

The dev script starts Vite and Electron. The Electron main process opens the SQLite database and starts the local MCP server.

## Security

The SQLite database uses SQLCipher encryption. Its key is protected with Electron `safeStorage` on supported backends; the app disables database writes when storage is unavailable or reports the `basic_text` backend. Browser extension and MCP tokens are created with owner-only file permissions where the operating system supports them. Local HTTP services bind to loopback and require authentication.

Connections → Security has a **Set password** action. It first saves a timestamped backup of the encrypted database and its current key, then re-keys a verified database copy with a random key wrapped by a password-derived scrypt key. The original key remains as `db.key.bak`. Export an encrypted recovery file after setting the password; forgetting the password without that file means the data cannot be recovered. Full-disk encryption (LUKS on Linux) is still recommended as the OS-level protection. The password unlock window and automatic locking are provided in the next security hardening step.

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

Start One Brain with `npm run dev` and open **Settings → Connections**. The MCP server listens on `127.0.0.1` (port 3737 by default; if busy, it chooses and saves another port). The app creates a bearer token in Electron's user-data folder. The stdio bridge reads the token and selected port there; keep the token private and out of source control.

Use the **Connections** section in One Brain to detect, preview, and connect supported AI clients. The app configures each client to launch its local stdio bridge. Keep One Brain running while using a connected client; its authenticated MCP service listens only on `127.0.0.1`.

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

The server provides `search_memories`, `get_memory`, `add_memory`, and `list_sources`. Claude Code can also connect directly to the authenticated HTTP endpoint shown in **Connections**.

The manual examples below are for connecting a development checkout. In a packaged app, use **Connections** so the client points to the installed bridge and its data directory.

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
