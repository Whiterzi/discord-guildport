# discord-guildport

Interactive Discord community chat through a GuildPort-enabled bot. The command is **`dcgp`**.

Experimental alpha. Uses GuildPort accounts, **not Discord passwords or user tokens**. You need a running relay and a Discord server administrator to enable its channels.

```sh
npm install --global discord-guildport@alpha
dcgp
```

Use ↑/↓ and Enter to log in, choose a shared server and select a channel. Type messages in chat; `/back` returns to the picker. Incoming messages preserve your current input. Run `/register` in Discord, read the privacy notice and accept it to obtain your GuildPort account and password. `/dcgp` privately supplies copyable login/menu commands with the URL and account filled in; passwords are entered separately at the CLI prompt.

Requires Node.js 22.13+. The CLI is available on npm; see the [project README](https://github.com/Whiterzi/discord-guildport) for relay setup and local tarball installation.

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

Messages are not end-to-end encrypted: the relay operator and a TLS-terminating proxy provider can process plaintext. Messages are sent by the bot with sender attribution, and only administrator-enabled channels that both the user and bot can access are available. This alpha excludes DMs, threads and age-restricted channels. Some channels are conservatively read-only when the bot cannot establish a user's verification eligibility.

[Source, server setup and limitations](https://github.com/Whiterzi/discord-guildport) · [API](https://github.com/Whiterzi/discord-guildport/blob/main/docs/api.md) · [Data handling](https://github.com/Whiterzi/discord-guildport/blob/main/docs/privacy.md)

MIT licensed. Not affiliated with or approved by Discord.
