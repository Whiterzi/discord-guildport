from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


class RelayError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


@dataclass
class Access:
    guild_id: str
    guild_name: str
    channel_id: str
    channel_name: str
    display_name: str
    can_send: bool
    slowmode: int = 0
    target: Any = None
    send_block_reason: str | None = None


class Adapter(Protocol):
    async def authorize(self, user_id: str, guild_id: str, channel_id: str, *, for_send: bool = False) -> Access: ...
    async def history(self, access: Access, limit: int, before: str | None) -> list[dict]: ...
    async def send(self, access: Access, user_id: str, content: str) -> dict: ...
