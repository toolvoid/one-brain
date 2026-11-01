# One Brain

**A private, local-first memory for your AI tools.** Capture something once, then find and reuse it from search, chat, MCP clients, and supported browser chats.

<!-- Screenshot placeholders: replace with real captures of the current app UI. -->
| Main memory view | Chat and context preview |
| --- | --- |
| _Screenshot placeholder_ | _Screenshot placeholder_ |

## Why One Brain

Useful context gets split across assistants and browser chats. One Brain keeps your saved memories in an encrypted database on your computer and gives you local ways to search, review, and share selected context. It has no One Brain cloud server; if you send context to an online AI provider, that provider receives it.

## Features

- Save, organize, import, link, and browse personal memories in one desktop app.
- Search with SQLite full-text search and multilingual MiniLM embeddings.
- Connect MCP clients and use an authenticated local OpenAI-compatible memory proxy.
- Use built-in chat, Quick Context, and an optional browser extension for supported chat sites.
- Mark memories private; review context before sending and manage per-client access.
- Inspect activity, retrieval quality, database status, and connection health in Insights.

## Downloads

Windows and macOS builds are paused while we fix a startup bug. Linux is available. Choose the Linux installer from [GitHub Releases](../../releases). The Linux x64 AppImage was measured at about **192 MiB**; artifact sizes can vary by release.

| Platform | Installer | Versioned artifact | Stable name | Download |
| --- | --- | --- | --- | --- |
| Linux x64 | AppImage | `One-Brain-<version>-linux-x64.AppImage` | `One-Brain-linux-x64.AppImage` | [Download](https://github.com/toolvoid/one-brain/releases/latest/download/One-Brain-linux-x64.AppImage) |
| Windows | — | — | — | Temporarily unavailable, fix in progress |
| macOS | — | — | — | Temporarily unavailable, fix in progress |

## Quick start

For a development checkout, install Node.js and npm, then run:

```sh
npm install
npm run dev
```

Open **Settings → Connections** to add an AI client or pair the browser extension. See [Connect AI clients](docs/CONNECT-AI.md).

## Supported platforms

Linux x64 is currently available. See [platform details](docs/supported-platforms.md).

## Known limitations

- Installers are unsigned and may trigger operating-system security warnings.
- A signed automatic update source is not configured; install updates from releases.
- Ubuntu AppImage use may require `libfuse2`.
- On Wayland, One Brain re-launches under XWayland when available. Set `ONE_BRAIN_OZONE=auto` to skip that re-launch when collecting logs; XWayland is required for the automatic X11 path.
- First use of semantic search needs internet to download the roughly 130 MB embedding model. A failure shows **OB-EMBED-001** and a Retry action.

## Project guides

- [Security and privacy](docs/SECURITY.md) · [Architecture](docs/ARCHITECTURE.md) · [Evaluation](docs/EVALUATION.md)
- [Connect AI clients](docs/CONNECT-AI.md) · [Browser extension](docs/EXTENSION.md) · [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Supported platforms](docs/supported-platforms.md) · [Documentation index and existing docs](docs/README.md)
- [MIT License](LICENSE)
