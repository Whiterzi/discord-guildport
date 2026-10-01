# Deployment

The standalone host reads these environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `DISCORD_TOKEN` | Bot token, never a user token | required |
| `GUILDPORT_PUBLIC_URL` | HTTPS origin shown during registration | `http://127.0.0.1:8769` |
| `GUILDPORT_PORT` | Loopback API port | `8769` |
| `GUILDPORT_DATABASE` | SQLite file in a dedicated directory | `.runtime/relay/relay.sqlite3` |
| `GUILDPORT_DELIVERY_RETENTION_HOURS` | Send metadata retention, integer 6–168 hours | `24` |
| `GUILDPORT_READ_RECHECK_SECONDS` | Live-read permission interval, 0–30 seconds; 0 checks each batch. Send/history stay fresh. | `5` |
| `GUILDPORT_TEST_GUILD` | Guild-scoped development command sync | global commands |

Supply them through your service manager or secure environment loader. The standalone host does not automatically load `.env`. Keep the working directory fixed so relative database paths remain stable.

The API only listens on IPv4 loopback. Put an HTTPS reverse proxy in front of it. Minimal Nginx location configuration (inside an existing TLS server):

```nginx
location / {
    proxy_pass http://127.0.0.1:8769;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 75s;
    client_max_body_size 16k;
    proxy_set_header Host $host;
}
```

Do not expose the checkout, SQLite files or bot environment as static files. Disable/redact request body and Authorization logging. TLS, encrypted storage/backups, an operator privacy policy, user support and deletion handling are deployment responsibilities.

Relay messages are not end-to-end encrypted. The relay operator and a TLS-terminating proxy provider can process plaintext. Keep proxy caching disabled for the entire API, including authenticated history and event streams; responses carry `Cache-Control: no-store`. Do not enable proxy body logging or use a cache-everything override. The plugin's HTTP access log is disabled; upstream and host logs require separate configuration.

Send metadata is pruned every five minutes while running and at startup/login. The retention default is 24 hours; accounts remain until explicitly deleted. The store creates a private `<database>.hmac-key` beside SQLite. Back up and restore them together under the same access controls, with a separate backup expiry/deletion policy. The key does not encrypt messages or protect against the host operator. See [data handling](privacy.md).

Limits are conservative: 3 streams per user, 50 streams per instance, 120 API calls per minute per account, 20 sends per minute per account, plus login throttling. Client IP headers are not trusted. A reverse proxy makes the IP login bucket shared (40/minute); do not raise limits or trust forwarded headers without implementing a trusted-proxy boundary.

This release uses one process and one SQLite database. Do not run multiple workers against the same bot/relay state: stream fanout, throttles and send serialization are process-local. Transient message queues are bounded; no persistent message archive is created.

## Before enabling a real server

Use a test bot/guild to verify slash command visibility, Message Content access, ephemeral credentials, member removal, channel denies, timeout, slowmode, HTTPS streaming and host restart. Automated tests do not substitute for this live integration check. Administrator opt-in must describe external message processing; bot installation for another feature is insufficient.

Use Discord's official Bot API. Review the [Developer Policy](https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy) and [Developer Terms](https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service), including permission, API-data sharing and retention restrictions, for your deployment. This code does not grant platform approval.
