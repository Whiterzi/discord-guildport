"""Small host for a separate development bot. Production may embed RelayPlugin."""
import os
from pathlib import Path

import discord
from discord import app_commands

from .plugin import RelayPlugin, configure_intents


class RelayBot(discord.Client):
    def __init__(self):
        super().__init__(intents=configure_intents(discord.Intents.none()),
                         allowed_mentions=discord.AllowedMentions.none())
        self.tree = app_commands.CommandTree(self)
        self.relay = RelayPlugin(self, self.tree,
            Path(os.getenv("GUILDPORT_DATABASE", ".runtime/relay/relay.sqlite3")),
            os.getenv("GUILDPORT_PUBLIC_URL", "http://127.0.0.1:8769"),
            int(os.getenv("GUILDPORT_PORT", "8769")))

    async def setup_hook(self):
        guild = os.getenv("GUILDPORT_TEST_GUILD")
        if guild:
            target = discord.Object(id=int(guild))
            self.tree.copy_global_to(guild=target)
            await self.tree.sync(guild=target)
        else:
            await self.tree.sync()
        await self.relay.start()

    async def close(self):
        await self.relay.close()
        await super().close()

    async def on_message(self, message):
        await self.relay.on_message(message)

    async def on_raw_message_edit(self, event):
        await self.relay.on_raw_message_edit(event)

    async def on_raw_message_delete(self, event):
        await self.relay.on_raw_message_delete(event)

    async def on_raw_bulk_message_delete(self, event):
        await self.relay.on_raw_bulk_message_delete(event)


def main():
    token = os.getenv("DISCORD_TOKEN")
    if not token:
        raise SystemExit("Set DISCORD_TOKEN for your development bot.")
    RelayBot().run(token)


if __name__ == "__main__":
    main()
