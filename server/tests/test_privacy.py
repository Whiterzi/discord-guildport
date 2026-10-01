import hashlib
from pathlib import Path
import tempfile
import time
import unittest

from guildport.store import Store


class PrivacyStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "state" / "relay.sqlite3"

    def open_store(self, **kwargs):
        store = Store(self.path, **kwargs)
        self.addCleanup(store.close)
        return store

    def test_delivery_fingerprint_is_keyed_and_stable_across_restart(self):
        first = Store(self.path)
        first.register("300", "unused")
        digest = first.content_digest("hello")
        first.reserve_delivery("300", "request", "200", digest)
        first.finish_delivery("300", "request", "900")
        first.close()
        restored = self.open_store()
        self.assertEqual(restored.content_digest("hello"), digest)
        self.assertEqual(restored.delivery("300", "request")["message_id"], "900")
        self.assertNotIn(hashlib.sha256(b"hello").hexdigest(), digest)
        self.assertNotEqual(restored.content_digest("different"), digest)
        other = Store(self.path.parent / "other.sqlite3")
        self.addCleanup(other.close)
        self.assertNotEqual(other.content_digest("hello"), digest)
        self.assertEqual(self.path.with_suffix(".sqlite3.hmac-key").stat().st_mode & 0o777, 0o600)
        self.assertEqual(restored.db.execute("PRAGMA secure_delete").fetchone()[0], 1)

    def test_legacy_digest_migration_preserves_uncertain_delivery(self):
        legacy = Store(self.path)
        legacy.register("300", "unused")
        legacy.reserve_delivery("300", "pending", "200", hashlib.sha256(b"hello").hexdigest())
        legacy.finish_delivery("300", "pending", "900")
        legacy.reserve_delivery("300", "uncertain", "200", hashlib.sha256(b"other").hexdigest())
        # Model an alpha.1 database, which had no key metadata.
        legacy.db.execute("DROP TABLE store_meta")
        legacy.close()
        self.path.with_suffix(".sqlite3.hmac-key").unlink()
        upgraded = self.open_store()
        self.assertEqual(upgraded.delivery("300", "pending")["content_hash"], upgraded.content_digest("hello"))
        self.assertEqual(upgraded.delivery("300", "pending")["message_id"], "900")
        self.assertIsNone(upgraded.delivery("300", "uncertain")["message_id"])
        self.assertEqual(upgraded.delivery("300", "uncertain")["content_hash"], upgraded.content_digest("other"))

    def test_missing_or_changed_key_fails_closed(self):
        Store(self.path).close()
        key = self.path.with_suffix(".sqlite3.hmac-key")
        key.write_bytes(b"x" * 32)
        with self.assertRaisesRegex(ValueError, "does not match"):
            Store(self.path)
        key.unlink()
        with self.assertRaisesRegex(ValueError, "Missing"):
            Store(self.path)

    def test_retention_removes_only_expired_records(self):
        store = self.open_store()
        store.register("300", "unused")
        fresh_token, _ = store.session("300", "fresh")
        store.session("300", "expired")
        store.db.execute("UPDATE sessions SET expires_at=0 WHERE device='expired'")
        for request in ("fresh", "expired"):
            store.reserve_delivery("300", request, "200", store.content_digest("hello"))
        store.db.execute("UPDATE deliveries SET created_at=? WHERE request_id='expired'", (time.time() - 86401,))
        store.prune()
        self.assertIsNone(store.delivery("300", "expired"))
        self.assertIsNotNone(store.delivery("300", "fresh"))
        self.assertIsNotNone(store.account("300"))
        self.assertEqual(store.authenticate(fresh_token)["discord_id"], "300")
        self.assertEqual(store.db.execute("SELECT count(*) FROM sessions").fetchone()[0], 1)

    def test_retention_cannot_undercut_maximum_slowmode(self):
        for hours in (0, 5, 169, 6.5):
            with self.assertRaises(ValueError):
                Store(self.path, delivery_retention_hours=hours)

    def test_custom_retention_is_applied_on_startup(self):
        store = Store(self.path)
        store.register("300", "unused")
        store.reserve_delivery("300", "request", "200", store.content_digest("hello"))
        with store.db:
            store.db.execute("UPDATE deliveries SET created_at=?", (time.time() - 7 * 3600,))
        store.close()
        restored = self.open_store(delivery_retention_hours=6)
        self.assertIsNone(restored.delivery("300", "request"))
