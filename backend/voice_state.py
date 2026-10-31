"""Bounded, in-memory conversation state for the voice assistant.

Nothing in this module is persisted to the database.  Audio is never stored
here.  The store is intentionally small and process-local; the deployment notes
explain that a multi-worker or serverless deployment needs a shared store.
"""
from __future__ import annotations

import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from voice_config import (
    confirmation_ttl_seconds,
    conversation_ttl_seconds,
    max_history_messages,
)


@dataclass
class PendingOperation:
    action: str
    payload: dict[str, Any]
    preview: dict[str, Any] = field(default_factory=dict)
    confirmation_id: str = field(default_factory=lambda: secrets.token_urlsafe(24))
    created_at: int = field(default_factory=lambda: int(time.time()))
    expires_at: int = field(default_factory=lambda: int(time.time()) + confirmation_ttl_seconds())

    def expired(self) -> bool:
        return self.expires_at <= int(time.time())

    def public(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "preview": self.preview or self.payload.get("preview", {}),
            "confirmation_id": self.confirmation_id,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
        }


@dataclass
class CompletedOperation:
    confirmation_id: str
    action: str
    result: dict[str, Any]
    completed_at: int = field(default_factory=lambda: int(time.time()))


@dataclass
class VoiceConversation:
    session_id: str
    admin_id: int
    auth_session_id: str
    created_at: int = field(default_factory=lambda: int(time.time()))
    last_activity: int = field(default_factory=lambda: int(time.time()))
    expires_at: int = field(default_factory=lambda: int(time.time()) + conversation_ttl_seconds())
    intent: Optional[str] = None
    draft: dict[str, Any] = field(default_factory=dict)
    missing_fields: list[str] = field(default_factory=list)
    clarification: Optional[str] = None
    awaiting: Optional[dict[str, Any]] = None
    last_field: Optional[str] = None
    pending: Optional[PendingOperation] = None
    completed: dict[str, CompletedOperation] = field(default_factory=dict)
    messages: list[dict[str, str]] = field(default_factory=list)

    def touch(self) -> None:
        now = int(time.time())
        self.last_activity = now
        self.expires_at = now + conversation_ttl_seconds()

    def say(self, role: str, content: str) -> None:
        self.messages.append({"role": role, "content": (content or "")[:1600]})
        self.messages = self.messages[-max_history_messages():]

    def clear_pending(self) -> None:
        self.pending = None

    def clear_draft(self) -> None:
        self.intent = None
        self.draft = {}
        self.missing_fields = []
        self.clarification = None
        self.awaiting = None
        self.last_field = None
        self.pending = None

    def remember_completed(self, pending: PendingOperation, result: dict[str, Any]) -> None:
        self.completed[pending.confirmation_id] = CompletedOperation(
            confirmation_id=pending.confirmation_id,
            action=pending.action,
            result=result,
        )
        cutoff = int(time.time()) - max(confirmation_ttl_seconds() * 4, 600)
        self.completed = {
            key: value for key, value in self.completed.items()
            if value.completed_at >= cutoff
        }
        # Keep memory bounded even during a very long conversation.
        if len(self.completed) > 10:
            newest = sorted(self.completed.values(), key=lambda item: item.completed_at)[-10:]
            self.completed = {item.confirmation_id: item for item in newest}

    def public(self) -> dict[str, Any]:
        task = None
        if self.intent or self.draft or self.missing_fields or self.awaiting:
            task = {
                "intent": self.intent,
                "draft": self.draft,
                "missing_fields": self.missing_fields,
                "clarification": self.clarification,
                "awaiting": self.awaiting,
                "expires_at": self.expires_at,
            }
        return {
            "session_id": self.session_id,
            "messages": self.messages,
            "task": task,
            "pending_operation": self.pending.public() if self.pending else None,
        }


class ConversationStore:
    """Process-local store.  One local worker only; not shared serverless state."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: dict[tuple[int, str], VoiceConversation] = {}

    def get(self, admin_id: int, auth_session_id: str) -> VoiceConversation:
        now = int(time.time())
        key = (admin_id, auth_session_id)
        with self._lock:
            self._prune_locked(now)
            value = self._sessions.get(key)
            if not value:
                value = VoiceConversation(
                    session_id=secrets.token_urlsafe(18),
                    admin_id=admin_id,
                    auth_session_id=auth_session_id,
                )
                self._sessions[key] = value
            if value.pending and value.pending.expired():
                value.pending = None
            value.touch()
            return value

    def delete(self, admin_id: int, auth_session_id: str) -> None:
        with self._lock:
            self._sessions.pop((admin_id, auth_session_id), None)

    def cleanup(self) -> int:
        with self._lock:
            return self._prune_locked(int(time.time()))

    def count(self) -> int:
        with self._lock:
            return len(self._sessions)

    def clear_all(self) -> None:
        """Test helper; not exposed through any HTTP route."""
        with self._lock:
            self._sessions.clear()

    def _prune_locked(self, now: int) -> int:
        expired = [key for key, value in self._sessions.items() if value.expires_at <= now]
        for key in expired:
            self._sessions.pop(key, None)
        for value in self._sessions.values():
            if value.pending and value.pending.expired():
                value.pending = None
        return len(expired)


conversation_store = ConversationStore()
