# Embed GuildPort in an existing discord.py bot

Install `./server` into the same environment as the host bot. It supports `discord.Client` plus `app_commands.CommandTree`; conversion to `commands.Bot` is not necessary.

```python
from pathlib import Path
import discord
from discord import app_commands
from guildport.plugin import RelayPlugin, configure_intents

class MyBot(discord.Client):
    def __init__(self):
        super().__init__(intents=configure_intents(discord.Intents.none()))
        self.tree = app_commands.CommandTree(self)
        self.relay = None

    async def setup_hook(self):
        self.relay = RelayPlugin(
            self, self.tree,
            database=Path('.runtime/relay/relay.sqlite3'),
            public_url='https://relay.example.com',
            port=8769,
        )
        # Register the host's other commands before syncing too.
        await self.tree.sync()
        await self.relay.start()

    async def on_message(self, message):
        await self.relay.on_message(message)
        # Preserve any existing host handler here.

    async def on_raw_message_edit(self, event):
        await self.relay.on_raw_message_edit(event)

    async def on_raw_message_delete(self, event):
        await self.relay.on_raw_message_delete(event)

    async def on_raw_bulk_message_delete(self, event):
        await self.relay.on_raw_bulk_message_delete(event)

    async def close(self):
        if self.relay:
            await self.relay.close()
        await super().close()
```

GuildPort registers `/register`, `/relay`, and `/relay-account`; names must be available in the host's command tree. Registration happens before sync. The plugin does not log in, sync commands, replace event handlers, or create another Gateway connection. Forward existing handlers explicitly, or use the host framework's listener registration if available.

`configure_intents` copies the supplied intents and enables Guilds, Guild Messages and Message Content. Enable Message Content in the Developer Portal before restarting an enabled host. Missing approval/configuration can prevent its Gateway login. Disabling the integration should restore the host's original intents.

`RelayPlugin.start()` is safe in `setup_hook`: it does not wait for Gateway readiness. API access fails closed while the client is disconnected. `close()` stops the API and closes storage; after a close, construct a new plugin rather than restarting the same instance.

Use a **dedicated private database directory**. The store sets that directory to 0700 and its SQLite file to 0600. Never point it directly at a shared project root. SQLite connections belong to the host event loop; password hashing runs in bounded background workers.

## mortis-core integration

The companion integration in mortis-core is optional and disabled by default. Install the server package into the bot environment, then configure:

```dotenv
GUILDPORT_ENABLED=true
GUILDPORT_PUBLIC_URL=https://relay.example.com
GUILDPORT_PORT=8769
```

Its adapter uses the bot's existing client and command tree and stores state under `.runtime/relay/`. The gallery API remains separate. Configure TLS and Message Content access, then restart the host through its normal deployment process. No channel becomes accessible until its administrator enables it.
