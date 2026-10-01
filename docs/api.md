# HTTP API v1

Requests use JSON and Discord snowflakes as **strings**. All endpoints except `GET /health` and `POST /v1/login` require `Authorization: Bearer TOKEN`. Tokens in URLs are not accepted. Browser Origin requests are rejected and no CORS is enabled. Responses use `Cache-Control: no-store`.

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

Message objects include `id`, `channel_id`, `author:{id,name,bot}`, `content`, `created_at` (ISO 8601) and `attachments:[{name,url}]`. Account registration and password reset are available only through authenticated Discord interactions, not arbitrary HTTP user IDs.

Messages sent by this relay bot may also include `relay_author:{id,name}` and `relay_content` (the message without the attribution prefix). These optional fields are derived only from the relay's own non-webhook messages, including its older text format. The original bot remains in `author`; clients can display the attributed user with a `via GuildPort` badge. Clients must not infer trusted authorship from message text or arbitrary embeds. `content` retains a legacy attribution prefix, including for new cards, so alpha.1 clients still see the sender and body. Other embed-only messages expose a bounded text summary instead of an empty entry.

Errors have `{error:{code,message}}`. 401 means login/session failure, 403 inaccessible resource, 409 conflicting/uncertain request, 429 throttling/slowmode, and 503 temporarily unverifiable Discord access. Resource existence is not disclosed through privileged error detail.

SSE first emits `event: ready`. Fetch recent history after that event and deduplicate message IDs to close the subscribe/history gap. `event: relay` contains `type: message.created` with a message, or `message.updated`/`message.deleted` with a message ID. `resync_required` requires reconnect/history refresh. `event: revoked` closes a stream after permissions/session checks fail. Heartbeats are comments; there is no durable event replay or Last-Event-ID support.

The server persists a send reservation before contacting Discord. Reusing a successful request ID with identical content returns the prior message ID without sending again. Reusing it for different content/channel returns 409. A reservation without a known Discord result returns `delivery_unknown`: the message might already have been accepted. Clients must not silently send a new request ID after a timeout. Inspect history and let the user decide.

Send reservations expire after the operator's retention window (24 hours by default, configurable from 6 to 168 hours), with periodic cleanup. Idempotency is not guaranteed after that window: never automatically replay an old request, including an old UUID. Fingerprints are keyed HMACs, not stored message bodies; this does not make relay messages end-to-end encrypted.
