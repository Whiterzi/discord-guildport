# HTTP API v1

Requests use JSON and Discord snowflakes as **strings**. All endpoints except `GET /health` and `POST /v1/login` require `Authorization: Bearer TOKEN`. Tokens in URLs are not accepted. Browser Origin requests are rejected on `/v1`; no CORS is enabled. The same-origin web client uses the separate `/web-api` transport described below. Responses use `Cache-Control: no-store`.

| Method/path | Request / response |
| --- | --- |
| `POST /v1/login` | `{username,password,device?}` → `{token,expires_at,user}` |
| `GET /v1/me` | `{discord_id,username,expires_at}` |
| `POST /v1/logout` | Revoke current session |
| `POST /v1/logout-all` | Revoke all current user's sessions |
| `GET /v1/guilds` | `{guilds:[{id,name}]}`; enabled accessible guilds only |
| `GET /v1/guilds/{id}/channels` | `{channels:[{id,guild_id,name,can_send,slowmode_seconds,send_block_reason}]}` |
| `GET /v1/channels/{id}/messages?limit=30&before=ID` | `{messages:[...]}` in chronological order; limit 1–100 |
| `POST /v1/channels/{id}/messages` | `{content,request_id}` → `{id,channel_id}`; content max 1800 characters; canonical UUID request ID |
| `GET /v1/channels/{id}/events` | Authenticated SSE stream |
| `GET /v1/channels/{id}/emojis` | `{emojis:[{id,name,animated}]}`; current guild's available emoji usable by both user and bot |

Message objects include `id`, `channel_id`, `author:{id,name,bot}`, `content`, `created_at` (ISO 8601) and `attachments:[{name,url,spoiler?}]`. Honor `spoiler` even without a `SPOILER_` filename prefix. Optional `media:[{url,proxy_url?}]` holds up to 20 deduplicated embed image/thumbnail URLs from that authorized message. Discord may supply fresh signed URLs here while message text retains unsigned/expired URLs; clients can match the exact attachment path on Discord CDN hosts and preserve its signature. This is not an arbitrary URL refresh service. Account registration and password reset are available only through authenticated Discord interactions, not arbitrary HTTP user IDs.

The emoji catalog rechecks channel access after fetching, requires send permission and filters emoji role restrictions against both members' fresh roles. It is limited to 30 requests per user per minute, in addition to the common API limit. It does not send a message: insert `<:name:id>` or `<a:name:id>` into a normal send request. The browser transport also exposes `/web-api/channels/{id}/emojis`. Older custom adapters must implement `emojis(access)` to support the picker; catalog entries provide `id`, `name`, `animated`, optional `available`, and raw role IDs in `roles` for filtering.

Messages sent by this relay bot may also include `relay_author:{id,name}` and `relay_content` (the message without the attribution prefix). These optional fields are derived only from the relay's own non-webhook messages, including its older text format. The original bot remains in `author`; clients can display the attributed user with a `via GuildPort` badge. Clients must not infer trusted authorship from message text or arbitrary embeds. `content` retains a legacy attribution prefix, including for new cards, so alpha.1 clients still see the sender and body. Other embed-only messages expose a bounded text summary instead of an empty entry.

Errors have `{error:{code,message}}`. 401 means login/session failure, 403 inaccessible resource, 409 conflicting/uncertain request, 429 throttling/slowmode, and 503 temporarily unverifiable Discord access. Resource existence is not disclosed through privileged error detail.

SSE first emits `event: ready`. Fetch recent history after that event and deduplicate message IDs to close the subscribe/history gap. `event: relay` contains `type: message.created` with a message, or `message.updated`/`message.deleted` with a message ID. `resync_required` requires reconnect/history refresh. `event: revoked` closes a stream after permissions/session checks fail. Live read permissions are revalidated every 5 seconds by default (operator configurable); delivery pauses during revalidation. Session/channel-disable checks run before every batch, while send/history use fresh Discord checks. Heartbeats are comments; there is no durable event replay or Last-Event-ID support.

The server persists a send reservation before contacting Discord. Reusing a successful request ID with identical content returns the prior message ID without sending again. Reusing it for different content/channel returns 409. A reservation without a known Discord result returns `delivery_unknown`: the message might already have been accepted. Clients must not silently send a new request ID after a timeout. Inspect history and let the user decide.

Send reservations expire after the operator's retention window (24 hours by default, configurable from 6 to 168 hours), with periodic cleanup. Idempotency is not guaranteed after that window: never automatically replay an old request, including an old UUID. Fingerprints are keyed HMACs, not stored message bodies; this does not make relay messages end-to-end encrypted.

## Browser transport (server 0.1.0a6+)

The relay serves its built web application at `/`, `/favicon.svg` and allowlisted `/assets/{name}` paths. `/web-api` mirrors the `/v1` operations and their permission checks, throttles and SSE behavior. It is enabled only with an explicit browser origin; `RelayPlugin` uses its validated `public_url`. The browser never chooses an arbitrary relay URL.

Every browser API request must include `X-GuildPort-Client: web`. Mutations must carry an `Origin` exactly equal to the configured public origin; any supplied Origin must match even for reads. Cross-site and same-site-but-different-origin `Sec-Fetch-Site` requests are rejected, as are cross-origin preflights. The server does not infer a trusted origin from Host or forwarded headers.

`POST /web-api/login` accepts the same account/password and returns only `{user,expires_at}`. The session token is delivered in a host-only `__Host-guildport_session` cookie with Secure, HttpOnly, SameSite=Strict and Path=/ (loopback HTTP demos use `guildport_session` without Secure). It has no persistent expiry; browser session restoration may still retain it. Server expiry remains seven days. Logging in rotates the current browser session. `/web-api/logout` revokes and clears the cookie, including if it already expired; `/web-api/logout-all` also revokes CLI sessions. Browser endpoints ignore Authorization headers and query tokens; `/v1` continues to ignore cookies.

The browser uses authenticated fetch streaming rather than putting a token into an EventSource URL. The application has a restrictive CSP, disallows framing, uses no external scripts/fonts/analytics, disables referrers, and serves no-store responses. Message HTML is rendered as text, with bounded formatting; attachment links require HTTP(S) and are never fetched automatically.
