# GuildPort Web

A same-origin browser client for GuildPort, using the same accounts and permission checks as `dcgp`. Its source is independent of the host bot. The Python relay serves the compiled application; production needs no Node.js server.

From the repository root (Node.js 22.13+):

```sh
npm ci --prefix web
npm run build --prefix web
.venv/bin/python -m pip install -e ./server
.venv/bin/python examples/demo.py --seed
```

Open the demo URL and use its temporary account/password. It contains synthetic data only. To rebuild while editing, run `npm run build --prefix web -- --watch` and reload that page. The Vite development/preview servers are not used for authenticated access: the exact browser origin belongs to the relay.

Run browser integration tests:

```sh
cd web
npx playwright install chromium
npm test
```

Tests use a temporary local relay, exercise real HttpOnly cookie authentication and SSE, and save synthetic screenshots under the ignored project `tmp/` directory. `test-results/` is also ignored.

The interface includes server/channel selection, search, live messages, 50-message history pagination (500 messages in memory), scrolling/unread indicators, multiline input, automatic reconnect, light/dark themes, mobile navigation and logout. Password reset/registration remain in Discord. The browser stores no message archive or drafts on disk; up to 20 drafts are held in tab memory. Enter sends; Shift+Enter inserts a newline, and IME composition never submits. An uncertain send is never automatically retried.

The desktop layout combines a narrow navigation rail with a collapsible server/channel sidebar. A centered home screen offers channel search and suggestions; signing in opens a dialog. The chat/channel switch preserves the active conversation and draft while browsing, and the compact message composer expands for multiple lines. On small screens, the sidebar becomes a drawer.

Image attachments and supported image links have a **Preview** button. Inspired by ChatPTT's floating viewer, the non-modal window can be dragged, resized from all four corners, or reset to small/medium/large sizes. Previous/next buttons and left/right arrow keys browse unique media links in the currently loaded messages. Escape closes the focused viewer; the drag and resize controls also support arrow keys. The composer remains usable while viewing. Only the selected image is loaded, and ordinary live updates do not reload it. Changing channels/views, logout, access revocation, or removal of the selected media clears the viewer.

Direct image links, common image format parameters and single-image Imgur links are supported. GIFV becomes MP4; MP4/WebM use native muted controls without autoplay. Discord attachment links use fresh signed URLs from matching attachment/embed metadata when available, without changing message text or looking up unrelated channels. Spoiler attachments show an explicit warning, including those marked by Discord flags without a filename prefix; reveal them before previewing and hide them again at any time. Messages containing only attachments do not create empty text bubbles.

Custom Discord emoji display inline by default, including animated emoji. The header's smile button toggles these images; when off, names remain clickable for manual preview. The smile button in the composer opens a searchable picker for the current server, filtered to emoji available to both the user and bot. Selecting an emoji inserts its markup at the cursor; sending remains a separate action. The catalog is fetched only when opening the picker, is kept only while open, and is cleared on channel changes or revoked access. Code blocks and unrevealed spoilers do not automatically load emoji.

Ordinary image/video previews load directly from public HTTPS destinations without Referer, only after a click; they never use a relay image proxy. Custom emoji load automatically from Discord's fixed CDN host while enabled. External hosts can see the viewer's IP and may cache or log requests, and the browser may cache media. Failed/expired media offers the original link. Viewer settings and media URLs are not saved to browser storage.

All untrusted message content is rendered with DOM text nodes; only limited formatting and HTTP(S) links are recognized. Browser sessions use a same-origin HttpOnly cookie, with exact Origin validation for writes; `/v1` stays compatible with CLI bearer tokens. See [API](../docs/api.md), [deployment](../docs/deployment.md) and [privacy](../docs/privacy.md).
