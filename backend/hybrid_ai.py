"""Safe routing primitives for the hybrid business assistant.

This module deliberately does not execute SQL or call an LLM.  It validates
plans, exposes the existing allowlisted tool names, and retrieves only from
explicitly approved local Markdown/text documents.  Database access remains in
``voice_tools`` and authorization remains in the authenticated API layer.
"""
from __future__ import annotations

import hashlib
import os
import re
from enum import Enum
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class Route(str, Enum):
    RAG_ONLY = "RAG_ONLY"
    SQL_ONLY = "SQL_ONLY"
    HYBRID_RAG_SQL = "HYBRID_RAG_SQL"
    BUSINESS_ACTION = "BUSINESS_ACTION"
    CLARIFICATION = "CLARIFICATION"
    UNSUPPORTED = "UNSUPPORTED"


class DateRange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: str = Field(min_length=1, max_length=32)
    start: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    end: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")


class QueryEntities(BaseModel):
    model_config = ConfigDict(extra="forbid")

    customer: str | None = Field(default=None, max_length=120)
    order_id: int | None = Field(default=None, ge=1)
    product: str | None = Field(default=None, max_length=120)
    amount: float | None = Field(default=None, ge=0)


class QueryFilters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    date_range: DateRange | None = None
    status: str | None = Field(default=None, max_length=40)


class QueryPlan(BaseModel):
    """Validated intent output; tool execution is a separate trusted step."""

    model_config = ConfigDict(extra="forbid")

    route: Route
    intent: str = Field(min_length=1, max_length=80)
    language: str = Field(min_length=2, max_length=16)
    confidence: float = Field(ge=0, le=1)
    entities: QueryEntities = Field(default_factory=QueryEntities)
    filters: QueryFilters = Field(default_factory=QueryFilters)
    requested_operation: str = Field(min_length=1, max_length=40)
    data_sources: list[str] = Field(default_factory=list, max_length=4)
    tools: list[str] = Field(default_factory=list, max_length=4)
    missing_information: list[str] = Field(default_factory=list, max_length=4)
    requires_confirmation: bool = False


def allowed_tool_names() -> frozenset[str]:
    """Read the canonical allowlist without duplicating tool definitions."""
    import voice_tools

    return frozenset(voice_tools.TOOLS)


def validate_plan(plan: QueryPlan) -> QueryPlan:
    unknown = set(plan.tools) - allowed_tool_names()
    if unknown:
        raise ValueError(f"Unknown business tool(s): {', '.join(sorted(unknown))}")
    if plan.route == Route.BUSINESS_ACTION and not plan.requires_confirmation:
        raise ValueError("Business actions must require explicit confirmation.")
    if plan.route == Route.RAG_ONLY and "knowledge_base" not in plan.data_sources:
        raise ValueError("RAG plans must identify the knowledge base.")
    return plan


def knowledge_root() -> Path:
    configured = os.getenv("VOICE_KNOWLEDGE_DIR", "").strip()
    return Path(configured) if configured else Path(__file__).with_name("knowledge")


def _tokens(text: str) -> set[str]:
    return {
        token.casefold()
        for token in re.findall(r"[A-Za-z0-9\u0B80-\u0BFF]{3,}", text or "")
    }


def retrieve_approved_documents(query: str, limit: int = 4) -> list[dict[str, Any]]:
    """Return lexical evidence from approved .md/.txt files only.

    This is intentionally a deterministic baseline, not a claim of vector-RAG
    quality.  Missing or malformed documents are skipped and never synthesized.
    """
    root = knowledge_root()
    if not root.is_dir():
        return []
    query_tokens = _tokens(query)
    results: list[dict[str, Any]] = []
    for path in sorted(root.iterdir()):
        if path.suffix.casefold() not in {".md", ".txt"} or not path.is_file():
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            continue
        raw_paragraphs = [part.strip() for part in re.split(r"\n\s*\n", content) if part.strip()]
        paragraphs: list[str] = []
        pending_heading = ""
        for paragraph in raw_paragraphs:
            if paragraph.startswith("#"):
                pending_heading = paragraph
                continue
            paragraphs.append(f"{pending_heading}\n{paragraph}" if pending_heading else paragraph)
            pending_heading = ""
        if pending_heading:
            paragraphs.append(pending_heading)
        for index, paragraph in enumerate(paragraphs):
            overlap = len(query_tokens & _tokens(paragraph))
            if overlap == 0:
                continue
            results.append(
                {
                    "source": path.name,
                    "chunk_index": index,
                    "content": paragraph[:2000],
                    "score": round(overlap / max(len(query_tokens), 1), 4),
                    "content_hash": hashlib.sha256(paragraph.encode("utf-8")).hexdigest(),
                }
            )
    results.sort(key=lambda item: (-item["score"], item["source"], item["chunk_index"]))
    return results[: max(1, min(limit, 8))]
