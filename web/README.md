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

All untrusted message content is rendered with DOM text nodes; only limited formatting and HTTP(S) links are recognized. Attachments are links, not automatic remote media requests. Browser sessions use a same-origin HttpOnly cookie, with exact Origin validation for writes; `/v1` stays compatible with CLI bearer tokens. See [API](../docs/api.md), [deployment](../docs/deployment.md) and [privacy](../docs/privacy.md).
