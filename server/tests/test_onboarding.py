from pathlib import Path
import shlex
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import discord
from discord import app_commands

from guildport.models import RelayError
from guildport.onboarding import privacy_notice, quick_start
from guildport.plugin import RelayPlugin, configure_intents


class OnboardingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.client = discord.Client(intents=configure_intents(discord.Intents.none()))
        self.tree = app_commands.CommandTree(self.client)
        self.plugin = RelayPlugin(self.client, self.tree, Path(self.tmp.name)/"relay.sqlite3", "https://relay.example.com")
        self.guild = patch.object(self.client, "get_guild", return_value=SimpleNamespace(id=100))
        self.guild.start()
        self.views = []

    async def asyncTearDown(self):
        for view in self.views:
            view.stop()
        self.guild.stop()
        await self.plugin.close()
        await self.client.close()
        self.tmp.cleanup()

    def interaction(self, user=300, guild=100):
        return SimpleNamespace(user=SimpleNamespace(id=user), guild_id=guild, data={},
            response=SimpleNamespace(send_message=AsyncMock(), edit_message=AsyncMock(),
                                     defer=AsyncMock(), is_done=Mock(return_value=True)),
            followup=SimpleNamespace(send=AsyncMock()))

    async def register_view(self):
        interaction = self.interaction()
        await self.tree.get_command("register").callback(interaction)
        kwargs = interaction.response.send_message.call_args.kwargs
        self.assertTrue(kwargs["ephemeral"])
        self.assertIn("並非端對端加密", interaction.response.send_message.call_args.args[0])
        self.views.append(kwargs["view"])
        return kwargs["view"]

    async def test_registration_requires_consent_and_generates_credentials_once(self):
        view = await self.register_view()
        self.assertIsNone(self.plugin.store.account("300"))
        interaction = self.interaction()
        await view._scheduled_task(view.accept, interaction)
        self.assertIsNotNone(self.plugin.store.account("300"))
        content = interaction.followup.send.call_args.args[0]
        self.assertIn("初始密碼", content)
        self.assertIn("--username 'gp_300'", content)
        self.assertTrue(interaction.followup.send.call_args.kwargs["ephemeral"])
        second = self.interaction()
        await view._scheduled_task(view.accept, second)
        second.followup.send.assert_not_awaited()
        self.assertTrue(second.response.send_message.call_args.kwargs["ephemeral"])

    async def test_another_user_guild_or_expired_view_cannot_accept(self):
        view = await self.register_view()
        for interaction in (self.interaction(user=301), self.interaction(guild=101)):
            await view._scheduled_task(view.accept, interaction)
            interaction.followup.send.assert_not_awaited()
            self.assertTrue(interaction.response.send_message.call_args.kwargs["ephemeral"])
        view.deadline = time.monotonic() - 1
        await view._scheduled_task(view.accept, self.interaction())
        self.assertIsNone(self.plugin.store.account("300"))

    async def test_consent_rechecks_bot_is_still_installed(self):
        view = await self.register_view()
        interaction = self.interaction()
        with patch.object(self.client, "get_guild", return_value=None):
            await view._scheduled_task(view.accept, interaction)
        self.assertIsNone(self.plugin.store.account("300"))
        self.assertIn("已安裝", interaction.followup.send.call_args.args[0])

    async def test_quick_command_is_private_and_does_not_issue_credentials(self):
        self.plugin.store.register("300", "SECRET_PASSWORD_HASH")
        self.plugin.store.register("301", "OTHER_PASSWORD_HASH")
        token, _ = self.plugin.store.session("300", "test")
        for user in (300, 301):
            interaction = self.interaction(user=user)
            await self.tree.get_command("dcgp").callback(interaction)
            content = interaction.response.send_message.call_args.args[0]
            self.assertIn(f"--username 'gp_{user}'", content)
            self.assertNotIn(token, content)
            self.assertNotIn("PASSWORD_HASH", content)
            self.assertTrue(interaction.response.send_message.call_args.kwargs["ephemeral"])
        self.assertEqual(self.plugin.store.db.execute("SELECT count(*) FROM sessions").fetchone()[0], 1)

    async def test_unregistered_user_gets_registration_link_without_account(self):
        interaction = self.interaction()
        await self.tree.get_command("dcgp").callback(interaction)
        self.assertIn("/register", interaction.response.send_message.call_args.args[0])
        self.assertNotIn("npx", interaction.response.send_message.call_args.args[0])
        self.assertIsNone(self.plugin.store.account("300"))

    async def test_only_guild_install_can_use_commands(self):
        for name in ("dcgp", "register"):
            command = self.tree.get_command(name)
            self.assertTrue(command.extras["guildport_error_handler"])
            payload = command.to_dict(self.tree)
            self.assertTrue(payload["dm_permission"] is False)
            self.assertEqual(payload["integration_types"], [0])
            with self.assertRaises(RelayError):
                await command.callback(self.interaction(guild=None))

    async def test_unsubscribed_or_disabled_messages_are_not_serialized(self):
        message = SimpleNamespace(guild=object(), channel=SimpleNamespace(id=200))
        with patch("guildport.plugin.message_data", return_value={"content": "hello"}) as serialize:
            await self.plugin.on_message(message)
            self.plugin.service.hub.subscribe("200")
            await self.plugin.on_message(message)
            serialize.assert_not_called()
            self.plugin.store.enable("100", "200", "300")
            await self.plugin.on_message(message)
            serialize.assert_called_once_with(message, None)

    def test_quick_command_uses_published_cli_and_no_shell_secret(self):
        text = quick_start("https://relay.example.com", "gp_300")
        command = text.split("```sh\n")[1].split("\n```")[0]
        args = shlex.split(command)
        self.assertEqual(args, ["npx", "--yes", "--package=discord-guildport@alpha",
            "dcgp", "login", "--server", "https://relay.example.com", "--username", "gp_300"])

    def test_privacy_notice_discloses_actual_read_check_interval(self):
        self.assertIn("每 5 秒", privacy_notice(24))
        self.assertIn("每 10 秒", privacy_notice(24, 10))
        self.assertIn("每批收訊", privacy_notice(24, 0))
        self.assertIn("暫停轉送", privacy_notice(24, 5))

    def test_url_cannot_inject_shell_or_discord_formatting(self):
        for url in ("https://relay.example.com/'bad", "https://$(whoami).example.com",
                    "https://relay.example.com\n", "https://relay.example.com:99999"):
            with self.assertRaises(ValueError):
                RelayPlugin(self.client, self.tree, Path(self.tmp.name)/"bad.sqlite3", url)
