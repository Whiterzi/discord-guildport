from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import re

import discord

from .models import Access, RelayError


def message_data(message: discord.Message, relay_bot_id: int | None = None) -> dict:
    result = {"id": str(message.id), "channel_id": str(message.channel.id),
            "author": {"id": str(message.author.id), "name": message.author.display_name,
                       "bot": message.author.bot},
            "content": message.content, "created_at": message.created_at.isoformat(),
            "attachments": [{"name": a.filename, "url": a.url} for a in message.attachments]}
    # Only our own bot's messages can supply relay attribution. Other bots/users
    # can copy text or embed fields, so a marker alone is never proof of identity.
    own_message = message.author.id == relay_bot_id and not getattr(message, "webhook_id", None)
    if own_message:
        for embed in message.embeds:
            match = re.fullmatch(r"via GuildPort · ([1-9][0-9]{0,19})", embed.footer.text or "")
            if match and embed.author.name and embed.description is not None:
                result["relay_author"] = {"id": match[1], "name": embed.author.name}
                result["relay_content"] = embed.description
                # Keep alpha.1 clients readable too: they do not know relay_author.
                name = discord.utils.escape_markdown(embed.author.name)
                result["content"] = f"**{name} · via GuildPort** (`{match[1]}`)\n{embed.description}"
                return result
        legacy = re.match(r"^\*\*(.+) · via GuildPort\*\* \(`([1-9][0-9]{0,19})`\)\n", message.content)
        if legacy:
            result["relay_author"] = {"id": legacy[2], "name": re.sub(r"\\([\\*_~`])", r"\1", legacy[1])}
            result["relay_content"] = message.content[legacy.end():]
            return result
    # Embed-only messages used to appear as empty entries in the terminal.
    if not result["content"] and message.embeds:
        parts = []
        for embed in message.embeds[:10]:
            parts.extend(str(value) for value in (embed.author.name, embed.title, embed.description, embed.url) if value)
            for field in embed.fields[:25]:
                parts.append(f"{field.name}: {field.value}")
        result["content"] = "\n".join(parts)[:12000] or "[Embedded media]"
    return result


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
                      bool(can_send), 0 if bypass else channel.slowmode_delay, channel, reason,
                      can_embed=bool(up.embed_links and bp.embed_links),
                      avatar_url=str(user.display_avatar.replace(size=64).url))

    async def history(self, access: Access, limit: int, before: str | None) -> list[dict]:
        async def fetch():
            messages = [message_data(m, self.client.user.id) async for m in access.target.history(
                limit=limit, before=discord.Object(id=int(before)) if before else None)]
            return list(reversed(messages))
        return await discord_call(fetch())

    async def send(self, access: Access, user_id: str, content: str) -> dict:
        name = re.sub(r"[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]", "", access.display_name)[:40]
        if access.can_embed:
            embed = discord.Embed(description=content, colour=0x9B8AFB)
            embed.set_author(name=name or "GuildPort user", icon_url=access.avatar_url)
            embed.set_footer(text=f"via GuildPort · {user_id}")
            message = await discord_call(access.target.send(
                embed=embed, allowed_mentions=discord.AllowedMentions.none()))
            return {"id": str(message.id)}
        name = discord.utils.escape_markdown(name)
        message = await discord_call(access.target.send(
            f"**{name} · via GuildPort** (`{user_id}`)\n{content}",
            allowed_mentions=discord.AllowedMentions.none(), suppress_embeds=True))
        return {"id": str(message.id)}
