from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, suppress
import json
import logging
import re
import time
import uuid

from aiohttp import web

from .events import EventHub
from .models import Adapter, RelayError
from .store import Store, hash_password, verify_password

LOG = logging.getLogger(__name__)


class RateLimit:
    def __init__(self):
        self.entries = {}

    def check(self, key: str, count: int, seconds: int):
        now = time.monotonic()
        self.entries = {k: v for k, v in self.entries.items() if v[1] > now}
        used, expiry = self.entries.get(key, (0, now + seconds))
        if used >= count or (key not in self.entries and len(self.entries) >= 10000):
            raise RelayError(429, "rate_limited", "Too many requests. Try again later.")
        self.entries[key] = (used + 1, expiry)


def snowflake(value: str) -> str:
    if not re.fullmatch(r"[1-9][0-9]{0,19}", value) or int(value) >= 2**64:
        raise RelayError(400, "invalid_id", "Expected a Discord ID as a decimal string.")
    return value


async def body(request, fields):
    if request.content_type != "application/json":
        raise RelayError(415, "invalid_content_type", "Use application/json.")
    try:
        data = await request.json()
    except (ValueError, UnicodeError):
        raise RelayError(400, "invalid_json", "Invalid JSON.")
    if not isinstance(data, dict) or set(data) - set(fields):
        raise RelayError(400, "invalid_body", "Unexpected request fields.")
    return data


def string(data, key, maximum, default=None):
    value = data.get(key, default)
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise RelayError(400, "invalid_body", f"Invalid {key}.")
    return value


def bearer(request):
    value = request.headers.get("Authorization", "")
    return value[7:] if value.startswith("Bearer ") else ""


class RelayService:
    def __init__(self, store: Store, adapter: Adapter, hub=None, heartbeat=10, prune_interval=300):
        if prune_interval <= 0:
            raise ValueError("prune_interval must be positive.")
        self.store, self.adapter = store, adapter
        self.hub = hub or EventHub()
        self.heartbeat = heartbeat
        self.prune_interval = prune_interval
        self.limits = RateLimit()
        self.password_slots = asyncio.Semaphore(4)
        self.dummy_hash = hash_password("invalid-account-dummy-password")
        self.streams = {}
        self.send_locks = {}
        self.closing = False

    @asynccontextmanager
    async def send_lock(self, key):
        lock, users = self.send_locks.get(key, (asyncio.Lock(), 0))
        self.send_locks[key] = (lock, users + 1)
        try:
            async with lock:
                yield
        finally:
            _, users = self.send_locks[key]
            if users == 1:
                del self.send_locks[key]
            else:
                self.send_locks[key] = (lock, users - 1)

    async def access(self, user_id, channel_id, *, for_send=False):
        row = self.store.channel(snowflake(channel_id))
        if row is None:
            raise RelayError(403, "channel_unavailable", "Channel is not available through this relay.")
        access = await self.adapter.authorize(user_id, row["guild_id"], channel_id, for_send=for_send)
        # The allowlist may change while the Discord request is in flight.
        if self.store.channel(channel_id) is None:
            raise RelayError(403, "channel_unavailable", "Channel is no longer enabled.")
        return access

    async def login(self, request):
        data = await body(request, {"username", "password", "device"})
        name = string(data, "username", 80)
        password = string(data, "password", 256)
        device = string(data, "device", 80, "CLI")
        self.limits.check("login-ip:" + (request.remote or "unknown"), 40, 60)
        self.limits.check("login-name:" + name, 10, 60)
        if self.password_slots.locked():
            raise RelayError(503, "busy", "Login service is busy. Try again shortly.")
        account = self.store.account_by_name(name)
        encoded = account["password_hash"] if account else self.dummy_hash
        async with self.password_slots:
            valid = await asyncio.to_thread(verify_password, password, encoded)
        latest = self.store.account_by_name(name)
        if not valid or latest is None or latest["password_hash"] != encoded:
            raise RelayError(401, "invalid_login", "Incorrect account or password.")
        token, expires = self.store.session(latest["discord_id"], device)
        return web.json_response({"token": token, "expires_at": expires,
                                  "user": {"discord_id": latest["discord_id"], "username": name}})

    async def me(self, request):
        return web.json_response(request["user"])

    async def logout(self, request):
        self.store.revoke(bearer(request))
        return web.json_response({"ok": True})

    async def logout_all(self, request):
        self.store.revoke_all(request["user"]["discord_id"])
        return web.json_response({"ok": True})

    async def available(self, user_id, guild_id=None):
        result = []
        for row in self.store.channels(guild_id):
            try:
                access = await self.access(user_id, row["channel_id"])
                result.append(access)
            except RelayError as error:
                if error.status not in (403, 404):
                    raise
        return result

    async def guilds(self, request):
        items = await self.available(request["user"]["discord_id"])
        self.store.authenticate(bearer(request))
        guilds = {a.guild_id: {"id": a.guild_id, "name": a.guild_name} for a in items}
        return web.json_response({"guilds": list(guilds.values())})

    async def channels(self, request):
        guild_id = snowflake(request.match_info["guild_id"])
        items = await self.available(request["user"]["discord_id"], guild_id)
        self.store.authenticate(bearer(request))
        return web.json_response({"channels": [
            {"id": a.channel_id, "guild_id": a.guild_id, "name": a.channel_name,
             "can_send": a.can_send, "slowmode_seconds": a.slowmode,
             "send_block_reason": a.send_block_reason} for a in items]})

    async def history(self, request):
        try:
            limit = int(request.query.get("limit", "30"))
        except ValueError:
            raise RelayError(400, "invalid_limit", "Limit must be between 1 and 100.")
        if not 1 <= limit <= 100:
            raise RelayError(400, "invalid_limit", "Limit must be between 1 and 100.")
        before = request.query.get("before")
        if before:
            snowflake(before)
        user_id, channel_id = request["user"]["discord_id"], request.match_info["channel_id"]
        access = await self.access(user_id, channel_id)
        messages = await self.adapter.history(access, limit, before)
        # Recheck after the fetch, before disclosing data or returning a cached result.
        await self.access(user_id, channel_id)
        self.store.authenticate(bearer(request))
        return web.json_response({"messages": messages})

    async def send(self, request):
        data = await body(request, {"content", "request_id"})
        content = string(data, "content", 1800)
        if not content.strip():
            raise RelayError(400, "empty_message", "Message cannot be empty.")
        request_id = string(data, "request_id", 36)
        try:
            if str(uuid.UUID(request_id)) != request_id:
                raise ValueError()
        except ValueError:
            raise RelayError(400, "invalid_request_id", "request_id must be a canonical UUID.")
        user_id, channel_id = request["user"]["discord_id"], request.match_info["channel_id"]
        digest = self.store.content_digest(content)
        async with self.send_lock(user_id):
            access = await self.access(user_id, channel_id, for_send=True)
            self.store.authenticate(bearer(request))
            if not access.can_send:
                raise RelayError(403, "cannot_send", access.send_block_reason or "You cannot send messages in this channel.")
            previous = self.store.delivery(user_id, request_id)
            if previous:
                if previous["channel_id"] != channel_id or previous["content_hash"] != digest:
                    raise RelayError(409, "request_conflict", "Request ID was used for different content.")
                if previous["message_id"]:
                    return web.json_response({"id": previous["message_id"], "channel_id": channel_id})
                raise RelayError(409, "delivery_unknown", "Delivery outcome is unknown. Check channel history before sending again.")
            if time.time() < self.store.last_send(user_id, channel_id) + access.slowmode:
                raise RelayError(429, "slowmode", "Channel slowmode is active. Wait before sending again.")
            self.limits.check("send:" + user_id, 20, 60)
            self.store.reserve_delivery(user_id, request_id, channel_id, digest)
            try:
                message = await self.adapter.send(access, user_id, content)
            except Exception:
                # A network error can happen after Discord accepted the message.
                # Persist the pending reservation and never automatically replay it.
                raise RelayError(502, "delivery_unknown", "Delivery outcome is unknown. Check channel history before sending again.")
            self.store.finish_delivery(user_id, request_id, message["id"])
            return web.json_response({"id": message["id"], "channel_id": channel_id}, status=201)

    async def events(self, request):
        user_id, channel_id = request["user"]["discord_id"], request.match_info["channel_id"]
        await self.access(user_id, channel_id)
        self.store.authenticate(bearer(request))
        if self.streams.get(user_id, 0) >= 3 or sum(self.streams.values()) >= 50:
            raise RelayError(429, "stream_limit", "Too many active streams.")
        self.streams[user_id] = self.streams.get(user_id, 0) + 1
        queue = self.hub.subscribe(channel_id)
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream",
            "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff"})
        try:
            await response.prepare(request)
            await response.write(b'event: ready\ndata: {}\n\n')
            while not self.closing:
                try:
                    event = await asyncio.wait_for(queue.get(), self.heartbeat)
                except asyncio.TimeoutError:
                    event = None
                try:
                    self.store.authenticate(bearer(request))
                    await self.access(user_id, channel_id)
                    self.store.authenticate(bearer(request))
                except RelayError as error:
                    await response.write(("event: revoked\ndata: " + json.dumps({"code": error.code}) + "\n\n").encode())
                    break
                if event is None:
                    await response.write(b": heartbeat\n\n")
                else:
                    await response.write(("event: relay\ndata: " + json.dumps(event) + "\n\n").encode())
                    if event["type"] == "resync_required":
                        break
        except (ConnectionError, asyncio.CancelledError):
            pass
        finally:
            self.hub.unsubscribe(channel_id, queue)
            self.streams[user_id] -= 1
            if not self.streams[user_id]:
                del self.streams[user_id]
        return response

    def application(self):
        @web.middleware
        async def boundary(request, handler):
            try:
                if request.headers.get("Origin"):
                    raise RelayError(403, "browser_origin", "This API accepts CLI clients only.")
                if self.closing:
                    raise RelayError(503, "shutting_down", "Relay is shutting down.")
                if request.path not in ("/health", "/v1/login"):
                    request["user"] = self.store.authenticate(bearer(request))
                    self.limits.check("api:" + request["user"]["discord_id"], 120, 60)
                response = await handler(request)
            except RelayError as error:
                response = web.json_response({"error": {"code": error.code, "message": error.message}}, status=error.status)
            except web.HTTPException as error:
                response = web.json_response({"error": {"code": "http_error", "message": error.reason}}, status=error.status)
            except Exception as error:
                # Exception strings/tracebacks may contain upstream payloads or URLs.
                LOG.error("Relay request failed (%s)", type(error).__name__)
                response = web.json_response({"error": {"code": "internal_error", "message": "Relay request failed."}}, status=500)
            if not response.prepared:
                response.headers["Cache-Control"] = "no-store"
                response.headers["X-Content-Type-Options"] = "nosniff"
            return response

        app = web.Application(middlewares=[boundary], client_max_size=16 * 1024)
        async def cleanup_expired():
            while True:
                await asyncio.sleep(self.prune_interval)
                try:
                    self.store.prune()
                except Exception as error:
                    LOG.error("Relay retention cleanup failed (%s)", type(error).__name__)

        async def retention(app):
            task = asyncio.create_task(cleanup_expired())
            try:
                yield
            finally:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
        app.cleanup_ctx.append(retention)
        async def health(request):
            return web.json_response({"service": "guildport", "api_version": 1})
        app.add_routes([
            web.get("/health", health), web.post("/v1/login", self.login),
            web.get("/v1/me", self.me), web.post("/v1/logout", self.logout),
            web.post("/v1/logout-all", self.logout_all), web.get("/v1/guilds", self.guilds),
            web.get("/v1/guilds/{guild_id}/channels", self.channels),
            web.get("/v1/channels/{channel_id}/messages", self.history),
            web.post("/v1/channels/{channel_id}/messages", self.send),
            web.get("/v1/channels/{channel_id}/events", self.events),
        ])
        async def shutdown(app):
            self.closing = True
            for channel_id in list(self.hub.listeners):
                self.hub.publish(channel_id, {"type": "resync_required"})
        app.on_shutdown.append(shutdown)
        return app
