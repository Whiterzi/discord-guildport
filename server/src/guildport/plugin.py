from __future__ import annotations

import asyncio
from pathlib import Path
import secrets

import discord
from discord import app_commands
from aiohttp import web

from .discord_adapter import DiscordAdapter, message_data
from .models import RelayError
from .server import RelayService
from .store import Store, hash_password


def configure_intents(base: discord.Intents) -> discord.Intents:
    intents = discord.Intents(base.value)
    intents.guilds = True
    intents.guild_messages = True
    intents.message_content = True
    return intents


class RelayPlugin:
    """Owns relay state/lifecycle; the host owns its Discord client and command sync."""
    def __init__(self, client: discord.Client, tree: app_commands.CommandTree,
                 database: Path, public_url: str, port: int = 8769):
        if not all((client.intents.guilds, client.intents.guild_messages, client.intents.message_content)):
            raise ValueError("Configure relay intents before constructing the Discord client.")
        from urllib.parse import urlsplit
        url = urlsplit(public_url)
        if (url.scheme not in ("https", "http") or not url.hostname or url.username or url.password
                or url.query or url.fragment or url.path not in ("", "/")
                or (url.scheme == "http" and url.hostname not in ("localhost", "127.0.0.1", "::1"))):
            raise ValueError("public_url must be an HTTPS origin (HTTP is allowed only on loopback).")
        self.client, self.tree = client, tree
        self.public_url, self.port = public_url.rstrip("/"), port
        self.store = Store(database)
        self.adapter = DiscordAdapter(client)
        self.service = RelayService(self.store, self.adapter)
        self.runner = None
        self.closed = False
        self._commands = []
        self.register_commands()

    def register_commands(self):
        @app_commands.command(name="register", description="建立 GuildPort CLI 帳號（僅自己可見）")
        @app_commands.guild_only()
        @app_commands.allowed_installs(guilds=True, users=False)
        async def register(interaction: discord.Interaction):
            await interaction.response.defer(ephemeral=True, thinking=True)
            # This action proves identity via Discord, never via an arbitrary HTTP user_id.
            if interaction.guild_id is None or self.client.get_guild(interaction.guild_id) is None:
                raise RelayError(403, "guild_install_required", "請在已安裝 GuildPort bot 的伺服器執行。")
            user_id = str(interaction.user.id)
            if self.store.account(user_id):
                raise RelayError(409, "already_registered", "已有帳號，請用 /relay-account reset 重設密碼。")
            password = secrets.token_urlsafe(24)
            async with self.service.password_slots:
                encoded = await asyncio.to_thread(hash_password, password)
            username = self.store.register(user_id, encoded)
            await interaction.followup.send(
                f"GuildPort CLI 帳號已建立。這組帳密僅用於 GuildPort。\n"
                f"帳號：`{username}`\n初始密碼：||`{password}`||\n"
                f"執行 `dcgp`，選擇 Log in to a relay。\nRelay 網址：`{self.public_url}`\n"
                "CLI 只能存取管理員啟用且你有權限的頻道；訊息由 bot 標示代送。"
                "登入憑證有效七天，可用 /relay-account 撤銷或刪除帳號。",
                ephemeral=True, allowed_mentions=discord.AllowedMentions.none())

        account = app_commands.Group(name="relay-account", description="管理 GuildPort CLI 帳號",
            guild_only=True, allowed_installs=app_commands.AppInstallationType(guild=True, user=False))

        @account.command(name="reset", description="產生新密碼並撤銷所有 CLI 登入")
        async def reset(interaction: discord.Interaction):
            await interaction.response.defer(ephemeral=True, thinking=True)
            password = secrets.token_urlsafe(24)
            async with self.service.password_slots:
                encoded = await asyncio.to_thread(hash_password, password)
            self.store.reset(str(interaction.user.id), encoded)
            await interaction.followup.send(f"所有裝置已登出。新密碼：||`{password}`||", ephemeral=True)

        @account.command(name="logout-all", description="撤銷所有 CLI 裝置登入")
        async def logout_all(interaction: discord.Interaction):
            self.store.revoke_all(str(interaction.user.id))
            await interaction.response.send_message("所有 CLI 裝置已登出。", ephemeral=True)

        @account.command(name="delete", description="刪除 GuildPort CLI 帳號與登入資料")
        async def delete(interaction: discord.Interaction, confirm: bool):
            if confirm:
                self.store.delete_account(str(interaction.user.id))
            await interaction.response.send_message("GuildPort CLI 帳號已刪除。" if confirm else "未刪除帳號。", ephemeral=True)

        admin = app_commands.Group(name="relay", description="管理 CLI 可用頻道",
            guild_only=True, default_permissions=discord.Permissions(manage_guild=True),
            allowed_installs=app_commands.AppInstallationType(guild=True, user=False))

        @admin.command(name="enable", description="開放此文字頻道給具原始權限的 CLI 使用者")
        async def enable(interaction: discord.Interaction, channel: discord.TextChannel):
            await interaction.response.defer(ephemeral=True, thinking=True)
            if channel.guild.id != interaction.guild_id:
                raise RelayError(403, "wrong_guild", "請選擇目前伺服器的頻道。")
            guild_id, user_id, channel_id = str(interaction.guild_id), str(interaction.user.id), str(channel.id)
            await self.adapter.require_admin(guild_id, user_id)
            await self.adapter.authorize(user_id, guild_id, channel_id)
            self.store.enable(guild_id, channel_id, user_id)
            await interaction.followup.send(
                f"已開放 <#{channel_id}> 的 CLI 存取。請告知成員此頻道使用 GuildPort；"
                "訊息會經過 Relay 主機，且只有具原始權限的已註冊成員可使用。",
                ephemeral=True, allowed_mentions=discord.AllowedMentions.none())

        @admin.command(name="disable", description="停止此頻道的 CLI 存取")
        async def disable(interaction: discord.Interaction, channel: discord.TextChannel):
            await interaction.response.defer(ephemeral=True, thinking=True)
            if channel.guild.id != interaction.guild_id:
                raise RelayError(403, "wrong_guild", "請選擇目前伺服器的頻道。")
            await self.adapter.require_admin(str(interaction.guild_id), str(interaction.user.id))
            self.store.disable(str(channel.id))
            self.service.hub.publish(channel.id, {"type": "resync_required"})
            await interaction.followup.send("已停止此頻道的 CLI 存取。", ephemeral=True)

        async def error_handler(interaction, error):
            cause = getattr(error, "original", error)
            message = cause.message if isinstance(cause, RelayError) else "操作失敗，請稍後再試。"
            if interaction.response.is_done():
                await interaction.followup.send(message, ephemeral=True)
            else:
                await interaction.response.send_message(message, ephemeral=True)

        for command in (register, reset, logout_all, delete, enable, disable):
            command.error(error_handler)
        for command in (register, account, admin):
            self.tree.add_command(command)
            self._commands.append(command.name)

    async def start(self):
        if self.runner is not None:
            return
        self.runner = web.AppRunner(self.service.application(), access_log=None, shutdown_timeout=5)
        try:
            await self.runner.setup()
            await web.TCPSite(self.runner, "127.0.0.1", self.port).start()
        except BaseException:
            await self.runner.cleanup()
            self.runner = None
            raise

    async def close(self):
        if self.closed:
            return
        self.closed = True
        if self.runner:
            await self.runner.cleanup()
            self.runner = None
        self.store.close()
        for name in self._commands:
            self.tree.remove_command(name)

    async def on_message(self, message: discord.Message):
        if message.guild is not None and not self.closed:
            self.service.hub.publish(message.channel.id,
                {"type": "message.created", "message": message_data(message)})

    async def on_raw_message_edit(self, event):
        if not self.closed:
            self.service.hub.publish(event.channel_id,
                {"type": "message.updated", "message_id": str(event.message_id)})

    async def on_raw_message_delete(self, event):
        if not self.closed:
            self.service.hub.publish(event.channel_id,
                {"type": "message.deleted", "message_id": str(event.message_id)})

    async def on_raw_bulk_message_delete(self, event):
        if not self.closed:
            for message_id in event.message_ids:
                self.service.hub.publish(event.channel_id,
                    {"type": "message.deleted", "message_id": str(message_id)})
