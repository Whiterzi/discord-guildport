from __future__ import annotations

import asyncio
from pathlib import Path
import re
import secrets

import discord
from discord import app_commands
from aiohttp import web

from .discord_adapter import DiscordAdapter, message_data
from .models import RelayError
from .onboarding import RegistrationView, command_error, privacy_notice, quick_start
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
                 database: Path, public_url: str, port: int = 8769,
                 delivery_retention_hours: int = 24, read_recheck_seconds: float = 5):
        if not all((client.intents.guilds, client.intents.guild_messages, client.intents.message_content)):
            raise ValueError("Configure relay intents before constructing the Discord client.")
        from urllib.parse import urlsplit
        url = urlsplit(public_url)
        if (not re.fullmatch(r"https?://(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::[0-9]{1,5})?/?", public_url)
                or url.port == 0
                or url.scheme not in ("https", "http") or not url.hostname or url.username or url.password
                or url.query or url.fragment or url.path not in ("", "/")
                or (url.scheme == "http" and url.hostname not in ("localhost", "127.0.0.1", "::1"))):
            raise ValueError("public_url must be an HTTPS origin (HTTP is allowed only on loopback).")
        self.client, self.tree = client, tree
        self.public_url, self.port = public_url.rstrip("/"), port
        self.store = Store(database, delivery_retention_hours=delivery_retention_hours)
        self.adapter = DiscordAdapter(client)
        self.service = RelayService(self.store, self.adapter, read_recheck_seconds=read_recheck_seconds,
                                    browser_origin=self.public_url)
        self.runner = None
        self.closed = False
        self._commands = []
        self.register_commands()

    def register_commands(self):
        def require_guild(interaction):
            if self.closed or interaction.guild_id is None or self.client.get_guild(interaction.guild_id) is None:
                raise RelayError(403, "guild_install_required", "請在已安裝 GuildPort bot 的伺服器執行。")

        @app_commands.command(name="register", description="建立 GuildPort 帳號（網頁／CLI）（僅自己可見）")
        @app_commands.guild_only()
        @app_commands.allowed_installs(guilds=True, users=False)
        async def register(interaction: discord.Interaction):
            require_guild(interaction)
            if self.store.account(str(interaction.user.id)):
                raise RelayError(409, "already_registered", "已有帳號，請用 /dcgp 取得登入指令，或 /relay-account reset 重設密碼。")
            view = RegistrationView(interaction.user.id, interaction.guild_id, create_account)
            await interaction.response.send_message(
                privacy_notice(self.store.delivery_retention_hours, self.service.read_recheck_seconds) + "\n\n閱讀後按下方按鈕建立帳號；此選單五分鐘後失效。",
                view=view, ephemeral=True, allowed_mentions=discord.AllowedMentions.none())

        async def create_account(interaction):
            # This action proves identity via Discord, never via an arbitrary HTTP user_id.
            require_guild(interaction)
            user_id = str(interaction.user.id)
            if self.store.account(user_id):
                raise RelayError(409, "already_registered", "已有帳號，請用 /relay-account reset 重設密碼。")
            password = secrets.token_urlsafe(24)
            async with self.service.password_slots:
                encoded = await asyncio.to_thread(hash_password, password)
            require_guild(interaction)
            username = self.store.register(user_id, encoded)
            await interaction.followup.send(
                f"GuildPort 帳號已建立。這組帳密僅用於 GuildPort。\n"
                f"帳號：`{username}`\n初始密碼：||`{password}`||\n"
                "請保存初始密碼；之後不再顯示，可用 /relay-account reset 重設。\n\n"
                + quick_start(self.public_url, username),
                ephemeral=True, allowed_mentions=discord.AllowedMentions.none())

        @app_commands.command(name="dcgp", description="取得 GuildPort 網頁入口與 CLI 登入指令")
        @app_commands.guild_only()
        @app_commands.allowed_installs(guilds=True, users=False)
        async def dcgp(interaction: discord.Interaction):
            require_guild(interaction)
            row = self.store.account(str(interaction.user.id))
            content = (quick_start(self.public_url, row["username"]) if row else
                       "請先執行 `/register`，閱讀隱私說明並同意後建立 GuildPort 帳號，再用 `/dcgp` 取得登入指令。")
            await interaction.response.send_message(
                content + "\n\n提醒：訊息經 Relay 處理，並非端對端加密。",
                ephemeral=True, allowed_mentions=discord.AllowedMentions.none())

        account = app_commands.Group(name="relay-account", description="管理 GuildPort 網頁與 CLI 帳號",
            guild_only=True, allowed_installs=app_commands.AppInstallationType(guild=True, user=False))

        @account.command(name="reset", description="產生新密碼並撤銷所有裝置登入")
        async def reset(interaction: discord.Interaction):
            await interaction.response.defer(ephemeral=True, thinking=True)
            password = secrets.token_urlsafe(24)
            async with self.service.password_slots:
                encoded = await asyncio.to_thread(hash_password, password)
            self.store.reset(str(interaction.user.id), encoded)
            await interaction.followup.send(f"所有裝置已登出。新密碼：||`{password}`||", ephemeral=True)

        @account.command(name="logout-all", description="撤銷所有網頁與 CLI 登入")
        async def logout_all(interaction: discord.Interaction):
            self.store.revoke_all(str(interaction.user.id))
            await interaction.response.send_message("所有裝置已登出。", ephemeral=True)

        @account.command(name="delete", description="刪除 GuildPort 帳號與登入資料")
        async def delete(interaction: discord.Interaction, confirm: bool):
            if confirm:
                self.store.delete_account(str(interaction.user.id))
            await interaction.response.send_message("GuildPort 帳號已刪除。" if confirm else "未刪除帳號。", ephemeral=True)

        admin = app_commands.Group(name="relay", description="管理 GuildPort 可用頻道",
            guild_only=True, default_permissions=discord.Permissions(manage_guild=True),
            allowed_installs=app_commands.AppInstallationType(guild=True, user=False))

        @admin.command(name="enable", description="開放此文字頻道給具原始權限的 GuildPort 使用者")
        async def enable(interaction: discord.Interaction, channel: discord.TextChannel):
            await interaction.response.defer(ephemeral=True, thinking=True)
            if channel.guild.id != interaction.guild_id:
                raise RelayError(403, "wrong_guild", "請選擇目前伺服器的頻道。")
            guild_id, user_id, channel_id = str(interaction.guild_id), str(interaction.user.id), str(channel.id)
            await self.adapter.require_admin(guild_id, user_id)
            await self.adapter.authorize(user_id, guild_id, channel_id)
            self.store.enable(guild_id, channel_id, user_id)
            await interaction.followup.send(
                f"已開放 <#{channel_id}> 的 GuildPort 存取。請告知成員此頻道使用 GuildPort；"
                "只有具原始權限的已註冊成員可使用。\n\n"
                + privacy_notice(self.store.delivery_retention_hours, self.service.read_recheck_seconds),
                ephemeral=True, allowed_mentions=discord.AllowedMentions.none())

        @admin.command(name="disable", description="停止此頻道的 GuildPort 存取")
        async def disable(interaction: discord.Interaction, channel: discord.TextChannel):
            await interaction.response.defer(ephemeral=True, thinking=True)
            if channel.guild.id != interaction.guild_id:
                raise RelayError(403, "wrong_guild", "請選擇目前伺服器的頻道。")
            await self.adapter.require_admin(str(interaction.guild_id), str(interaction.user.id))
            self.store.disable(str(channel.id))
            self.service.hub.publish(channel.id, {"type": "resync_required"})
            await interaction.followup.send("已停止此頻道的 GuildPort 存取。", ephemeral=True)

        for command in (register, dcgp, reset, logout_all, delete, enable, disable):
            command.error(command_error)
            command.extras["guildport_error_handler"] = True
        for command in (register, dcgp, account, admin):
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
        await self.adapter.close()
        self.store.close()
        for name in self._commands:
            self.tree.remove_command(name)

    async def on_message(self, message: discord.Message):
        if (message.guild is not None and not self.closed
                and str(message.channel.id) in self.service.hub.listeners
                and self.store.channel(str(message.channel.id)) is not None):
            self.service.hub.publish(message.channel.id,
                {"type": "message.created", "message": message_data(message, self.client.user.id if self.client.user else None)})

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
