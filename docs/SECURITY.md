# Security and privacy

One Brain stores memory data locally. Local storage reduces the app's own server-side exposure, but it does not protect a compromised or unlocked computer, and it cannot control what an online provider does with context you choose to send.

## Database and keys

- The memory database uses SQLCipher through `better-sqlite3-multiple-ciphers`.
- A random 32-byte database key is encrypted with Electron `safeStorage` when stored in the user-data folder. If OS secure storage is unavailable or uses the `basic_text` backend, database writes are disabled.
- An optional master password wraps the database key with AES-256-GCM. A scrypt-derived wrapping key uses `N=2^18`, `r=8`, `p=1`; the password must be at least 12 characters.
- An encrypted recovery file can restore the wrapped database key. Keep it separate from the computer and remember its password.
- On Unix-like systems, One Brain applies owner-only directory and file permissions to its user-data tree. Windows ACL behavior is delegated to the operating system; not independently verified here.

## Access and sharing

- Electron windows use context isolation, sandboxing, disabled Node integration, and web security. Renderer IPC is exposed through named preload methods.
- MCP, memory-proxy, and extension services bind to loopback and authenticate requests with bearer tokens. MCP tools and client profiles are subject to approval and permissions.
- Private memories are filtered from retrieval and outbound context paths. Chat has a review flow; API proxy automatic injection has its own opt-in setting.
- Provider keys are encrypted at rest and are not returned to renderer state. Requests sent to a provider leave the computer.
- Diagnostics record event metadata and sanitized errors; they are not designed to store memory content or request bodies.

## Locking and recovery

The vault can lock after inactivity or system lock/suspend. The default idle timeout is 15 minutes and supported choices are 1, 5, 15, 30, or 60 minutes. Locked data operations are denied until unlock. Failed password attempts use escalating cooldowns. Password migration and recovery operations create and verify backups before changing the active key.

## Security limits

This guide describes implementation behavior; it is not an independent security audit. Physical access, malware, compromised OS accounts, backups, memory dumps, and data explicitly sent to a provider are outside the app's protection. Secure overwriting cannot be guaranteed on SSDs or other wear-leveling storage. Not verified: an external penetration test, OS-specific safeStorage threat models, or Windows ACL behavior in a packaged build.

See the preserved [privacy policy](privacy.md), [HTML privacy policy](privacy.html), [user-data audit](security-userdata-audit.md), [error code reference](ERRORS.md), and [documentation index](README.md).
