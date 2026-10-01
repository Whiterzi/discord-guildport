# Data handling

This document describes the software's behavior; it is not a substitute for the operator's published privacy policy or required authorization.

| Data | Handling |
| --- | --- |
| Discord user ID and GuildPort username | Stored until `/relay-account delete` |
| GuildPort password | Generated for ephemeral display; only salted Argon2id hash retained |
| Session token | Raw token returned once to the CLI; SHA-256 hash retained server-side; expires in seven days |
| Device label and session expiry | Stored with the session; removed on logout, reset or account deletion |
| Enabled guild/channel IDs and enabling administrator | Stored until the channel is disabled |
| Send metadata | User/channel/request IDs, content SHA-256 digest, timestamp and resulting Discord message ID; no message body. Old entries are pruned after 30 days at startup/login |
| Received/history message bodies | Fetched on demand or held in bounded memory queues for connected clients; not written to the server database |
| CLI history output | Printed to the user's terminal; their terminal, shell piping or logging may retain it |

Account deletion cascades to sessions and send metadata. It does **not** delete messages already posted to Discord or copies saved by recipients. Operators must explain these limits and handle applicable deletion requests separately.

The CLI saves a bearer token in a local session file. POSIX permissions are 0600 for the file and 0700 for its directory; the file and server SQLite database are not application-encrypted. Use OS/disk encryption and protect backups. Never commit either file.

All channel access is authorized server-side. GuildPort checks fresh Discord roles, member data and channel overwrites, including both user and bot access. Each streamed event is checked before transmission; idle streams revalidate approximately every 10 seconds. Already transmitted data cannot be withdrawn. Discord state can change between a check and an API request; no distributed system can make these separate APIs atomic.

Age-restricted channels, DMs and threads are excluded. Guild verification status that cannot be verified through the bot API is treated conservatively for sending. Personal block lists and all native moderation behavior cannot be reproduced by a bot; do not advertise this as a complete Discord client or an exact mirror of all Discord safeguards.
