"""Environment-backed configuration for the zero-cost voice assistant.

Secrets are read on demand and are never returned to the browser, written to
logs, or embedded in prompts.  The deterministic provider is the default so the
assistant remains useful with no external account or API key.
"""
from __future__ import annotations

import os


def _int(name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default
    return max(low, min(high, value))


def _float(name: str, default: float, low: float, high: float) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default
    return max(low, min(high, value))


def conversation_ttl_seconds() -> int:
    return _int("VOICE_CONVERSATION_TTL_SECONDS", 30 * 60, 60, 8 * 60 * 60)


def confirmation_ttl_seconds() -> int:
    return _int("VOICE_CONFIRMATION_TTL_SECONDS", 5 * 60, 30, 30 * 60)


def max_history_messages() -> int:
    return _int("VOICE_MAX_HISTORY_MESSAGES", 32, 4, 80)


def max_transcript_chars() -> int:
    return _int("VOICE_MAX_TRANSCRIPT_CHARS", 1200, 120, 4000)


def llm_provider() -> str:
    """Explicit provider selection.  Never auto-select a paid provider."""
    return os.getenv("VOICE_LLM_PROVIDER", "deterministic").strip().lower() or "deterministic"


def llm_timeout_seconds() -> float:
    return _float("VOICE_LLM_TIMEOUT_SECONDS", 20.0, 3.0, 60.0)


def max_tool_iterations() -> int:
    return _int("VOICE_MAX_TOOL_ITERATIONS", 4, 1, 8)


def max_tool_calls_per_turn() -> int:
    return _int("VOICE_MAX_TOOL_CALLS_PER_TURN", 6, 1, 12)


def groq_api_key() -> str:
    return os.getenv("GROQ_API_KEY", "").strip()


def groq_chat_model() -> str:
    # Deliberately not hard-coded: the administrator must set a model that is
    # currently available on their own zero-cost allowance.
    return os.getenv("GROQ_CHAT_MODEL", "").strip()


def groq_base_url() -> str:
    return os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1").rstrip("/")


def groq_stt_model() -> str:
    return os.getenv("GROQ_STT_MODEL", "whisper-large-v3-turbo").strip()


def ollama_base_url() -> str:
    return os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")


def ollama_chat_model() -> str:
    return os.getenv("OLLAMA_CHAT_MODEL", "").strip()


def stt_provider() -> str:
    return os.getenv("VOICE_STT_PROVIDER", "local").strip().lower() or "local"


def stt_language() -> str | None:
    value = os.getenv("VOICE_STT_LANGUAGE", "").strip()
    return value or None


def stt_prompt() -> str:
    return os.getenv(
        "VOICE_STT_PROMPT",
        "Lalitha Apparel embroidery blouse salwar chudi pavadai lehenga aari "
        "measurements bust waist shoulder sleeve armhole Madurai Tamil Tanglish",
    ).strip()


def tts_provider() -> str:
    return os.getenv("VOICE_TTS_PROVIDER", "browser").strip().lower() or "browser"


def provider_label() -> str:
    provider = llm_provider()
    if provider == "groq":
        return "Groq (configured)"
    if provider == "ollama":
        return "Ollama (local)"
    return "Built-in command parser"


def audio_types() -> set[str]:
    return {"audio/webm", "audio/ogg", "audio/wav", "audio/mpeg", "audio/mp4", "audio/x-m4a"}
