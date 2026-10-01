"""Offline loopback demo: no Discord token, no access to real Discord messages."""
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import secrets
import signal
import tempfile

from aiohttp import web
from guildport.models import Access, RelayError
from guildport.server import RelayService
from guildport.store import Store, hash_password


class DemoAdapter:
    def __init__(self):
        self.messages = []
        self.hub = None

    async def authorize(self, user_id, guild_id, channel_id, *, for_send=False):
        if (user_id, guild_id, channel_id) != ("300", "100", "200"):
            raise RelayError(403, "access_denied", "Not a demo member.")
        return Access("100", "Offline demo", "200", "general", "Demo user", True)

    async def history(self, access, limit, before):
        messages = [m for m in self.messages if before is None or int(m["id"]) < int(before)]
        return messages[-limit:]

    async def send(self, access, user_id, content):
        message = {"id": str(1000 + len(self.messages)), "channel_id": "200",
            "author": {"id": user_id, "name": "Demo user", "bot": False}, "content": content,
            "created_at": datetime.now(timezone.utc).isoformat(), "attachments": []}
        self.messages.append(message)
        self.hub.publish("200", {"type": "message.created", "message": message})
        return message


async def main():
    root = Path(__file__).resolve().parents[1] / "tmp"
    root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=root, prefix="demo-") as directory:
        store = Store(Path(directory)/"relay.sqlite3")
        password = secrets.token_urlsafe(24)
        username = store.register("300", hash_password(password))
        store.enable("100", "200", "300")
        adapter = DemoAdapter()
        service = RelayService(store, adapter)
        adapter.hub = service.hub
        runner = web.AppRunner(service.application(), access_log=None, shutdown_timeout=1)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = runner.addresses[0][1]
        print(json.dumps({"url": f"http://127.0.0.1:{port}", "username": username, "password": password}), flush=True)
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stop.set)
        try:
            await stop.wait()
        finally:
            await runner.cleanup()
            store.close()


if __name__ == "__main__":
    asyncio.run(main())
