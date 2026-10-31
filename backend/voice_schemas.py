"""Typed public contracts for the temporary voice-assistant workflow."""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class VoiceTurnRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1200)


class VoiceConfirmRequest(BaseModel):
    confirmation_id: str = Field(min_length=16, max_length=128)
    # An explicit spoken/typed confirmation phrase.  A bare "yes" is not enough.
    confirmation_phrase: str = Field(min_length=2, max_length=240)


class VoiceDraftPatch(BaseModel):
    measurements: Optional[dict[str, str]] = None
    total_amount: Optional[float] = Field(default=None, ge=0, le=100_000_000)
    paid_amount: Optional[float] = Field(default=None, ge=0, le=100_000_000)
    extra_amount: Optional[float] = Field(default=None, ge=0, le=100_000_000)
    delivery_date: Optional[str] = Field(default=None, max_length=20)
    description: Optional[str] = Field(default=None, max_length=1000)
    customer_id: Optional[int] = Field(default=None, ge=1)
    product_id: Optional[int] = Field(default=None, ge=1)


class VoiceCancelRequest(BaseModel):
    scope: Literal["pending", "draft"] = "draft"


class VoiceTurnResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    session_id: str
    reply: str
    messages: list[dict[str, str]] = Field(default_factory=list)
    task: Optional[dict[str, Any]] = None
    pending_operation: Optional[dict[str, Any]] = None
    ui_action: Optional[dict[str, Any]] = None
    provider: Optional[str] = None
    warnings: list[str] = Field(default_factory=list)
    data: Optional[dict[str, Any]] = None
