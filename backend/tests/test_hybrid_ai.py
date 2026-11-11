from pathlib import Path

import pytest

import hybrid_ai
import voice_agent
from voice_state import VoiceConversation


def test_query_plan_rejects_unknown_tools() -> None:
    plan = hybrid_ai.QueryPlan(
        route=hybrid_ai.Route.SQL_ONLY,
        intent="sales_summary",
        language="en",
        confidence=0.9,
        requested_operation="sum",
        tools=["not_a_business_tool"],
    )
    with pytest.raises(ValueError, match="Unknown business tool"):
        hybrid_ai.validate_plan(plan)


def test_business_action_requires_confirmation() -> None:
    plan = hybrid_ai.QueryPlan(
        route=hybrid_ai.Route.BUSINESS_ACTION,
        intent="create_customer",
        language="en",
        confidence=0.9,
        requested_operation="create",
    )
    with pytest.raises(ValueError, match="explicit confirmation"):
        hybrid_ai.validate_plan(plan)


def test_retrieval_uses_only_approved_text_files(tmp_path: Path, monkeypatch) -> None:
    (tmp_path / "policy.md").write_text(
        "# Cancellation policy\n\nOrders may be cancelled before production starts.",
        encoding="utf-8",
    )
    (tmp_path / "ignored.pdf").write_bytes(b"not indexed")
    monkeypatch.setattr(hybrid_ai, "knowledge_root", lambda: tmp_path)

    evidence = hybrid_ai.retrieve_approved_documents("What is the cancellation policy?")

    assert len(evidence) == 1
    assert evidence[0]["source"] == "policy.md"
    assert "cancelled" in evidence[0]["content"]
    assert len(evidence[0]["content_hash"]) == 64


def test_knowledge_question_does_not_invent_answer(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(hybrid_ai, "knowledge_root", lambda: tmp_path)
    conversation = VoiceConversation(session_id="test", admin_id=1, auth_session_id="auth")

    reply = voice_agent._deterministic_turn(None, conversation, "Explain our cancellation policy")

    assert "approved business knowledge base" in reply.reply
    assert reply.data["route"] == "RAG_ONLY"
