from __future__ import annotations

import hashlib
import hmac
import os
from pathlib import Path
import secrets
import sqlite3
import time

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, InvalidHashError

from .models import RelayError


PASSWORD_HASHER = PasswordHasher(time_cost=2, memory_cost=65536, parallelism=1)


def hash_password(password: str) -> str:
    return PASSWORD_HASHER.hash(password)


def verify_password(password: str, encoded: str) -> bool:
    try:
        return PASSWORD_HASHER.verify(encoded, password)
    except (VerificationError, InvalidHashError, ValueError, TypeError):
        return False


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Store:
    def __init__(self, path: Path, session_seconds: int = 7 * 86400,
                 delivery_retention_hours: int = 24):
        # Retain enough slowmode state for Discord's maximum six-hour slowmode.
        if not isinstance(delivery_retention_hours, int) or not 6 <= delivery_retention_hours <= 168:
            raise ValueError("delivery_retention_hours must be an integer between 6 and 168.")
        self.delivery_retention_hours = delivery_retention_hours
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        # This directory must be dedicated to relay state, not the project root.
        os.chmod(path.parent, 0o700)
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        os.chmod(path, 0o600)
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA secure_delete=ON")
        self.session_seconds = session_seconds
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS accounts (
                discord_id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL, created_at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY, discord_id TEXT NOT NULL
                REFERENCES accounts(discord_id) ON DELETE CASCADE,
                device TEXT NOT NULL, expires_at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS channels (
                channel_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL,
                enabled_by TEXT NOT NULL, created_at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS deliveries (
                request_id TEXT NOT NULL, discord_id TEXT NOT NULL
                REFERENCES accounts(discord_id) ON DELETE CASCADE,
                channel_id TEXT NOT NULL, content_hash TEXT NOT NULL,
                message_id TEXT, created_at REAL NOT NULL,
                PRIMARY KEY(discord_id, request_id));
            CREATE INDEX IF NOT EXISTS delivery_channel ON deliveries(discord_id, channel_id);
            CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """)
        try:
            self.prune()
            self._load_digest_key(path.with_suffix(path.suffix + ".hmac-key"))
            # Upgrade old SHA-256 fingerprints without losing pending reservations.
            # Hashing the SHA-256 representation lets us migrate without message bodies.
            with self.db:
                for row in self.db.execute("SELECT discord_id,request_id,content_hash FROM deliveries").fetchall():
                    if not row["content_hash"].startswith("hmac-v1:"):
                        self.db.execute("UPDATE deliveries SET content_hash=? WHERE discord_id=? AND request_id=?",
                            (self._keyed_digest(row["content_hash"]), row["discord_id"], row["request_id"]))
        except BaseException:
            self.db.close()
            raise

    def _load_digest_key(self, path: Path):
        existing = self.db.execute("SELECT value FROM store_meta WHERE key='digest_key_id'").fetchone()
        if not path.exists():
            if existing:
                raise ValueError("Missing delivery HMAC key; restore it with the database before starting.")
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(secrets.token_bytes(32))
                stream.flush()
                os.fsync(stream.fileno())
        os.chmod(path, 0o600)
        self._digest_key = path.read_bytes()
        if len(self._digest_key) != 32:
            raise ValueError("Invalid delivery HMAC key.")
        key_id = hashlib.sha256(self._digest_key).hexdigest()
        if existing and not hmac.compare_digest(existing[0], key_id):
            raise ValueError("Delivery HMAC key does not match this database.")
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO store_meta VALUES ('digest_key_id',?)", (key_id,))

    def _keyed_digest(self, sha256_hex: str) -> str:
        return "hmac-v1:" + hmac.new(self._digest_key, sha256_hex.encode(), hashlib.sha256).hexdigest()

    def content_digest(self, content: str) -> str:
        return self._keyed_digest(hashlib.sha256(content.encode()).hexdigest())

    def close(self):
        self.db.close()

    def prune(self):
        with self.db:
            self.db.execute("DELETE FROM sessions WHERE expires_at <= ?", (time.time(),))
            self.db.execute("DELETE FROM deliveries WHERE created_at < ?",
                            (time.time() - self.delivery_retention_hours * 3600,))

    def account(self, user_id: str):
        return self.db.execute("SELECT * FROM accounts WHERE discord_id=?", (user_id,)).fetchone()

    def account_by_name(self, name: str):
        return self.db.execute("SELECT * FROM accounts WHERE username=?", (name,)).fetchone()

    def register(self, user_id: str, password_hash: str) -> str:
        username = "gp_" + user_id
        try:
            with self.db:
                self.db.execute("INSERT INTO accounts VALUES (?,?,?,?)",
                                (user_id, username, password_hash, time.time()))
        except sqlite3.IntegrityError:
            raise RelayError(409, "already_registered", "Already registered. Use /relay-account reset.")
        return username

    def reset(self, user_id: str, password_hash: str):
        with self.db:
            if not self.db.execute("UPDATE accounts SET password_hash=? WHERE discord_id=?",
                                   (password_hash, user_id)).rowcount:
                raise RelayError(404, "not_registered", "Use /register first.")
            self.db.execute("DELETE FROM sessions WHERE discord_id=?", (user_id,))

    def delete_account(self, user_id: str):
        with self.db:
            self.db.execute("DELETE FROM accounts WHERE discord_id=?", (user_id,))

    def session(self, user_id: str, device: str) -> tuple[str, float]:
        self.prune()
        token, expires = secrets.token_urlsafe(32), time.time() + self.session_seconds
        with self.db:
            self.db.execute("INSERT INTO sessions VALUES (?,?,?,?)",
                            (token_hash(token), user_id, device[:80], expires))
        return token, expires

    def authenticate(self, token: str):
        if not token or len(token) > 256:
            raise RelayError(401, "unauthorized", "Log in again.")
        row = self.db.execute("""SELECT a.discord_id,a.username,s.expires_at FROM sessions s
            JOIN accounts a USING(discord_id) WHERE s.token_hash=? AND s.expires_at>?""",
                              (token_hash(token), time.time())).fetchone()
        if row is None:
            raise RelayError(401, "unauthorized", "Session expired or revoked. Log in again.")
        return dict(row)

    def revoke(self, token: str):
        with self.db:
            self.db.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash(token),))

    def revoke_all(self, user_id: str):
        with self.db:
            self.db.execute("DELETE FROM sessions WHERE discord_id=?", (user_id,))

    def enable(self, guild_id: str, channel_id: str, actor_id: str):
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO channels VALUES (?,?,?,?)",
                            (channel_id, guild_id, actor_id, time.time()))

    def disable(self, channel_id: str):
        with self.db:
            self.db.execute("DELETE FROM channels WHERE channel_id=?", (channel_id,))

    def channels(self, guild_id: str | None = None):
        if guild_id is None:
            return self.db.execute("SELECT * FROM channels ORDER BY guild_id,channel_id").fetchall()
        return self.db.execute("SELECT * FROM channels WHERE guild_id=? ORDER BY channel_id",
                               (guild_id,)).fetchall()

    def channel(self, channel_id: str):
        return self.db.execute("SELECT * FROM channels WHERE channel_id=?", (channel_id,)).fetchone()

    def delivery(self, user_id: str, request_id: str):
        return self.db.execute("SELECT * FROM deliveries WHERE discord_id=? AND request_id=?",
                               (user_id, request_id)).fetchone()

    def last_send(self, user_id: str, channel_id: str) -> float:
        row = self.db.execute("SELECT MAX(created_at) FROM deliveries WHERE discord_id=? AND channel_id=?",
                              (user_id, channel_id)).fetchone()
        return row[0] or 0

    def reserve_delivery(self, user_id: str, request_id: str, channel_id: str, digest: str):
        with self.db:
            self.db.execute("INSERT INTO deliveries VALUES (?,?,?,?,NULL,?)",
                            (request_id, user_id, channel_id, digest, time.time()))

    def finish_delivery(self, user_id: str, request_id: str, message_id: str):
        with self.db:
            self.db.execute("UPDATE deliveries SET message_id=? WHERE discord_id=? AND request_id=?",
                            (message_id, user_id, request_id))
