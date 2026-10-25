# One Brain

See the [error code reference](docs/ERRORS.md) for explanations and fixes for errors shown by One Brain.

One Brain is a local-first desktop app for saving, searching, linking, and visualizing memories shared across AI tools. It is built with Electron, React, and Vite in plain JavaScript, and stores memory in an encrypted SQLite database on your computer. There is no cloud server.

## Features

- **One shared memory for your AI tools:** connect MCP clients such as Codex, use the memory proxy with API-based apps, or use the browser extension with Claude, ChatGPT, Gemini, DeepSeek, Groq, and Perplexity. One Brain also includes a Chat view and a Quick Context hotkey.
- **Explore connected memories:** a 3D node graph shows memories and their semantic links.
- **Find relevant context:** hybrid search combines SQLite FTS5 full-text search with multilingual MiniLM embeddings and reciprocal rank fusion. A cosine relevance gate (0.25 cutoff) filters weak matches.
- **Review and control sharing:** private memories are excluded from every outbound path. Chat offers an “Ask before sending” preview. Per-client permissions and tokens control access.
- **See what is happening:** Connections health dashboard, activity charts and SQL in Insights, a RAM/CPU/latency Status panel, and a diagnostics log.

## Skills demonstrated

- **Import/capture → data ingestion:** [`src/lib/importers.mjs`](src/lib/importers.mjs) parses imports and caps each batch at 3,000 items.
- **Embeddings/retrieval/RAG → LLM application design:** [`electron/db.js`](electron/db.js) combines full-text and vector rankings with reciprocal rank fusion using `k = 60`; [`electron/memory-proxy.js`](electron/memory-proxy.js) supplies retrieved memories to chat completions.
- **MCP server → tool/protocol integration:** [`electron/mcp-server.js`](electron/mcp-server.js) registers seven MCP tools over Streamable HTTP.
- **SQL analytics → SQL and data analysis:** [`electron/sql-worker.js`](electron/sql-worker.js) accepts one read-only `SELECT`/`WITH` query, returns at most 200 rows, and enforces a 3-second timeout.
- **Evaluation/monitoring → model evaluation:** [`electron/db.js`](electron/db.js) runs retrieval evaluations; the 25-question synthetic set reports 90.5% hit@3 (see [evaluation results](#retrieval-evaluation)).
- **Graph view → data visualization:** [`src/components/BrainGraph.jsx`](src/components/BrainGraph.jsx) visualizes memories across eight source categories, including built-in chat.
- **Local encrypted storage → security/privacy:** [`electron/db.js`](electron/db.js) opens the local database through SQLCipher; [`electron/security-vault.js`](electron/security-vault.js) wraps the 32-byte database key with AES-256-GCM and derives its wrapping key with scrypt.

## Retrieval evaluation

The built-in retrieval evaluation currently reports:

| Evaluation set | Questions | Hit@3 | Hit@5 | MRR | Negative false positives |
| --- | ---: | ---: | ---: | ---: | ---: |
| Synthetic | 25 | 90.5% | 100% | 0.894 | 0% (4 questions) |
| Real memories | 12 | 91.7% | — | 0.917 | — |

Before tuning, synthetic hit@3 was 71.4%, with a 100% false-positive rate on the negative questions. These sets are small, so the results are indicative rather than a broad performance guarantee. The project has 324 automated tests passing.

### Supported platforms

One Brain supports Linux x64, Windows x64, and macOS on Apple Silicon only.

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

Create store-ready Chrome and Firefox zip files (extension version 1.4.1) with no development key, tests, or fixtures:

```sh
npm run package:extension
```

The command prints the zip paths and sizes. Store submission notes and the privacy policy are in [`docs/extension-store-listing.md`](docs/extension-store-listing.md) and [`docs/privacy.md`](docs/privacy.md). The generated store screenshot is a layout reference; replace it with a real screenshot before submission.

The dev script starts Vite and Electron. The Electron main process opens the SQLite database and starts the local MCP server.

## Security

The whole SQLite database is encrypted with AES-256. A master password derives a key-wrapping key using scrypt; the database key is wrapped rather than stored as plaintext. The app supports auto-lock, escalating lockout after failed unlock attempts, and an encrypted recovery file. On startup One Brain repairs user-data permissions to directories `0700` and files `0600`; token files and settings are also written owner-only. Local HTTP services bind to loopback and require authentication. Diagnostics and connection-activity records contain event metadata only, not memory text; renderer storage is limited to UI preferences such as model names and dismissed notices.

Settings → Connections → Security has master-password, encrypted recovery/restore, vault-status and auto-lock controls. Auto-lock is ON by default at 15 minutes (choose 1, 5, 15, 30, or 60 minutes); OFF disables idle locking only. Screen-lock/suspend locking is a separate ON-by-default setting. User input and active MCP/proxy/extension requests reset the idle timer; a one-minute warning offers **Stay unlocked**. Lock now and `Ctrl/Cmd+Shift+L` remain available. Locked MCP, proxy and extension requests return HTTP 423. Re-keying makes a timestamped backup first; the old key is retained until explicitly deleted. The Security page warns that old pre-password backups may be read without the password and requires the master password plus typed confirmation to delete them. Forgetting the password without an encrypted recovery file means data loss. Full-disk encryption (LUKS on Linux) is the recommended OS-level protection.

Electron renderer windows use context isolation, sandboxing, disabled Node integration, web security, strict CSP (no `unsafe-eval`), denied popups and cross-origin navigation, and denied permission requests. Every renderer IPC call is restricted to the trusted app frame; the preload exposes only named IPC channels. Diagnostics aggregate denied navigation, IPC, permission, authentication, rate-limit, and unlock events without recording request bodies or memory text. Provider API keys are encrypted at rest, masked in inputs, and are not returned to renderer state. Copying a saved key requires an explicit action and the master password; the key is copied directly by the main process and never sent to renderer state. Chat offers a preview of public memory context before sending; browser-extension insertion requires review unless the user explicitly enables automatic insertion. API proxy clients have a separate **Allow automatic memory injection** setting, off by default, and successful/rejected injection counts are recorded without memory text. Private memories are excluded from chat, proxy, MCP, extension search, and Quick Context results. Any text you choose to send to an online AI service is received by that provider. One Brain cannot guarantee protection if your computer is compromised.

One Brain does not currently have a configured signed update-manifest publisher. Linux updates are installed through the package manager; the app does not silently download or install updates.

The [user-data audit](docs/security-userdata-audit.md) documents persistent data, encryption, cleanup, permissions, and renderer storage. A temp-directory marker test checks that saved memory text does not leak into plaintext files. Temporary SQLCipher conversion snapshots are securely removed after use and during lock/quit/startup cleanup; secure overwrite on flash storage is best-effort.

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
