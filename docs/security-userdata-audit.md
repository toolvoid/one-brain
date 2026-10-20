# One Brain user-data audit

This is a source and temporary-fixture audit. The real `userData` directory was not read or modified. “Encrypted” describes persistent content; transient in-memory caches are noted separately.

| Location / artifact | Contains memory text? | Encrypted? | Status |
| --- | --- | --- | --- |
| `onebrain.db`, `onebrain.db-wal`, `onebrain.db-shm` | Yes | Yes, SQLCipher | Verified by the temp-userData marker scan; no plaintext marker was found. |
| Embedding vectors and embedding/memory caches | No in vector cache; the DB memory cache contains text in RAM | Persistent vectors are inside SQLCipher; RAM cache is not encrypted | `lockDatabase()` clears vectors, memory rows, embedding queues/jobs, and the DB key/handle on lock. |
| `models/` | No | No | Contains downloaded model weights/configuration, not user memory; directory/file modes are repaired at startup. |
| Chat temp files | No separate app-owned chat temp files found | N/A | Saved conversations live in SQLCipher; request/renderer content is transient in memory. |
| Recovery exports and encrypted backup files | Yes, in the database payload | Yes, password-wrapped key plus encrypted database; mode `0600` | Export uses an atomic private write; restore stages are removed on completion/failure and by lock/quit/startup cleanup. |
| `migration-backups/`, `db.key.bak`, `.precleanup-backups/`, `onebrain.db.pre-encryption.bak` | Yes, inside database backups | Database: SQLCipher; old key copy: protected by `safeStorage`, but it can unlock the old DB without the master password | Security UI warns when actual backup files exist; deletion requires the master password and typed confirmation. Empty folders do not trigger the warning; backups are never auto-deleted. |
| Temporary DB/recovery/migration snapshots | Yes for database-conversion stages | Password/recovery staging may be plaintext briefly; retained backups are encrypted | Known transient names use secure overwrite/removal on completion, failure, lock, quit, and next startup. Pre-cleanup backups now copy the already encrypted DB after checkpointing, without a plaintext DB snapshot. |
| `lifecycle.log` and diagnostics | No memory text by design | No | Event/allowlisted metadata only, capped and redacted; file mode `0600`. The marker scan covers writes after saving a known memory. |
| `connection-activity.json` | No | No | Client/action/status/count metadata only; strict field allowlists and mode `0600`. |
| Renderer Local Storage | No | No | Stores UI preferences such as model names and dismissed notices; no memory text, API key, or chat body writes found. |
| Renderer IndexedDB / Session Storage | No | No | No application reads/writes found in `src/`; app memory data crosses IPC into renderer memory only. |
| `tokens/` | No | No | Tokens are plaintext credentials, not memory content; directory is `0700`, files `0600`, and startup repairs loose permissions. |
| `db.key`, `db.vault.json`, security settings | No | Key: Electron `safeStorage`; vault: scrypt + AES-256-GCM; settings: no secrets | Created atomically with private modes; startup repairs permissions and logs changes/failures without values. |

Secure overwrite is best-effort on flash storage; full-disk encryption remains the OS-level protection recommended in Settings > Security.
