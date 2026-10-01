from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import re

import discord

from .models import Access, RelayError


def message_data(message: discord.Message) -> dict:
    return {"id": str(message.id), "channel_id": str(message.channel.id),
            "author": {"id": str(message.author.id), "name": message.author.display_name,
                       "bot": message.author.bot},
            "content": message.content, "created_at": message.created_at.isoformat(),
            "attachments": [{"name": a.filename, "url": a.url} for a in message.attachments]}


async def discord_call(coro):
    try:
        return await coro
    except (discord.Forbidden, discord.NotFound):
        raise RelayError(403, "discord_access_denied", "Discord membership or channel access is unavailable.")
    except (discord.HTTPException, OSError, asyncio.TimeoutError):
        raise RelayError(503, "discord_unavailable", "Cannot verify Discord permissions right now.")


class DiscordAdapter:
    def __init__(self, client: discord.Client):
        self.client = client
        self.slots = asyncio.Semaphore(4)

    def ready(self):
        if not self.client.is_ready() or self.client.user is None:
            raise RelayError(503, "discord_unavailable", "Discord is reconnecting. Try again shortly.")

    async def require_admin(self, guild_id: str, user_id: str):
        self.ready()
        guild = await discord_call(self.client.fetch_guild(int(guild_id)))
        member = await discord_call(guild.fetch_member(int(user_id)))
        if not member.guild_permissions.manage_guild or member.pending or member.is_timed_out():
            raise RelayError(403, "admin_required", "Manage Server permission is required.")

    async def authorize(self, user_id: str, guild_id: str, channel_id: str, *, for_send: bool = False) -> Access:
        self.ready()
        async with self.slots:
            # Fresh guild roles, channel overwrites and both members. Guild-only
            # permissions or discord.py's member cache alone are insufficient.
            guild = await discord_call(self.client.fetch_guild(int(guild_id)))
            channels, user, bot = await discord_call(asyncio.gather(
                guild.fetch_channels(), guild.fetch_member(int(user_id)),
                guild.fetch_member(self.client.user.id)))
        channel = next((c for c in channels if str(c.id) == channel_id), None)
        if (not isinstance(channel, discord.TextChannel) or channel.type != discord.ChannelType.text
                or channel.is_nsfw() or user.pending):
            raise RelayError(403, "channel_unavailable", "Only enabled, non-age-restricted text channels are supported.")
        up, bp = channel.permissions_for(user), channel.permissions_for(bot)
        if not all((up.view_channel, up.read_message_history, bp.view_channel, bp.read_message_history)):
            raise RelayError(403, "channel_unavailable", "You and the bot must be able to view channel history.")
        can_send = up.send_messages and bp.send_messages and not user.is_timed_out()
        reason = None if can_send else "Your permissions, timeout, or bot permissions prevent sending."
        # Bot API data cannot establish a user's verified email/phone status.
        # Only an explicit guild exemption or administrator status is sufficient.
        if (guild.verification_level != discord.VerificationLevel.none
                and not up.administrator and not user.flags.bypasses_verification):
            can_send = False
            reason = "Guild verification eligibility cannot be confirmed by the bot; this channel is read only in GuildPort."
        bypass = up.manage_messages or up.manage_channels or getattr(up, "bypass_slowmode", False)
        if for_send and can_send and channel.slowmode_delay and not bypass:
            # Native Discord sends must count too, including sends before startup
            # or missed during a Gateway disconnect. A truncated window fails closed.
            async def recent():
                cutoff = datetime.now(timezone.utc) - timedelta(seconds=channel.slowmode_delay)
                return [m async for m in channel.history(limit=101, after=cutoff)]
            messages = await discord_call(recent())
            if any(str(m.author.id) == user_id for m in messages):
                raise RelayError(429, "slowmode", "A recent Discord message is still inside this channel's slowmode window.")
            if len(messages) >= 101:
                raise RelayError(429, "slowmode_unverified", "Cannot safely verify the channel's slowmode window. Try later or use Discord.")
        return Access(guild_id, guild.name, channel_id, channel.name, user.display_name,
                      bool(can_send), 0 if bypass else channel.slowmode_delay, channel, reason)

    async def history(self, access: Access, limit: int, before: str | None) -> list[dict]:
        async def fetch():
            messages = [message_data(m) async for m in access.target.history(
                limit=limit, before=discord.Object(id=int(before)) if before else None)]
            return list(reversed(messages))
        return await discord_call(fetch())

    async def send(self, access: Access, user_id: str, content: str) -> dict:
        name = re.sub(r"[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]", "", access.display_name)[:40]
        name = discord.utils.escape_markdown(name)
        message = await discord_call(access.target.send(
            f"**{name} · via GuildPort** (`{user_id}`)\n{content}",
            allowed_mentions=discord.AllowedMentions.none(), suppress_embeds=True))
        return {"id": str(message.id)}
