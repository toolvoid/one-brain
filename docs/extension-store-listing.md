# One Brain browser extension: store submission notes

## Single-purpose statement

One Brain lets people save and retrieve selected AI chat context in their local One Brain desktop memory, with user-controlled review and insertion.

## Short description

Save and retrieve chat context with your local One Brain desktop app.

## Detailed description

One Brain connects supported AI chat pages to the One Brain desktop app running on your computer. Save selected messages to your shared memory, search that memory, and optionally review relevant context before inserting it into a chat. The extension supports ChatGPT, Claude, Gemini, DeepSeek, Groq, and Perplexity at `perplexity.ai` and `www.perplexity.ai`. Pair it with a one-time code from the desktop app; the app keeps control of client approval and memory permissions.

The extension has no cloud service, account, telemetry, or advertising. Its network requests go only to the One Brain app at `127.0.0.1`. Text you choose to submit through an online AI chat page is handled by that AI provider under its own terms.

## Permissions

| Manifest permission | Why it is needed |
| --- | --- |
| `storage` | Stores the local app address, per-site pairing tokens, and the user's per-site extension settings in browser extension storage. |

The extension uses the Tabs API to check the active tab and deliver requested self-checks. It does not request the broad `tabs` permission; the declared host permissions scope URL access to the supported chat sites.

## Host permissions

| Host permission | Why it is needed |
| --- | --- |
| `http://127.0.0.1/*` | Connects to the local One Brain pairing, status, memory search, and save APIs. |
| `https://chatgpt.com/*` | Runs the ChatGPT adapter on the supported chat site to enable user-requested save/search/context features. |
| `https://claude.ai/*` | Runs the Claude adapter on the supported chat site to enable user-requested save/search/context features. |
| `https://gemini.google.com/*` | Runs the Gemini adapter on the supported chat site to enable user-requested save/search/context features. |
| `https://chat.deepseek.com/*` | Runs the DeepSeek adapter on the supported chat site to enable user-requested save/search/context features. |
| `https://console.groq.com/playground*` | Runs the Groq adapter only on its supported chat playground. |
| `https://perplexity.ai/*` | Runs the Perplexity adapter on Perplexity's supported chat pages. |
| `https://www.perplexity.ai/*` | Runs the Perplexity adapter on the `www` hostname for the same supported chat pages. |

Content scripts are restricted to the supported chat-site patterns, including only the two Perplexity hostnames above. No broad all-sites match is used. The extension loads no remote code, calls no `eval` or `new Function`, and includes no analytics or tracking.

## Data-use disclosures

- The extension stores the chosen `127.0.0.1` app address, pairing tokens, and per-site preferences in browser extension storage on this device.
- One Brain stores the paired extension origin and associated client/token state in its local app data. Memory text remains in the desktop app's encrypted local database.
- Extension API traffic is sent only to `127.0.0.1`, the One Brain desktop app on this computer. The extension does not send data to One Brain servers because there are no One Brain cloud servers.
- On supported chat pages, content scripts may inspect the visible conversation or composer to perform a feature the user enabled or requested. Private memories are excluded by the desktop app. Memory context is inserted only according to the user's review and per-site settings.
- If the user submits text in an online AI chat, that provider receives the submitted text. That transfer is initiated through the chat site and is subject to that provider's privacy policy.
- One Brain does not collect analytics, sell data, or share data with advertising companies.

## Reviewer notes

The extension requires the One Brain desktop app to be installed, running, and unlocked. Its authenticated local API listens on `127.0.0.1` (port 3738 by default; the app may choose another saved port).

Suggested review procedure:

1. Start One Brain and open **Settings → Connections → Browser extension → Pair** to create a short-lived pairing code.
2. Open the extension popup, choose a supported site, enter the displayed local API address and pairing code, and select **Pair**.
3. Approve the pending extension client in One Brain's Connections settings.
4. Open the selected supported chat site. Confirm that the extension popup reports a healthy paired connection; test a user-selected save or reviewed memory search.
5. To verify origin enforcement, pair one installed extension ID. A different unpaired extension origin must be rejected by the local API.

The Chrome Web Store build intentionally omits the `key` field so Chrome assigns the published extension ID. Pairing saves the actual browser extension origin and does not depend on the development extension ID. The Firefox build has the stable add-on ID `one-brain-extension@one-brain.local` for signing preparation.

## Store assets

- Original mark: `../extension/assets/one-brain-mark.svg`
- Small promo tile (440 × 280): `store-assets/one-brain-small-promo.png` and editable `store-assets/one-brain-small-promo.svg`
- Popup and chat-page layout reference (1280 × 800): `store-assets/one-brain-popup-chat-screenshot.png` and editable `store-assets/one-brain-popup-chat-screenshot.svg`

The screenshot is an illustrative layout reference generated from the repository UI; replace it with a real screenshot before submission.
