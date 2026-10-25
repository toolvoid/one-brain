# Browser extension

The optional Manifest V3 extension pairs with the local One Brain app. It supports ChatGPT, Claude, Gemini, DeepSeek, Groq Playground, and Perplexity pages. Site adapters can save selected chat content to local memory, search memory, and insert reviewed context where the page supports it. Selector health can change when a chat site changes its interface.

## Build and load locally

```sh
npm run build:extension
```

Load `extension/dist/chrome` as an unpacked Chrome extension or `extension/dist/firefox` as a temporary add-on in Firefox. The build creates browser-specific manifests and host permissions for the supported sites and the local loopback API.

1. Start One Brain and open **Settings → Connections → Browser extension**.
2. Create a pairing code and note the local API address.
3. Open the extension popup, select the site, enter the address and six-digit code, then pair.
4. Approve the pending extension client in One Brain. Pair each site separately.
5. Use the popup status check if a site adapter stops recognizing the page.

The extension stores its per-site tokens in browser extension storage and sends requests to One Brain over loopback. Host access is limited to supported chat pages. Insertion may be unavailable if a site's composer is not detected; saving can still work. The extension's self-check reports selector matches and does not report page text.

To create store zips, run `npm run package:extension`. The Chrome development signing key in `extension/keys/chrome.pem` must be kept private and backed up if a stable extension ID is required. Store listing and artwork are maintained separately.

See [Troubleshooting](TROUBLESHOOTING.md), [Security](SECURITY.md), the [documentation index](README.md), the preserved [extension store listing](extension-store-listing.md), [privacy policy](privacy.md), [error codes](ERRORS.md), and [store assets](store-assets/one-brain-popup-chat-screenshot.png).
