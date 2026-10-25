# Error codes

One Brain uses these stable codes in error messages, local diagnostics, and local service responses.

## SYS

| Code | Title | Meaning | Fix | Severity |
| --- | --- | --- | --- | --- |
| OB-SYS-000 | Unexpected error | Something unexpected happened. | Try the action again. If it continues, copy the code and include it when asking for help. | error |
| OB-SYS-001 | Preload failed | The secure app interface did not start. | Restart One Brain. If it continues, reinstall the app and share this code with support. | error |
| OB-SYS-002 | Shortcut unavailable on Wayland | Your desktop does not allow this app to register a global shortcut. | Use the system shortcut command shown in Settings → Connections → Quick context to assign a shortcut in your desktop settings. | warn |
| OB-SYS-003 | Local service port is in use | Another app is using the local port One Brain tried to open. | Close the other app, or restart One Brain so it can choose another available port. | warn |
| OB-SYS-004 | Unexpected shutdown | A graphics or child process exited unexpectedly. | Restart One Brain. If it repeats, switch Graphics mode to Software in Settings and share this code. | error |
| OB-SYS-005 | Clipboard unavailable | One Brain could not copy this text to the clipboard. | Try again, or select and copy the text manually. | warn |

## VAULT

| Code | Title | Meaning | Fix | Severity |
| --- | --- | --- | --- | --- |
| OB-VAULT-001 | Vault is locked | Unlock One Brain before accessing memories. | Open One Brain and enter your master password. | warn |
| OB-VAULT-002 | Password not accepted | The master password did not match. | Check the password and try again. If you changed it, use the current password or your encrypted recovery file. | warn |
| OB-VAULT-003 | Unlock temporarily paused | Too many password attempts were made. | Wait until the displayed timer ends, then try again carefully. | warn |
| OB-VAULT-004 | Recovery export unavailable | One Brain could not create an encrypted recovery file. | Set a master password, unlock the vault, then retry the recovery export. | error |

## DB

| Code | Title | Meaning | Fix | Severity |
| --- | --- | --- | --- | --- |
| OB-DB-001 | Database could not open | One Brain could not open its local memory database. | Restart One Brain. If the problem remains, do not delete database files; copy this code and contact support. | error |
| OB-DB-002 | Safety backup failed | One Brain could not make a safety backup, so the change was stopped. | Check free disk space and restart One Brain. Retry after the app reports the database is ready. | error |
| OB-DB-003 | Database is read-only | Memories cannot be changed while the database is read-only. | Unlock the app and check its Security status. Restart One Brain after restoring disk access. | warn |
| OB-DB-004 | Database migration failed | One Brain could not safely update the database format. | Restart One Brain. Keep existing backups and contact support with this code if it repeats. | error |

## MCP

| Code | Title | Meaning | Fix | Severity |
| --- | --- | --- | --- | --- |
| OB-MCP-001 | AI connection unavailable | One Brain could not start or reach its local MCP service. | Keep One Brain open, then reconnect the AI from Settings → Connections. | error |

## PROXY

| Code | Title | Meaning | Fix | Severity |
| --- | --- | --- | --- | --- |
| OB-PROXY-001 | Provider key missing | This AI provider has no saved API key. | Open Settings → Connections, add the provider key, and save it. | warn |
| OB-PROXY-002 | Provider key rejected | The AI provider did not accept the saved API key. | Check the key with the provider, update it in Settings → Connections, and test again. | warn |
| OB-PROXY-003 | Provider request failed | The AI provider could not complete the request. | Retry shortly. If it continues, check the provider status and your network connection. | error |

## EXT

| Code | Title | Meaning | Fix | Severity |
| --- | --- | --- | --- | --- |
| OB-EXT-001 | Extension origin does not match | This browser extension was not the one paired with One Brain. | Generate a new pairing code in One Brain and pair this installed extension again. | warn |
| OB-EXT-002 | Extension is busy | Too many extension requests arrived at once. | Wait a moment and retry. | warn |
| OB-EXT-003 | Extension needs approval | The extension paired, but One Brain has not approved it yet. | Open Settings → Connections and approve this extension client. | warn |
| OB-EXT-004 | Extension is blocked | One Brain has blocked this extension client. | Open Settings → Connections and unblock the extension if you trust it. | warn |
| OB-EXT-005 | Extension token is unknown | One Brain could not identify this extension token. | Pair this extension again from Settings → Connections. | warn |
| OB-EXT-006 | Extension token was revoked | This extension token has been revoked. | Pair the extension again if you want to reconnect it. | warn |
| OB-EXT-007 | Pairing could not finish | The pairing code or browser extension origin was not accepted. | Generate a fresh code in One Brain and enter it in the extension popup before it expires. | warn |

## CONN

| Code | Title | Meaning | Fix | Severity |
| --- | --- | --- | --- | --- |
| OB-CONN-001 | Client configuration failed | One Brain could not update this AI connection. | Close the AI client, retry the connection in One Brain, then reopen the client. | error |

## IMPORT

| Code | Title | Meaning | Fix | Severity |
| --- | --- | --- | --- | --- |
| OB-IMPORT-001 | Import could not be read | One Brain could not parse this file or pasted conversation. | Choose a supported export file or paste plain conversation text, then preview it again. | warn |
| OB-IMPORT-002 | Import safety check failed | One Brain could not create a safety backup before importing. | Check disk space and permissions, then retry the import. | error |

## EVAL

| Code | Title | Meaning | Fix | Severity |
| --- | --- | --- | --- | --- |
| OB-EVAL-001 | Memories need re-indexing | Some memories do not have embeddings for the current search model. | Open Insights → Retrieval evaluation and choose Re-embed memories; keep One Brain open until it completes. | warn |
| OB-EVAL-002 | Evaluation could not run | The retrieval evaluation did not finish. | Choose a dataset with questions and expected memories, then retry. | error |

## GRAPH

| Code | Title | Meaning | Fix | Severity |
| --- | --- | --- | --- | --- |
| OB-GRAPH-001 | Graphics process crashed | The graphics process exited with code 139. | Restart One Brain. If it repeats, choose Software graphics mode in Settings. | error |
| OB-GRAPH-002 | 3D graph unavailable | This system could not create a WebGL graphics context. | Use Software graphics mode in Settings, or update the graphics driver and restart. | warn |

## SEC

| Code | Title | Meaning | Fix | Severity |
| --- | --- | --- | --- | --- |
| OB-SEC-001 | Local data permissions need attention | One Brain could not secure its application data folder. | Check that your account can access the One Brain app data folder, then restart. | error |
| OB-SEC-002 | Provider key could not be saved | One Brain could not securely save the provider key. | Check Security status and try again after restarting One Brain. | error |

## UPDATE

| Code | Title | Meaning | Fix | Severity |
| --- | --- | --- | --- | --- |
| OB-UPDATE-001 | Automatic updates are not configured | This One Brain build has no signed update source configured. | Use the official download or your Linux package manager to install updates. | info |

## EMBED

| Code | Title | Meaning | Fix | Severity |
| --- | --- | --- | --- | --- |
| OB-EMBED-001 | Local embedding model unavailable | One Brain could not load its local embedding model. Check your internet connection, then retry. | Reconnect to the internet and select Retry. One Brain will download the pinned model revision when the model is first needed. | error |
