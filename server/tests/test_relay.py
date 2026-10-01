import asyncio
import hashlib
import json
from pathlib import Path
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer

from guildport.events import EventHub
from guildport.models import Access, RelayError
from guildport.server import RelayService
from guildport.store import Store, hash_password, verify_password

USER, OTHER, GUILD, CHANNEL = "300", "301", "100", "200"
PASSWORD = "test-only-random-password"
ENCODED = hash_password(PASSWORD)


class FakeAdapter:
    def __init__(self):
        self.allowed = {USER}
        self.can_send = True
        self.slowmode = 0
        self.sent = []
        self.fail_send = False
        self.revoke_on_history = False
        self.before = None

    async def authorize(self, user_id, guild_id, channel_id, *, for_send=False):
        if user_id not in self.allowed:
            raise RelayError(403, "access_denied", "No access.")
        return Access(guild_id, "Test Guild", channel_id, "general", "Alice", self.can_send, self.slowmode)

    async def history(self, access, limit, before):
        self.before = before
        if self.revoke_on_history:
            self.allowed.clear()
        return [{"id": "900", "content": "private message"}]

    async def send(self, access, user_id, content):
        await asyncio.sleep(0.01)
        self.sent.append((user_id, content))
        if self.fail_send:
            raise OSError("network dropped after Discord accepted the request")
        return {"id": str(900 + len(self.sent))}


class RelayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name)/"state"/"relay.sqlite3")
        self.store.register(USER, ENCODED)
        self.store.register(OTHER, ENCODED)
        self.store.enable(GUILD, CHANNEL, USER)
        self.token, _ = self.store.session(USER, "test")
        self.other_token, _ = self.store.session(OTHER, "test")
        self.headers = {"Authorization": "Bearer " + self.token}
        self.adapter = FakeAdapter()
        self.service = RelayService(self.store, self.adapter, heartbeat=0.03, prune_interval=0.03)
        self.client = TestClient(TestServer(self.service.application()))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.store.close()
        self.tmp.cleanup()

    async def get(self, path, headers=None):
        return await self.client.get(path, headers=self.headers if headers is None else headers)

    async def send(self, content="hello", request_id=None, channel=CHANNEL):
        return await self.client.post(f"/v1/channels/{channel}/messages", headers=self.headers,
            json={"content": content, "request_id": request_id or str(uuid.uuid4())})

    async def test_login_issues_hashed_session_and_no_password(self):
        response = await self.client.post("/v1/login", json={"username": "gp_300", "password": PASSWORD})
        self.assertEqual(response.status, 200)
        data = await response.json()
        self.assertNotIn("password", data)
        self.assertEqual(self.store.authenticate(data["token"])["discord_id"], USER)
        row = self.store.db.execute("SELECT token_hash FROM sessions WHERE token_hash=?",
            (hashlib.sha256(data["token"].encode()).hexdigest(),)).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    async def test_login_does_not_enumerate_accounts(self):
        results = []
        for name in ("gp_300", "missing"):
            response = await self.client.post("/v1/login", json={"username": name, "password": "wrong"})
            self.assertEqual(response.status, 401)
            results.append(await response.json())
        self.assertEqual(*results)

    async def test_login_rate_limit(self):
        for _ in range(10):
            self.service.limits.check("login-name:gp_300", 10, 60)
        response = await self.client.post("/v1/login", json={"username": "gp_300", "password": PASSWORD})
        self.assertEqual(response.status, 429)

    async def test_idle_service_prunes_without_login_or_requests(self):
        self.store.reserve_delivery(USER, "expired", CHANNEL, self.store.content_digest("hello"))
        self.store.db.execute("UPDATE deliveries SET created_at=0")
        self.store.db.execute("UPDATE sessions SET expires_at=0")
        deadline = asyncio.get_running_loop().time() + 2
        while self.store.delivery(USER, "expired") and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.01)
        self.assertIsNone(self.store.delivery(USER, "expired"))
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM sessions").fetchone()[0], 0)

    async def test_unexpected_error_does_not_log_payload_or_traceback(self):
        with patch.object(self.adapter, "authorize", side_effect=RuntimeError("SECRET_BODY_AND_TOKEN")):
            with self.assertLogs("guildport.server", level="ERROR") as logs:
                response = await self.get(f"/v1/channels/{CHANNEL}/messages")
        self.assertEqual(response.status, 500)
        self.assertNotIn("SECRET_BODY_AND_TOKEN", str(logs.output))
        self.assertNotIn("SECRET_BODY_AND_TOKEN", await response.text())
        self.assertIn("RuntimeError", str(logs.output))

    async def test_authentication_required_and_query_token_rejected(self):
        for path in ("/v1/guilds", f"/v1/guilds?token={self.token}"):
            response = await self.get(path, {})
            self.assertEqual(response.status, 401)

    async def test_expired_and_revoked_session(self):
        self.store.db.execute("UPDATE sessions SET expires_at=0")
        self.assertEqual((await self.get("/v1/me")).status, 401)
        token, _ = self.store.session(USER, "another")
        self.store.revoke(token)
        with self.assertRaises(RelayError):
            self.store.authenticate(token)

    async def test_reset_revokes_all_devices(self):
        self.store.reset(USER, ENCODED)
        self.assertEqual((await self.get("/v1/me")).status, 401)
        self.assertEqual(self.store.authenticate(self.other_token)["discord_id"], OTHER)

    async def test_account_delete_cascades_and_re_registers(self):
        self.store.reserve_delivery(USER, str(uuid.uuid4()), CHANNEL, "digest")
        self.store.delete_account(USER)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM deliveries").fetchone()[0], 0)
        self.assertEqual((await self.get("/v1/me")).status, 401)
        self.store.register(USER, ENCODED)

    async def test_browser_origin_rejected(self):
        response = await self.get("/v1/guilds", dict(self.headers, Origin="https://evil.example"))
        self.assertEqual(response.status, 403)

    async def test_guilds_and_channels_do_not_leak_to_other_member(self):
        response = await self.get("/v1/guilds")
        self.assertEqual((await response.json())["guilds"], [{"id": GUILD, "name": "Test Guild"}])
        headers = {"Authorization": "Bearer " + self.other_token}
        response = await self.get("/v1/guilds", headers)
        self.assertEqual((await response.json())["guilds"], [])
        response = await self.get(f"/v1/guilds/{GUILD}/channels", headers)
        self.assertEqual((await response.json())["channels"], [])
        response = await self.get(f"/v1/channels/{CHANNEL}/messages", headers)
        self.assertEqual(response.status, 403)

    async def test_allowlist_is_deny_by_default(self):
        self.store.disable(CHANNEL)
        self.assertEqual((await self.get(f"/v1/channels/{CHANNEL}/messages")).status, 403)
        self.assertEqual((await self.send()).status, 403)

    async def test_history_permission_revocation_during_fetch(self):
        self.adapter.revoke_on_history = True
        response = await self.get(f"/v1/channels/{CHANNEL}/messages")
        self.assertEqual(response.status, 403)
        self.assertNotIn("private message", await response.text())

    async def test_history_pagination_and_validation(self):
        response = await self.get(f"/v1/channels/{CHANNEL}/messages?limit=5&before=900")
        self.assertEqual(response.status, 200)
        self.assertEqual(self.adapter.before, "900")
        for query in ("limit=0", "limit=101", "limit=no", "before=bad"):
            self.assertEqual((await self.get(f"/v1/channels/{CHANNEL}/messages?{query}")).status, 400)

    async def test_send_uses_authenticated_identity(self):
        response = await self.send()
        self.assertEqual(response.status, 201)
        self.assertEqual(self.adapter.sent, [(USER, "hello")])
        response = await self.client.post(f"/v1/channels/{CHANNEL}/messages", headers=self.headers,
            json={"content": "hello", "request_id": str(uuid.uuid4()), "user_id": OTHER})
        self.assertEqual(response.status, 400)

    async def test_send_read_only_and_slowmode(self):
        self.adapter.can_send = False
        self.assertEqual((await self.send()).status, 403)
        self.adapter.can_send = True
        self.adapter.slowmode = 60
        self.assertEqual((await self.send()).status, 201)
        self.assertEqual((await self.send()).status, 429)
        self.assertEqual(len(self.adapter.sent), 1)

    async def test_concurrent_duplicate_send_is_not_repeated(self):
        request_id = str(uuid.uuid4())
        responses = await asyncio.gather(self.send(request_id=request_id), self.send(request_id=request_id))
        self.assertEqual(sorted(r.status for r in responses), [200, 201])
        self.assertEqual(len(self.adapter.sent), 1)

    async def test_request_id_cannot_change_content_or_channel(self):
        request_id = str(uuid.uuid4())
        await self.send(request_id=request_id)
        self.assertEqual((await self.send("different", request_id)).status, 409)
        self.store.enable(GUILD, "201", USER)
        self.assertEqual((await self.send(request_id=request_id, channel="201")).status, 409)

    async def test_unknown_delivery_is_never_retried_automatically(self):
        request_id = str(uuid.uuid4())
        self.adapter.fail_send = True
        self.assertEqual((await self.send(request_id=request_id)).status, 502)
        self.assertEqual((await self.send(request_id=request_id)).status, 409)
        self.assertEqual(len(self.adapter.sent), 1)

    async def test_successful_retry_still_checks_current_permissions(self):
        request_id = str(uuid.uuid4())
        await self.send(request_id=request_id)
        self.adapter.allowed.clear()
        self.assertEqual((await self.send(request_id=request_id)).status, 403)

    async def test_malformed_body(self):
        for content in ("", " " * 20, "x" * 1801):
            self.assertEqual((await self.send(content)).status, 400)
        self.assertEqual((await self.send(request_id="invalid")).status, 400)
        response = await self.client.post("/v1/login", data="{}")
        self.assertEqual(response.status, 415)

    async def read_frame(self, response):
        return (await asyncio.wait_for(response.content.readuntil(b"\n\n"), 2)).decode()

    async def test_stream_delivers_only_authorized_channel(self):
        response = await self.get(f"/v1/channels/{CHANNEL}/events")
        self.assertIn("event: ready", await self.read_frame(response))
        self.service.hub.publish("201", {"type": "message.created", "message": {"content": "secret"}})
        self.service.hub.publish(CHANNEL, {"type": "message.created", "message": {"content": "visible"}})
        frame = await self.read_frame(response)
        self.assertIn("visible", frame)
        self.assertNotIn("secret", frame)
        response.close()

    async def test_stream_rechecks_each_message(self):
        response = await self.get(f"/v1/channels/{CHANNEL}/events")
        await self.read_frame(response)
        self.adapter.allowed.clear()
        self.service.hub.publish(CHANNEL, {"type": "message.created", "message": {"content": "secret"}})
        frame = await self.read_frame(response)
        self.assertIn("event: revoked", frame)
        self.assertNotIn("secret", frame)
        response.close()

    async def test_idle_stream_revoked_on_logout(self):
        response = await self.get(f"/v1/channels/{CHANNEL}/events")
        await self.read_frame(response)
        self.store.revoke(self.token)
        self.assertIn("event: revoked", await self.read_frame(response))
        response.close()

    async def test_idle_stream_revoked_on_channel_disable(self):
        response = await self.get(f"/v1/channels/{CHANNEL}/events")
        await self.read_frame(response)
        self.store.disable(CHANNEL)
        self.assertIn("event: revoked", await self.read_frame(response))
        response.close()

    async def test_stream_limit(self):
        streams = [await self.get(f"/v1/channels/{CHANNEL}/events") for _ in range(3)]
        response = await self.get(f"/v1/channels/{CHANNEL}/events")
        self.assertEqual(response.status, 429)
        for stream in streams:
            stream.close()


class StoreTests(unittest.IsolatedAsyncioTestCase):
    def test_password_hash_is_salted(self):
        other = hash_password(PASSWORD)
        self.assertNotEqual(ENCODED, other)
        self.assertTrue(verify_password(PASSWORD, other))
        self.assertFalse(verify_password("wrong", other))
        self.assertFalse(verify_password(PASSWORD, "broken"))

    async def test_queue_overflow_requires_resync(self):
        hub = EventHub()
        queue = hub.subscribe(CHANNEL)
        for n in range(101):
            hub.publish(CHANNEL, {"type": "message.created", "id": n})
        self.assertEqual(queue.get_nowait()["type"], "resync_required")
        hub.unsubscribe(CHANNEL, queue)
        self.assertEqual(hub.listeners, {})

    def test_persistence_and_permissions(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)/"state"/"relay.sqlite3"
            store = Store(path)
            store.register(USER, ENCODED)
            token, _ = store.session(USER, "test")
            store.enable(GUILD, CHANNEL, USER)
            store.close()
            store = Store(path)
            try:
                self.assertEqual(store.authenticate(token)["discord_id"], USER)
                self.assertIsNotNone(store.channel(CHANNEL))
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
            finally:
                store.close()
