from __future__ import annotations

import asyncio
from copy import copy
from datetime import datetime, timedelta, timezone
import re

import discord

from .models import Access, RelayError


def message_data(message: discord.Message, relay_bot_id: int | None = None) -> dict:
    result = {"id": str(message.id), "channel_id": str(message.channel.id),
            "author": {"id": str(message.author.id), "name": message.author.display_name,
                       "bot": message.author.bot},
            "content": message.content, "created_at": message.created_at.isoformat(),
            "attachments": [{"name": a.filename, "url": a.url, "spoiler": a.is_spoiler()} for a in message.attachments]}
    # Discord refreshes signed attachment URLs in embed image/thumbnail metadata,
    # not necessarily in message text. Preserve that metadata for browser previews.
    media = []
    seen = {}
    for embed in message.embeds[:10]:
        for field in (embed.image, embed.thumbnail):
            url = field.url
            if not url:
                continue
            if url in seen:
                if field.proxy_url and "proxy_url" not in seen[url]:
                    seen[url]["proxy_url"] = field.proxy_url
                continue
            item = seen[url] = {"url": url}
            if field.proxy_url:
                item["proxy_url"] = field.proxy_url
            media.append(item)
    if media:
        result["media"] = media
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
        result["content"] = "\n".join(parts)[:12000] or ("" if media else "[Embedded media]")
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
        self._requests = {}

    def ready(self):
        if not self.client.is_ready() or self.client.user is None:
            raise RelayError(503, "discord_unavailable", "Discord is reconnecting. Try again shortly.")

    async def close(self):
        tasks = list(self._requests.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def require_admin(self, guild_id: str, user_id: str):
        self.ready()
        guild = await discord_call(self.client.fetch_guild(int(guild_id)))
        member = await discord_call(guild.fetch_member(int(user_id)))
        if not member.guild_permissions.manage_guild or member.pending or member.is_timed_out():
            raise RelayError(403, "admin_required", "Manage Server permission is required.")

    async def _snapshot(self, user_id: str, guild_id: str, channel_id: str):
        async with self.slots:
            # This isolated Guild is only a REST lookup handle, never a permission
            # source. Fetch all four endpoints concurrently using discord.py's
            # shared HTTP client/rate limits, then bind results to the fresh roles.
            lookup = discord.Guild(state=self.client._connection, data={"id": guild_id, "roles": []})
            # Listing every guild channel has a separate, tight Discord rate
            # limit. The single-channel route supplies the same overwrites we
            # need here, without that guild-wide list request on every check.
            guild, channel, user, bot = await discord_call(asyncio.gather(
                self._request(("guild", guild_id), lambda: self.client.fetch_guild(int(guild_id), with_counts=False)),
                self._request(("channel", channel_id), lambda: self.client.fetch_channel(int(channel_id))),
                self._request(("member", guild_id, user_id), lambda: lookup.fetch_member(int(user_id))),
                self._request(("member", guild_id, str(self.client.user.id)), lambda: lookup.fetch_member(self.client.user.id))))
            # Verify the actual channel's guild before attaching fresh roles.
            # Never turn a wrong-guild channel or DM into an authorized target.
            if (not isinstance(channel, discord.TextChannel) or channel.guild.id != guild.id
                    or str(channel.id) != channel_id):
                raise RelayError(403, "channel_unavailable", "Channel does not belong to the enabled guild.")
            # Individual REST results may be shared by checks for other users or
            # channels. Bind private copies so concurrent role snapshots cannot
            # overwrite each other's permission context (or the Gateway cache).
            channel, user, bot = copy(channel), copy(user), copy(bot)
            for item in (channel, user, bot):
                item.guild = guild
            return guild, channel, user, bot

    async def _request(self, key, fetch):
        # Share only requests still in flight. Completed permission results are
        # never cached: the next operation must verify Discord again.
        task = self._requests.get(key)
        if task is None or task.done():
            task = asyncio.create_task(fetch())
            self._requests[key] = task

            def finished(done):
                if self._requests.get(key) is done:
                    del self._requests[key]
                if not done.cancelled():
                    done.exception()  # Also consume errors if every waiter disconnected.

            task.add_done_callback(finished)
        return await asyncio.shield(task)

    async def authorize(self, user_id: str, guild_id: str, channel_id: str, *, for_send: bool = False) -> Access:
        self.ready()
        guild, channel, user, bot = await self._snapshot(user_id, guild_id, channel_id)
        self.ready()
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
                      avatar_url=str(user.display_avatar.replace(size=64).url),
                      user_role_ids=frozenset(str(role.id) for role in user.roles),
                      bot_role_ids=frozenset(str(role.id) for role in bot.roles))

    async def emojis(self, access: Access) -> list[dict]:
        self.ready()
        async with self.slots:
            emojis = await discord_call(access.target.guild.fetch_emojis())
        return [{"id": str(emoji.id), "name": emoji.name, "animated": emoji.animated,
                 "available": emoji.available, "roles": [str(role) for role in emoji._roles]}
                for emoji in emojis]

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
