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

Choose the installer for your system from [GitHub Releases](../../releases). The Linux x64 AppImage was measured at about **192 MiB**; artifact sizes can vary by release.

| Platform | Installer | Artifact pattern | Download |
| --- | --- | --- | --- |
| Linux x64 | AppImage | `One-Brain-<version>-linux-x64.AppImage` | [Releases](../../releases) |
| Windows x64 | NSIS installer | `One-Brain-<version>-win-x64.exe` | [Releases](../../releases) |
| macOS Apple Silicon | DMG | `One-Brain-<version>-mac-arm64.dmg` | [Releases](../../releases) |

## Quick start

For a development checkout, install Node.js and npm, then run:

```sh
npm install
npm run dev
```

Open **Settings → Connections** to add an AI client or pair the browser extension. See [Connect AI clients](docs/CONNECT-AI.md).

## Supported platforms

Linux x64, Windows x64, and macOS on Apple Silicon only. See [platform details](docs/supported-platforms.md).

## Known limitations

- Windows and macOS builds are built and smoke-tested in CI, but have not been manually tested.
- Installers are unsigned; Windows SmartScreen and macOS Gatekeeper may warn.
- A signed automatic update source is not configured; install updates from releases or the Linux package manager.
- Ubuntu AppImage use may require `libfuse2`.
- On Wayland, One Brain re-launches under XWayland when available. Set `ONE_BRAIN_OZONE=auto` to skip that re-launch when collecting logs; XWayland is required for the automatic X11 path.
- First use of semantic search needs internet to download the roughly 130 MB embedding model. A failure shows **OB-EMBED-001** and a Retry action.
- Intel macOS is unsupported because the installed ONNX Runtime dependency has no `darwin/x64` native runtime.

## Project guides

- [Security and privacy](docs/SECURITY.md) · [Architecture](docs/ARCHITECTURE.md) · [Evaluation](docs/EVALUATION.md)
- [Connect AI clients](docs/CONNECT-AI.md) · [Browser extension](docs/EXTENSION.md) · [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Supported platforms](docs/supported-platforms.md) · [Documentation index and existing docs](docs/README.md)
- [MIT License](LICENSE)
