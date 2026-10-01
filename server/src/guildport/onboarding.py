"""Private Discord onboarding; never place passwords or bearer tokens in commands."""
from __future__ import annotations

import logging
import time

import discord

from .models import RelayError

LOG = logging.getLogger(__name__)
CLI_PACKAGE = "discord-guildport@0.1.0-alpha.1"


def privacy_notice(retention_hours: int) -> str:
    return (
        "**GuildPort 隱私說明**\n"
        "訊息會經過 Relay 主機，並非端對端加密；主機管理者可讀取內容，"
        "HTTPS 代理服務供應者（如 Cloudflare）也可能處理明文。\n"
        "Relay 不將訊息本文存入資料庫，但會暫存在記憶體以轉送。"
        f"送信去重紀錄含使用者／頻道／訊息 ID 與帶密鑰的內容指紋，保留 {retention_hours} 小時，"
        "到期後於下一次清理移除（正常每 5 分鐘）。\n"
        "帳號與 Discord ID 綁定，保留至刪除帳號；登入有效七天，可隨時撤銷。"
        "刪除帳號不會刪除已送到 Discord 的訊息、收件者副本或既有備份。\n"
        "僅開放管理員啟用且你與 bot 都有權限的頻道；代送訊息會標示你的身分。\n"
        "[完整資料處理說明](https://github.com/Whiterzi/discord-guildport/blob/main/docs/privacy.md)"
    )


def quick_start(public_url: str, username: str) -> str:
    # Both arguments are constrained by the plugin/store to shell-safe characters.
    # Single quotes work in POSIX shells and PowerShell; no passwords/tokens here.
    login = f"npx --yes --package={CLI_PACKAGE} dcgp login --server '{public_url}' --username '{username}'"
    browse = f"npx --yes --package={CLI_PACKAGE} dcgp"
    return (
        "**貼上即可使用（Node.js 22.13+；macOS／Linux／PowerShell）**\n"
        "第一次執行會從 npm 下載指定版本。先貼上登入指令，再於提示時輸入 GuildPort 密碼：\n"
        f"```sh\n{login}\n```\n"
        "登入成功後貼上這行，用 ↑／↓ 與 Enter 選伺服器、頻道：\n"
        f"```sh\n{browse}\n```\n"
        "指令不含密碼或 token；登入憑證會存於本機。請勿分享憑證檔案。\n"
        "忘記密碼可用 `/relay-account reset`；已有登入時可直接執行第二行。"
    )


async def command_error(interaction, error):
    cause = getattr(error, "original", error)
    if isinstance(cause, RelayError):
        message = cause.message
    else:
        LOG.error("GuildPort command failed (%s)", type(cause).__name__)
        message = "操作失敗，請稍後再試。"
    sender = interaction.followup.send if interaction.response.is_done() else interaction.response.send_message
    await sender(message, ephemeral=True, allowed_mentions=discord.AllowedMentions.none())


class RegistrationView(discord.ui.View):
    def __init__(self, user_id: int, guild_id: int, create_account):
        super().__init__(timeout=300)
        self.user_id, self.guild_id = user_id, guild_id
        self.create_account = create_account
        self.deadline = time.monotonic() + 300
        self.used = False

    async def interaction_check(self, interaction):
        if (interaction.user.id != self.user_id or interaction.guild_id != self.guild_id
                or self.used or time.monotonic() >= self.deadline):
            await interaction.response.send_message("請重新執行 `/register` 開啟自己的註冊說明。", ephemeral=True)
            return False
        return True

    @discord.ui.button(label="我已了解，同意建立帳號", style=discord.ButtonStyle.primary)
    async def accept(self, interaction: discord.Interaction, button: discord.ui.Button):
        # Recheck within the callback too: two clicks can overlap while dispatched.
        if not await self.interaction_check(interaction):
            return
        self.used = True
        self.stop()
        await interaction.response.edit_message(content="已同意隱私說明，正在建立帳號…", view=None)
        await self.create_account(interaction)

    async def on_error(self, interaction, error, item):
        await command_error(interaction, error)
