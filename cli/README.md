# discord-guildport

Interactive Discord community chat through a GuildPort-enabled bot. The command is **`dcgp`**.

Uses GuildPort accounts, **not Discord passwords or user tokens**. You need a running relay and a Discord server administrator to enable its channels.

```sh
npm install --global discord-guildport@latest
dcgp
```

Use ↑/↓ and Enter to log in, choose a shared server and select a channel. Menus fill one screen; type to filter servers/channels, Ctrl+U clears search, and Esc goes back. Refresh/back remain available even when nothing matches. Chat opens a full-screen view with a fixed channel header and bottom composer. Esc returns one level, Page Up / Page Down scroll, End follows the latest messages, and F2 shows IDs. New messages preserve your draft and reading position; Page Up at the top fetches older history (up to 500 messages per session). Run `/register` in Discord, read the privacy notice and accept it to obtain your GuildPort account and password. `/dcgp` privately supplies copyable login/menu commands with the URL and account filled in; passwords are entered separately at the CLI prompt.

**CLI 0.1.0** is the first release without an alpha suffix. Releases use npm’s `latest` tag. Node.js 22.13+ and a compatible relay are required; relay operators should use server 0.1.0a5 or newer for the permission-query latency fix.

Ctrl+C exits the CLI; Esc returns one level. Enter sends the draft. Left/right moves its cursor, Shift+Enter (on supported terminals) or Ctrl+J inserts a newline, and Ctrl+U clears it. Multiline bracketed paste stays in the draft until Enter. `/back` also returns from chat. No local chat archive is written; `history --json` and `watch --json` remain available for scripts.

Shift+Enter uses Kitty/CSI-u or xterm modified-key sequences. Some terminals encode Shift+Enter exactly like Enter; use Ctrl+J there, or map Shift+Enter to `\x1b[13;2u` in terminal settings.

Requires Node.js 22.13+ and an ANSI terminal for full-screen chat. The CLI is available on npm; see the [project README](https://github.com/Whiterzi/discord-guildport) for relay setup and local tarball installation.

## Scriptable commands

```sh
dcgp login --server https://relay.example.com --username gp_DISCORD_ID
dcgp whoami
dcgp guilds --json
dcgp channels GUILD_ID --json
dcgp history CHANNEL_ID --limit 30 --json
dcgp chat CHANNEL_ID
dcgp send CHANNEL_ID "Hello"
dcgp watch CHANNEL_ID --json
dcgp logout
dcgp logout --all
```

Login prompts without echoing the password; `--password-stdin` is available for scripts. The local token file is private on POSIX but not encrypted; protect your OS account and disk. Change the profile location with `GUILDPORT_CONFIG_DIR`.

Messages are not end-to-end encrypted: the relay operator and a TLS-terminating proxy provider can process plaintext. Messages are sent by the bot with sender attribution, and only administrator-enabled channels that both the user and bot can access are available. This release excludes DMs, threads and age-restricted channels. Some channels are conservatively read-only when the bot cannot establish a user's verification eligibility.

[Source, server setup and limitations](https://github.com/Whiterzi/discord-guildport) · [API](https://github.com/Whiterzi/discord-guildport/blob/main/docs/api.md) · [Data handling](https://github.com/Whiterzi/discord-guildport/blob/main/docs/privacy.md)

MIT licensed. Not affiliated with or approved by Discord.
