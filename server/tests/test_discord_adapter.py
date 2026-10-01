import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import discord
from discord import app_commands

from guildport.discord_adapter import DiscordAdapter, message_data
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
        self.client.fetch_channel = AsyncMock(side_effect=lambda channel_id: self.channel)
        self.member_patch = patch.object(discord.Guild, "fetch_member", self.fetch_members)
        self.fetch_channels = AsyncMock(side_effect=AssertionError("Permission checks must not enumerate all guild channels"))
        self.channel_patch = patch.object(discord.Guild, "fetch_channels", self.fetch_channels)
        self.member_patch.start()
        self.channel_patch.start()

    async def asyncTearDown(self):
        await self.adapter.close()
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
        self.client.fetch_channel.assert_awaited_with(200)
        self.assertEqual(self.client.fetch_channel.await_count, 2)
        self.fetch_channels.assert_not_awaited()

    async def test_snapshot_requests_run_concurrently_and_only_share_in_flight(self):
        started = set()
        all_started, release = asyncio.Event(), asyncio.Event()

        async def endpoint(name, value):
            started.add(name)
            if len(started) == 4:
                all_started.set()
            await release.wait()
            return value

        async def guild(*args, **kwargs):
            return await endpoint("guild", self.guild)
        async def channel(channel_id):
            return await endpoint("channel", self.channel)
        async def member(member_id):
            return await endpoint(str(member_id), self.user if member_id == 300 else self.bot)
        self.client.fetch_guild.side_effect = guild
        self.client.fetch_channel.side_effect = channel
        self.fetch_members.side_effect = member
        first = asyncio.create_task(self.adapter.authorize("300", "100", "200"))
        second = asyncio.create_task(self.adapter.authorize("300", "100", "200"))
        try:
            await asyncio.wait_for(all_started.wait(), 1)
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first
            release.set()
            access = await second
            self.assertTrue(access.can_send)
            self.assertIs(access.target.guild, self.guild)
            self.assertIs(self.user.guild, self.guild)
            self.assertEqual(self.client.fetch_guild.await_count, 1)
            self.channel = self.make_channel(deny_user=True)
            with self.assertRaises(RelayError):
                await self.adapter.authorize("300", "100", "200")
            self.assertEqual(self.client.fetch_guild.await_count, 2)
        finally:
            release.set()
            await asyncio.gather(first, second, return_exceptions=True)

    async def test_bot_permission_does_not_substitute_for_member_permission(self):
        for settings in ({"deny_bot": True}, {"deny_user": True}, {"nsfw": True}, {"kind": 5}):
            self.channel = self.make_channel(**settings)
            with self.assertRaises(RelayError):
                await self.adapter.authorize("300", "100", "200")

    async def test_single_channel_fetch_rejects_wrong_guild_and_private_channels(self):
        other = discord.Guild(state=self.state, data={"id": "101", "roles": []})
        self.channel.guild = other
        with self.assertRaises(RelayError):
            await self.adapter.authorize("300", "100", "200")
        self.assertIs(self.channel.guild, other)
        self.client.fetch_channel.return_value = SimpleNamespace(id=200)
        self.client.fetch_channel.side_effect = None
        with self.assertRaises(RelayError):
            await self.adapter.authorize("300", "100", "200")

    async def test_fresh_roles_override_gateway_context_without_mutating_shared_objects(self):
        fresh = discord.Guild(state=self.state, data={
            "id": "100", "name": "Fresh", "owner_id": "999", "verification_level": 0,
            "roles": [{"id": "100", "name": "@everyone", "permissions": "0"}]})
        self.client.fetch_guild.return_value = fresh
        with self.assertRaises(RelayError):
            await self.adapter.authorize("300", "100", "200")
        self.assertIs(self.channel.guild, self.guild)
        self.assertIs(self.user.guild, self.guild)
        self.assertIs(self.bot.guild, self.guild)
        # A new check must see a newly granted role, never a cached denial.
        fresh.owner_id = 300
        self.bot = self.member("400", roles=["500"])
        fresh._roles[500] = discord.Role(guild=fresh, state=self.state, data={
            "id": "500", "name": "Bot", "permissions": str(discord.Permissions(
                view_channel=True, read_message_history=True, send_messages=True).value)})
        access = await self.adapter.authorize("300", "100", "200")
        self.assertEqual(access.guild_name, "Fresh")
        self.assertIs(access.target.guild, fresh)
        self.assertIsNot(access.target, self.channel)
        self.assertIs(self.channel.guild, self.guild)

    async def test_parallel_users_and_channels_share_only_matching_rest_requests(self):
        started = set()
        all_started, release = asyncio.Event(), asyncio.Event()
        other_channel = self.make_channel()
        other_channel.id = 201
        other_user = self.member("301")

        async def endpoint(name, value):
            started.add(name)
            if len(started) == 6:
                all_started.set()
            await release.wait()
            return value

        async def guild(*args, **kwargs):
            return await endpoint("guild", self.guild)
        async def channel(channel_id):
            return await endpoint(f"channel:{channel_id}", self.channel if channel_id == 200 else other_channel)
        async def member(member_id):
            return await endpoint(f"member:{member_id}", {300:self.user, 301:other_user, 400:self.bot}[member_id])

        self.client.fetch_guild.side_effect = guild
        self.client.fetch_channel.side_effect = channel
        self.fetch_members.side_effect = member
        tasks = [asyncio.create_task(self.adapter.authorize(user, "100", channel))
                 for user, channel in (("300", "200"), ("300", "201"), ("301", "200"))]
        try:
            await asyncio.wait_for(all_started.wait(), 1)
            release.set()
            access = await asyncio.gather(*tasks)
            self.assertEqual(self.client.fetch_guild.await_count, 1)
            self.assertEqual(self.client.fetch_channel.await_count, 2)
            self.assertEqual(self.fetch_members.await_count, 3)
            self.fetch_channels.assert_not_awaited()
            self.assertIsNot(access[0].target, access[2].target)
        finally:
            release.set()
            await asyncio.gather(*tasks, return_exceptions=True)

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

    async def test_avatar_card_requires_both_user_and_bot_embed_permission(self):
        original=discord.TextChannel.permissions_for
        for user_allowed, bot_allowed in ((True,True),(False,True),(True,False)):
            def permissions(channel, member):
                result=original(channel,member)
                result.embed_links=user_allowed if member.id==300 else bot_allowed
                return result
            with patch.object(discord.TextChannel,"permissions_for",permissions):
                access=await self.adapter.authorize("300","100","200")
            self.assertEqual(access.can_embed,user_allowed and bot_allowed)
            sender=AsyncMock(return_value=SimpleNamespace(id=900))
            with patch.object(discord.TextChannel,"send",sender):
                await self.adapter.send(access,"300","@everyone hello")
            args,kwargs=sender.call_args
            self.assertFalse(kwargs["allowed_mentions"].everyone)
            if access.can_embed:
                self.assertEqual(args,())
                embed=kwargs["embed"]
                self.assertEqual(embed.description,"@everyone hello")
                self.assertEqual(embed.author.name,self.user.display_name)
                self.assertEqual(embed.author.icon_url,str(self.user.display_avatar.replace(size=64).url))
                self.assertEqual(embed.footer.text,"via GuildPort · 300")
                self.assertNotIn("suppress_embeds",kwargs)
            else:
                self.assertNotIn("embed",kwargs)
                self.assertIn("via GuildPort",args[0])

    def message(self, author=400, content="", embeds=None, webhook_id=None):
        return SimpleNamespace(id=900,channel=SimpleNamespace(id=200),
            author=SimpleNamespace(id=author,display_name="Bot",bot=True),content=content,
            embeds=embeds or [],attachments=[],created_at=datetime.now(timezone.utc),webhook_id=webhook_id)

    def test_relay_card_round_trip_and_forged_attribution_is_rejected(self):
        embed=discord.Embed(description="hello from CLI")
        embed.set_author(name="Alice",icon_url="https://cdn.discordapp.com/example.png")
        embed.set_footer(text="via GuildPort · 300")
        result=message_data(self.message(embeds=[embed]),400)
        self.assertEqual(result["relay_author"],{"id":"300","name":"Alice"})
        self.assertEqual(result["relay_content"],"hello from CLI")
        self.assertIn("Alice · via GuildPort",result["content"])
        self.assertTrue(result["content"].endswith("hello from CLI"))
        self.assertEqual(result["author"]["id"],"400")
        for message in (self.message(author=401,embeds=[embed]),self.message(embeds=[embed],webhook_id=99)):
            self.assertNotIn("relay_author",message_data(message,400))

    def test_legacy_relay_attribution_and_embed_only_text(self):
        content="**Alice · via GuildPort** (`300`)\nhello"
        own=message_data(self.message(content=content),400)
        self.assertEqual(own["relay_author"]["name"],"Alice")
        self.assertEqual(own["relay_content"],"hello")
        self.assertEqual(own["content"],content)
        self.assertNotIn("relay_author",message_data(self.message(author=401,content=content),400))
        embed=discord.Embed(title="Summary",description="Readable content")
        data=message_data(self.message(author=401,embeds=[embed]),400)
        self.assertIn("Summary",data["content"])
        self.assertIn("Readable content",data["content"])


class PluginTests(unittest.IsolatedAsyncioTestCase):
    async def test_lifecycle_and_command_registration_do_not_login_or_sync(self):
        root = Path(__file__).resolve().parents[2]/"tmp"
        root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=root) as directory:
            client = discord.Client(intents=configure_intents(discord.Intents.none()))
            tree = app_commands.CommandTree(client)
            plugin = RelayPlugin(client, tree, Path(directory)/"state"/"relay.sqlite3", "http://127.0.0.1:8769", 0)
            self.assertEqual([c.name for c in tree.get_commands()], ["register", "dcgp", "relay-account", "relay"])
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
