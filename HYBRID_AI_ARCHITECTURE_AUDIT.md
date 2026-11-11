# Hybrid AI Architecture Audit

## Current implementation

- `backend/voice_agent.py` is the turn orchestrator.
- `backend/voice_parsing.py` normalizes Tamil, Tanglish, English, dates, money,
  measurements, and business terms.
- `backend/voice_tools.py` is the authenticated allowlisted SQL/business-tool
  layer. Writes prepare previews and require confirmation.
- `backend/voice_state.py` scopes bounded conversation state to admin/session.
- `backend/voice_providers.py` contains lazy local Whisper, whisper.cpp, optional
  Groq, and optional chat-provider adapters.
- `frontend/src/VoiceAssistantPanel.jsx` and `frontend/src/voice/*` provide the
  floating assistant and speech UX.

## Newly implemented foundation

`backend/hybrid_ai.py` adds strict route/query-plan models, allowlist validation,
and evidence-only retrieval from explicitly approved `.md`/`.txt` files under
`VOICE_KNOWLEDGE_DIR` (default `backend/knowledge`). It does not execute SQL,
authorize users, call paid services, or synthesize missing evidence.

## Not implemented or not verified

There is no vector store, document upload/reindex API, embedding model, local
LLM benchmark, citation-quality benchmark, or production knowledge corpus.
The default knowledge directory is intentionally absent/empty. These must be
completed and tested in staging before claiming production RAG.
