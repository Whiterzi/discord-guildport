# Discord GuildPort

Web and terminal clients for Discord communities, served through a bot you operate.

Open your relay’s URL in a browser, or run `dcgp` and pick a server and channel with the arrow keys. GuildPort uses its own accounts and device sessions. Discord messages are sent by the bot with explicit sender attribution; GuildPort never asks for a Discord user password or user token.

**CLI release: 0.1.0, npm channel `latest`.** The Python relay remains a prerelease for small deployments. Automated checks cover the API, Discord adapter, CLI integration and terminal interaction; each relay deployment still requires its own live Discord validation. This project is not affiliated with or approved by Discord.

## What it does

- `/register` shows a privacy notice and creates an account after the invoking user agrees; credentials are returned ephemerally.
- `/dcgp` privately provides the web login link and copyable login/menu commands using the published CLI, with the relay URL and username prefilled. Passwords and tokens never appear in these commands.
- The web client uses the same account, with a searchable channel sidebar, live chat, history pagination, dark/light themes and mobile navigation. Browser sessions use HttpOnly cookies; messages and drafts stay in memory.
- `dcgp` opens an interactive login/menu. Use ↑/↓ and Enter to choose a shared server and an enabled channel.
- Full-screen chat keeps the channel/status header and composer fixed. Page Up / Page Down scroll; Esc returns to the picker; End jumps to the latest messages. New messages preserve your draft and reading position.
- Scriptable commands provide listing, history, sending and newline-delimited event output.
- Only administrator-enabled, non-age-restricted, ordinary text channels are supported.
- Every read/send/subscription checks the member, bot and channel permissions. Removing a member, revoking a session or disabling a channel stops access.
- Passwords use Argon2id. Session tokens are random, stored as hashes on the server, expire after seven days, and can be revoked.

## Architecture

```text
Browser (JavaScript / Vite)        dcgp (TypeScript / npm)
       │ HttpOnly cookie                 │ Bearer token
       └──────── HTTPS + SSE ────────────┘
GuildPort core (Python / aiohttp / SQLite)
       │ Adapter interface
Discord adapter (discord.py, existing bot connection)
       │ Official bot API and Gateway
Discord
```

`server/src/guildport` is an independent Python package. `cli` is an independent npm package named `discord-guildport`, with the executable `dcgp`. `web` contains the independent web client source and browser tests; its build is bundled in the Python wheel. The host bot supplies its client and command tree; GuildPort does not import the host project's code. A standalone development host and an offline demo are included.

## Try the offline demo

Requires Python 3.9+ and Node.js 22.13+. Python 3.12+ is recommended for new deployments; Python 3.9 compatibility is retained for existing hosts.

```sh
git clone https://github.com/Whiterzi/discord-guildport.git
cd discord-guildport
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
npm ci --prefix web
npm run build --prefix web
.venv/bin/python -m pip install -e ./server
npm ci --prefix cli
npm run build --prefix cli
.venv/bin/python examples/demo.py
```

The demo prints a loopback URL and temporary GuildPort credentials. Open that URL in a browser to try the web client. To try the CLI, in a second terminal, from the repository root:

```sh
node cli/dist/main.js
```

Choose **Log in to a relay**, enter the demo URL/account/password, then **Browse servers and channels** → **Offline demo** → **#general**. These are synthetic messages; the demo never connects to Discord. Stop it with Ctrl+C to delete its temporary database.

To install the CLI from this checkout:

```sh
cd cli
npm pack
npm install --global ./discord-guildport-0.1.0.tgz
dcgp
```

The stable CLI release command is `npm install --global discord-guildport@latest`, or `npx --yes --package=discord-guildport@latest dcgp` without a global installation. CLI `0.1.0` is published on `latest`. Existing sessions remain usable. Relay server 0.1.0a5 or newer includes the permission-query latency fix; 0.1.0a6 adds the web client and updates `/dcgp` to `@latest`. Pushing this repository does not publish npm packages.

## Discord setup

1. Create a development Discord application/bot. Enable **Message Content Intent** in its Developer Portal settings. Member and presence privileged intents are not required.
2. Invite it with `bot` and `applications.commands`, granting View Channels, Read Message History and Send Messages in the intended channels.
3. Set `DISCORD_TOKEN` securely in the process environment. Set `GUILDPORT_TEST_GUILD` to restrict development command sync to one server. `GUILDPORT_PUBLIC_URL` defaults to `http://127.0.0.1:8769`; external clients require your own HTTPS origin.
4. Start the development bot with `.venv/bin/python -m guildport.standalone`.
5. A server administrator uses `/relay enable channel:#general`, after informing members how this relay processes messages. Installation alone does not enable channels.
6. Each user runs `/register` in Discord, reads and accepts the privacy notice, then uses `/dcgp` for the web entry point or copyable CLI commands. Login prompts for the password separately.

No Discord credentials belong in the CLI. For production, terminate TLS at a reverse proxy; the API binds only to `127.0.0.1`. See [deployment](docs/deployment.md), [embedding](docs/embedding.md), and [data handling](docs/privacy.md).

## CLI commands

```sh
dcgp                          # interactive login and arrow-key menus
dcgp browse                   # same interactive interface
dcgp login --server https://relay.example.com --username gp_DISCORD_ID
dcgp whoami
dcgp guilds
dcgp channels GUILD_ID
dcgp history CHANNEL_ID --limit 30
dcgp history CHANNEL_ID --before MESSAGE_ID --json
dcgp chat CHANNEL_ID
dcgp send CHANNEL_ID "Hello from my terminal"
dcgp watch CHANNEL_ID --json
dcgp logout
dcgp logout --all
```

Login prompts for the password without echoing it. Automation can use `--password-stdin`; there is no password command-line flag. Sessions are stored in `$XDG_CONFIG_HOME/guildport/session.json` (default `~/.config/guildport/session.json`) with mode 0600 on POSIX. Use `GUILDPORT_CONFIG_DIR` for an isolated profile. The file is not encrypted; protect the host account/disk. On Windows, account-directory ACLs provide the file protection.

`logout` revokes the server token before removing the local file. If the server is unreachable, it keeps the file so revocation can be retried. `logout --local-only` only removes the local file; revoke the session through Discord when possible.

## Chat controls

| Key | Action |
| --- | --- |
| Enter | Send the draft |
| Ctrl+C | Exit the CLI and restore the terminal |
| Esc | Return one level: chat → channels → servers → main menu → exit |
| Page Up / Page Down, ↑ / ↓ | Scroll a page or a line; Page Up at the top loads older history |
| End | Follow the latest messages and clear the new-message count |
| Home | Go to the oldest loaded message |
| ← / →, Ctrl+A / Ctrl+E | Move the draft cursor |
| Shift+Enter / Ctrl+J | Insert a line break (Shift+Enter requires terminal support); bracketed multiline paste stays in the draft until Enter |
| Ctrl+U | Clear the draft |
| F2 | Toggle message IDs |

Selection menus use a fixed full-screen layout. Type to filter servers/channels, Ctrl+U clears the filter, and Page Up/Down pages through longer lists. Returning from chat keeps the previous channel selected. Refresh and back remain available when nothing matches.

Shift+Enter is recognized via the [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) or xterm modified-key sequences. A legacy terminal may send exactly the same bytes for Enter and Shift+Enter; in that case use Ctrl+J or configure your terminal to send `\x1b[13;2u` for Shift+Enter. Keyboard mode is restored on exit.

The header shows connection/read-only state. Times use the local time zone, dates separate days, and the body renders basic Markdown as readable text. Spoilers are hidden as `[spoiler]`; terminal controls are stripped. The view retains up to 500 messages in memory. No local chat history is written. `history --json` and `watch --json` retain structured output; use `history --details` for visible IDs. A terminal supporting ANSI alternate-screen and bracketed paste is required for full-screen chat. The generic `watch` command remains available for plain streaming output.

## Current boundaries

- No DMs, threads, forum channels, voice, age-restricted channels, attachment uploads or message editing commands. Incoming attachments are displayed as links; edits/deletes produce event notices.
- Guilds only appear when the user has access to at least one enabled channel. GuildPort does not enumerate every server a user has joined.
- Messages are sent by the bot in a card with the member’s small avatar/name and a `via GuildPort · Discord ID` footer when both member and bot have Embed Links permission. Otherwise the relay uses its attributed plain-text format. Mentions are suppressed; no webhook or Discord user token is used.
- Bot-visible permissions cannot prove email/phone verification. In a server with verification enabled, sending is conservatively read-only unless Discord reports an explicit member verification exemption or administrator status. The channel list explains this restriction. Do not weaken a server's verification requirements for this tool.
- Slowmode covers relay sends and recent native Discord sends. If a busy channel's slowmode window cannot be fully checked within 101 messages, sending is refused.
- This is not a complete replacement for Discord's client-side blocking, AutoMod or third-party moderation behavior. Operators must assess those differences before enabling a channel; bot messages may be treated differently by moderation systems.
- Send/history operations use fresh REST permission checks. Live streams recheck Discord permissions every 5 seconds by default and pause delivery during revalidation; logout, channel-disable and Gateway readiness are checked before every batch. Discord permission revocation can therefore lag briefly. Set `GUILDPORT_READ_RECHECK_SECONDS=0` for fresh checks per batch. REST lookups run concurrently and share only requests still in flight. The relay targets small deployments; API throttling can still make channels unavailable.
- Live streams reconnect with bounded backoff and refresh the latest 100 messages. Longer offline gaps require explicit history pagination. Slow consumers are disconnected and asked to resync.
- Messages are not end-to-end encrypted. The relay operator and any TLS-terminating proxy provider can process plaintext. Message bodies are not stored in the relay database. Send metadata uses keyed HMAC fingerprints and is removed after 24 hours by default (cleanup every five minutes while running). See [data handling](docs/privacy.md) for retention settings, backup limits and operator responsibilities.
- Send requests have persisted idempotency IDs only within the configured retention window. An uncertain Discord delivery is never automatically replayed. Check history before sending again after a delivery error or an expired reservation.

## Development and validation

```sh
.venv/bin/python -m unittest discover -s server/tests -v
npm test --prefix cli
.venv/bin/python scripts/smoke_interactive.py
.venv/bin/python -m build server
(cd cli && npm pack --dry-run)
```

The npm tests also run the offline Python server. Override `GUILDPORT_TEST_PYTHON` if your environment is not `.venv/bin/python`. See [release instructions](docs/releasing.md) before publishing. MIT licensed; contributions are welcome.
