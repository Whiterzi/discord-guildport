# Data handling

This document describes the software's behavior; it is not a substitute for the operator's published privacy policy or required authorization.

GuildPort is **not end-to-end encrypted and does not anonymize users**. The relay process handles plaintext to interoperate with ordinary Discord messages. Its operator can read content in memory or modify the software to record it. HTTPS protects traffic in transit, not against the relay operator. If an operator uses a TLS-terminating proxy such as Cloudflare, that provider can also process plaintext. See [Cloudflare's edge/origin TLS explanation](https://developers.cloudflare.com/ssl/concepts/). Users must trust Discord, the relay operator and any such proxy provider.

`/register` shows a private notice and requires the invoking user to press an agreement button before creating an account. The notice describes the operator's configured retention period. `/relay enable` reminds administrators to inform **all channel members**, including members who do not use the CLI, about external processing. Registration consent alone does not provide that channel-wide notice.

| Data | Handling |
| --- | --- |
| Discord user ID and GuildPort username | Stored until `/relay-account delete` |
| GuildPort password | Generated for ephemeral display; only salted Argon2id hash retained |
| Session token | Raw token returned once to the CLI or set as an HttpOnly browser cookie; SHA-256 hash retained server-side; expires in seven days |
| Device label and session expiry | Stored with the session; removed on logout, reset or account deletion |
| Enabled guild/channel IDs and enabling administrator | Stored until the channel is disabled |
| Send metadata | User/channel/request IDs, keyed HMAC content fingerprint, timestamp and resulting Discord message ID; no message body. Retained for 24 hours by default, then removed at the next cleanup (normally every five minutes while running, also at startup/login) |
| Received/history message bodies | Fetched on demand or held in bounded memory queues for connected clients; not written to the server database |
| Sender display name and avatar URL | Read from the Discord member for attribution; small avatar displayed in outgoing Discord cards when permissions allow, not stored in the relay database |
| Browser chat and drafts | Current channel has at most 500 messages; up to 20 channel drafts remain in tab memory. No localStorage, sessionStorage, IndexedDB, service worker or browser message archive. State is cleared on logout, page exit and detected session/access revocation |
| CLI history output | Printed to the user's terminal; their terminal, shell piping or logging may retain it |

Account deletion cascades to sessions and send metadata. It does **not** delete messages already posted to Discord or copies saved by recipients. Operators must explain these limits and handle applicable deletion requests separately.

`GUILDPORT_DELIVERY_RETENTION_HOURS` in the supplied hosts configures send metadata retention between 6 and 168 hours; embedded hosts can pass `delivery_retention_hours`. The six-hour minimum preserves Discord's maximum slowmode window. Idempotency protection lasts only while the reservation is retained: never automatically retry an old request after the retention window. Expired sessions are removed by the same cleanup loop. Cleanup may be delayed while a host is stopped or blocked; the next startup runs cleanup before serving requests. Accounts are not removed for inactivity.

Content fingerprints use HMAC-SHA-256 over the SHA-256 hex representation of the content. The random 32-byte key is stored separately from SQLite as `<database>.hmac-key` with mode 0600. This limits dictionary guessing when **only the database** is exposed; it does not protect against anyone who can read the key or control the relay. Existing alpha.1 fingerprints are converted in place without discarding pending/successful send reservations. Keep the key with the matching database for recovery; startup rejects a missing or mismatched key. SQLite secure deletion is enabled for removed records, but this does not erase filesystem snapshots, older backups or Discord copies. Operators must apply their retention/deletion policy to backups separately.

The CLI saves a bearer token in a local session file. POSIX permissions are 0600 for the file and 0700 for its directory; the file and server SQLite database are not application-encrypted. Use OS/disk encryption and protect backups. Never commit either file.

`/dcgp` returns private, copyable commands with the relay URL and the caller's username. It never puts a password or token into a command. The password is entered at a hidden CLI prompt. A username still identifies the Discord account and may remain in shell history; terminal output can retain messages. Do not share session files or paste credentials into scripts.

Full-screen chat keeps at most 500 messages in process memory and uses the terminal's alternate screen. It does not create a local message archive. Returning from chat restores the previous terminal screen; this is not a secure erase guarantee for terminal recordings, OS memory or other copies.

The plugin disables its HTTP access log, and its request/command error logs contain exception types rather than exception text or payload-bearing tracebacks. This does **not** control logging by the host bot, Discord library, reverse proxy, OS or terminal. Operators must configure those separately. The plugin serializes live message bodies only for enabled channels with connected listeners; enabling Message Content intent still allows the host bot to receive other bot-visible guild messages through Discord's Gateway.

All channel access is authorized server-side. GuildPort checks fresh Discord roles, member data and channel overwrites, including both user and bot access. A stream performs a fresh Discord check on connection, then revalidates every 5 seconds by default, including while idle. Messages share that short-lived read grant; Discord removal/role/overwrite changes may take up to the configured interval plus the time needed to detect the change to close the stream. Delivery pauses once revalidation is due and resumes only after success; errors close the stream. Account/session revocation, the relay channel allowlist and Gateway readiness are checked locally before each transmitted batch. Sending and history requests still require fresh Discord checks. `GUILDPORT_READ_RECHECK_SECONDS` accepts 0–30 seconds; 0 requires a fresh check per queued burst. Concurrent lookups share only in-flight requests, never completed permission snapshots. Already transmitted data cannot be withdrawn. Discord state can change between a check and an API request; no distributed system can make these separate APIs atomic.

Age-restricted channels, DMs and threads are excluded. Guild verification status that cannot be verified through the bot API is treated conservatively for sending. Personal block lists and all native moderation behavior cannot be reproduced by a bot; do not advertise this as a complete Discord client or an exact mirror of all Discord safeguards.

## Browser sessions

The web client is served on the relay’s own HTTPS origin and authenticates with the same GuildPort credentials. JavaScript cannot read its HttpOnly session cookie, and login responses never expose the token to JavaScript. HTTPS cookies use Secure, SameSite=Strict and a host-only cookie prefix; write requests require an exact trusted Origin and a custom request header. These measures reduce credential exposure and cross-site request risks; they do not make messages end-to-end encrypted or prevent a malicious host operator from changing the application.

The cookie is a browser-session cookie, but browser session restore can preserve it; close-tab is not a reliable logout action. Use **Log out** on shared devices or `/relay-account logout-all` in Discord. Server-side expiry remains seven days. Password managers, browser extensions, screenshots, OS memory and recipient copies are outside GuildPort’s control. No third-party fonts, analytics or automatically loaded remote media are used. Following an attachment or message link contacts its destination.
