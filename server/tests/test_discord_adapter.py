from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import discord
from discord import app_commands

from guildport.discord_adapter import DiscordAdapter
from guildport.models import RelayError
from guildport.plugin import RelayPlugin, configure_intents


class DiscordAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = discord.Client(intents=configure_intents(discord.Intents.none()))
        self.state = self.client._connection
        self.guild = discord.Guild(state=self.state, data={
            "id": "100", "name": "Guild", "owner_id": "999", "verification_level": 0,
            "roles": [{"id": "100", "name": "@everyone", "permissions": str(discord.Permissions(
                view_channel=True, read_message_history=True, send_messages=True).value)}]})
        self.user = self.member("300")
        self.bot = self.member("400")
        self.channel = self.make_channel()
        self.client.is_ready = lambda: True
        self.state.user = SimpleNamespace(id=400)
        self.client.fetch_guild = AsyncMock(return_value=self.guild)
        self.adapter = DiscordAdapter(self.client)
        self.fetch_members = AsyncMock(side_effect=lambda member_id: self.user if member_id == 300 else self.bot)
        self.fetch_channels = AsyncMock(side_effect=lambda: [self.channel])
        self.member_patch = patch.object(discord.Guild, "fetch_member", self.fetch_members)
        self.channel_patch = patch.object(discord.Guild, "fetch_channels", self.fetch_channels)
        self.member_patch.start()
        self.channel_patch.start()

    async def asyncTearDown(self):
        self.member_patch.stop()
        self.channel_patch.stop()
        await self.client.close()

    def member(self, user_id, **changes):
        data = {"user": {"id": user_id, "username": "tester", "discriminator": "0", "avatar": None},
                "roles": [], "flags": 0, "pending": False}
        data.update(changes)
        return discord.Member(data=data, guild=self.guild, state=self.state)

    def make_channel(self, deny_user=False, deny_bot=False, nsfw=False, kind=0):
        overwrites = []
        for target, deny in (("300", deny_user), ("400", deny_bot)):
            if deny:
                overwrites.append({"id": target, "type": 1, "allow": "0",
                    "deny": str(discord.Permissions(view_channel=True).value)})
        return discord.TextChannel(state=self.state, guild=self.guild, data={"id": "200", "type": kind,
            "name": "general", "position": 0, "nsfw": nsfw, "rate_limit_per_user": 10,
            "permission_overwrites": overwrites})

    async def test_fresh_member_and_channel_overwrites_are_checked(self):
        access = await self.adapter.authorize("300", "100", "200")
        self.assertTrue(access.can_send)
        self.assertEqual(access.slowmode, 10)
        self.channel = self.make_channel(deny_user=True)
        with self.assertRaises(RelayError):
            await self.adapter.authorize("300", "100", "200")
        self.assertEqual(self.client.fetch_guild.await_count, 2)
        self.assertEqual(self.fetch_members.await_count, 4)
        self.assertEqual(self.fetch_channels.await_count, 2)

    async def test_bot_permission_does_not_substitute_for_member_permission(self):
        for settings in ({"deny_bot": True}, {"deny_user": True}, {"nsfw": True}, {"kind": 5}):
            self.channel = self.make_channel(**settings)
            with self.assertRaises(RelayError):
                await self.adapter.authorize("300", "100", "200")

    async def test_pending_members_are_denied_and_timed_out_members_are_read_only(self):
        self.user = self.member("300", pending=True)
        with self.assertRaises(RelayError):
            await self.adapter.authorize("300", "100", "200")
        self.user = self.member("300", communication_disabled_until=(datetime.now(timezone.utc)+timedelta(minutes=5)).isoformat())
        self.assertFalse((await self.adapter.authorize("300", "100", "200")).can_send)

    async def test_disconnected_gateway_fails_closed(self):
        self.client.is_ready = lambda: False
        with self.assertRaises(RelayError) as context:
            await self.adapter.authorize("300", "100", "200")
        self.assertEqual(context.exception.status, 503)

    async def test_unverifiable_guild_verification_is_read_only(self):
        self.guild.verification_level = discord.VerificationLevel.highest
        access = await self.adapter.authorize("300", "100", "200")
        self.assertFalse(access.can_send)
        self.assertIn("verification", access.send_block_reason)
        self.user = self.member("300", flags=4)
        self.assertTrue((await self.adapter.authorize("300", "100", "200")).can_send)

    async def test_admin_check_does_not_trust_interaction_snapshot(self):
        with self.assertRaises(RelayError):
            await self.adapter.require_admin("100", "300")
        self.guild.owner_id = 300
        await self.adapter.require_admin("100", "300")

    async def test_native_discord_sends_count_toward_slowmode(self):
        async def history(*args, **kwargs):
            yield SimpleNamespace(author=SimpleNamespace(id=300))
        with patch.object(discord.TextChannel, "history", history):
            with self.assertRaises(RelayError) as context:
                await self.adapter.authorize("300", "100", "200", for_send=True)
        self.assertEqual(context.exception.code, "slowmode")

    async def test_truncated_slowmode_window_fails_closed(self):
        async def history(*args, **kwargs):
            for _ in range(101):
                yield SimpleNamespace(author=SimpleNamespace(id=500))
        with patch.object(discord.TextChannel, "history", history):
            with self.assertRaises(RelayError) as context:
                await self.adapter.authorize("300", "100", "200", for_send=True)
        self.assertEqual(context.exception.code, "slowmode_unverified")

    async def test_send_disables_mentions_and_attributes_authenticated_user(self):
        access = await self.adapter.authorize("300", "100", "200")
        sender = AsyncMock(return_value=SimpleNamespace(id=900))
        with patch.object(discord.TextChannel, "send", sender):
            await self.adapter.send(access, "300", "@everyone hello")
        args, kwargs = sender.call_args
        self.assertIn("`300`", args[0])
        self.assertIn("via GuildPort", args[0])
        self.assertFalse(kwargs["allowed_mentions"].everyone)
        self.assertFalse(kwargs["allowed_mentions"].users)
        self.assertFalse(kwargs["allowed_mentions"].roles)
        self.assertTrue(kwargs["suppress_embeds"])


class PluginTests(unittest.IsolatedAsyncioTestCase):
    async def test_lifecycle_and_command_registration_do_not_login_or_sync(self):
        root = Path(__file__).resolve().parents[2]/"tmp"
        root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=root) as directory:
            client = discord.Client(intents=configure_intents(discord.Intents.none()))
            tree = app_commands.CommandTree(client)
            plugin = RelayPlugin(client, tree, Path(directory)/"state"/"relay.sqlite3", "http://127.0.0.1:8769", 0)
            self.assertEqual([c.name for c in tree.get_commands()], ["register", "relay-account", "relay"])
            await plugin.start()
            await plugin.start()
            await plugin.close()
            await plugin.close()
            self.assertEqual(tree.get_commands(), [])
            await client.close()

    async def test_intents_do_not_require_member_or_presence_privileges(self):
        intents = configure_intents(discord.Intents.none())
        self.assertTrue(intents.guilds and intents.guild_messages and intents.message_content)
        self.assertFalse(intents.members or intents.presences)
