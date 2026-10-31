"""Transcription and chat providers for the zero-cost voice assistant.

The default speech-to-text provider is local Faster-Whisper.  A Groq Whisper
provider is available only when an administrator explicitly selects it and
supplies a key; there is no automatic paid fallback.  Chat can use Groq or a
local Ollama model, otherwise the deterministic command parser in
:mod:`voice_agent` handles the turn.

Audio bytes, transcripts, prompts, and model responses are never written to the
database.  A temporary file exists only for the duration of a local decode and
is deleted in a ``finally`` block.
"""
from __future__ import annotations

import io
import os
import tempfile
import threading
from typing import Any, Protocol

import httpx

import voice_config


class VoiceProviderError(RuntimeError):
    """A safe provider error that may be shown to the administrator."""


class Transcriber(Protocol):
    def transcribe(self, audio: bytes, filename: str, language: str | None = None) -> str: ...


_model_lock = threading.Lock()
_local_model = None


def configured_provider() -> str:
    return voice_config.stt_provider()


def audio_duration_seconds(audio: bytes) -> float | None:
    """Inspect duration with PyAV when available; do not reject audio if absent."""
    try:
        import av  # installed by faster-whisper when local STT is installed

        with av.open(io.BytesIO(audio), mode="r") as container:
            if container.duration is None:
                return None
            return float(container.duration / av.time_base)
    except ImportError:
        # The transcription provider still decodes/validates the bytes. This
        # avoids treating a valid browser WebM as corrupt before optional local
        # STT dependencies have been installed.
        return None
    except Exception:
        # Browser containers can omit duration metadata. Let the decoder decide.
        return None


class LocalFasterWhisper:
    def _model(self):
        global _local_model
        if _local_model is not None:
            return _local_model
        with _model_lock:
            if _local_model is not None:
                return _local_model
            try:
                from faster_whisper import WhisperModel
            except ImportError as exc:
                raise VoiceProviderError(
                    "Local transcription is not installed. Install faster-whisper "
                    "and download a model first."
                ) from exc
            try:
                _local_model = WhisperModel(
                    os.getenv("VOICE_LOCAL_MODEL_SIZE", "base"),
                    device=os.getenv("VOICE_LOCAL_DEVICE", "cpu"),
                    compute_type=os.getenv("VOICE_LOCAL_COMPUTE_TYPE", "int8"),
                    cpu_threads=int(os.getenv("VOICE_LOCAL_CPU_THREADS", "4")),
                )
            except Exception as exc:
                raise VoiceProviderError(
                    "Local speech model is unavailable. Check model download, "
                    "CPU/RAM, and server logs."
                ) from exc
        return _local_model

    def transcribe(self, audio: bytes, filename: str, language: str | None = None) -> str:
        suffix = os.path.splitext(filename)[1] or ".webm"
        temporary_path = ""
        try:
            with tempfile.NamedTemporaryFile(
                prefix="voice-", suffix=suffix, delete=False
            ) as handle:
                handle.write(audio)
                temporary_path = handle.name
            try:
                segments, _info = self._model().transcribe(
                    temporary_path,
                    language=language or voice_config.stt_language(),
                    initial_prompt=voice_config.stt_prompt(),
                    vad_filter=True,
                    beam_size=3,
                )
                text = " ".join(segment.text.strip() for segment in segments).strip()
            except VoiceProviderError:
                raise
            except Exception as exc:
                raise VoiceProviderError(
                    "The recording could not be decoded. Please repeat it or type the command."
                ) from exc
            if not text:
                raise VoiceProviderError(
                    "I could not understand that recording. Please repeat or type the command."
                )
            return text
        finally:
            if temporary_path:
                try:
                    os.unlink(temporary_path)
                except FileNotFoundError:
                    pass


class GroqWhisper:
    """Optional Groq transcription. Never selected automatically."""

    def transcribe(self, audio: bytes, filename: str, language: str | None = None) -> str:
        api_key = voice_config.groq_api_key()
        if not api_key:
            raise VoiceProviderError(
                "Groq transcription is selected but GROQ_API_KEY is not configured."
            )
        data: dict[str, str] = {
            "model": voice_config.groq_stt_model(),
            "response_format": "json",
        }
        selected_language = language or voice_config.stt_language()
        if selected_language:
            data["language"] = selected_language
        prompt = voice_config.stt_prompt()
        if prompt:
            data["prompt"] = prompt
        try:
            with httpx.Client(timeout=voice_config.llm_timeout_seconds()) as client:
                response = client.post(
                    f"{voice_config.groq_base_url()}/audio/transcriptions",
                    headers={"Authorization": f"Bearer {api_key}"},
                    data=data,
                    files={
                        "file": (
                            filename or "recording.webm",
                            audio,
                            "application/octet-stream",
                        )
                    },
                )
        except httpx.HTTPError as exc:
            raise VoiceProviderError(
                "The configured transcription service could not be reached."
            ) from exc
        if response.status_code in {401, 403}:
            raise VoiceProviderError(
                "The configured transcription service rejected its credentials."
            )
        if response.status_code == 429:
            raise VoiceProviderError(
                "The configured transcription allowance is exhausted. Try again later "
                "or type the command."
            )
        if response.status_code >= 400:
            raise VoiceProviderError(
                "The configured transcription service could not process the recording."
            )
        try:
            text = str(response.json().get("text", "")).strip()
        except ValueError as exc:
            raise VoiceProviderError(
                "The configured transcription service returned an invalid response."
            ) from exc
        if not text:
            raise VoiceProviderError(
                "I could not understand that recording. Please repeat or type the command."
            )
        return text


def transcribe_audio(audio: bytes, filename: str, language: str | None = None) -> str:
    provider = configured_provider()
    if provider == "groq":
        return GroqWhisper().transcribe(audio, filename, language)
    if provider != "local":
        raise VoiceProviderError(
            "Unknown transcription provider. Use 'local' or an explicitly verified 'groq'."
        )
    return LocalFasterWhisper().transcribe(audio, filename, language)


# ---------------------------------------------------------------------------
# Chat providers (optional). The deterministic parser remains the default.
# ---------------------------------------------------------------------------
class ChatProvider(Protocol):
    name: str

    def chat(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> dict[str, Any]: ...


def _normalize_tool_calls(raw_calls: Any) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for call in raw_calls or []:
        if not isinstance(call, dict):
            continue
        function = call.get("function") or {}
        name = str(function.get("name") or "").strip()
        if not name:
            continue
        arguments = function.get("arguments")
        if isinstance(arguments, dict):
            parsed = arguments
        else:
            parsed = str(arguments or "{}")
        normalized.append(
            {
                "id": str(call.get("id") or ""),
                "name": name,
                "arguments": parsed,
            }
        )
    return normalized


class GroqChat:
    name = "groq"

    def chat(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> dict[str, Any]:
        key = voice_config.groq_api_key()
        model = voice_config.groq_chat_model()
        if not key or not model:
            raise VoiceProviderError(
                "Groq chat is selected but GROQ_API_KEY and GROQ_CHAT_MODEL are not both configured."
            )
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": 0.1,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        try:
            with httpx.Client(timeout=voice_config.llm_timeout_seconds()) as client:
                response = client.post(
                    f"{voice_config.groq_base_url()}/chat/completions",
                    headers={"Authorization": f"Bearer {key}"},
                    json=payload,
                )
        except httpx.HTTPError as exc:
            raise VoiceProviderError(
                "The configured chat service could not be reached. Using the built-in parser."
            ) from exc
        if response.status_code in {401, 403}:
            raise VoiceProviderError(
                "The configured chat service rejected its credentials. Using the built-in parser."
            )
        if response.status_code == 429:
            raise VoiceProviderError(
                "The configured chat allowance is exhausted. Using the built-in parser."
            )
        if response.status_code >= 400:
            raise VoiceProviderError(
                "The configured chat service returned an error. Using the built-in parser."
            )
        try:
            message = response.json()["choices"][0]["message"]
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise VoiceProviderError(
                "The configured chat service returned an invalid response. Using the built-in parser."
            ) from exc
        return {
            "content": str(message.get("content") or ""),
            "tool_calls": _normalize_tool_calls(message.get("tool_calls")),
        }


class OllamaChat:
    name = "ollama"

    def chat(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> dict[str, Any]:
        model = voice_config.ollama_chat_model()
        if not model:
            raise VoiceProviderError(
                "Ollama chat is selected but OLLAMA_CHAT_MODEL is not configured. Using the built-in parser."
            )
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": False,
            "options": {"temperature": 0.1},
        }
        if tools:
            payload["tools"] = tools
        try:
            with httpx.Client(timeout=voice_config.llm_timeout_seconds()) as client:
                response = client.post(
                    f"{voice_config.ollama_base_url()}/api/chat", json=payload
                )
        except httpx.HTTPError as exc:
            raise VoiceProviderError(
                "The local Ollama service could not be reached. Using the built-in parser."
            ) from exc
        if response.status_code >= 400:
            raise VoiceProviderError(
                "The local Ollama service returned an error. Using the built-in parser."
            )
        try:
            message = response.json()["message"]
        except (KeyError, TypeError, ValueError) as exc:
            raise VoiceProviderError(
                "The local Ollama service returned an invalid response. Using the built-in parser."
            ) from exc
        return {
            "content": str(message.get("content") or ""),
            "tool_calls": _normalize_tool_calls(message.get("tool_calls")),
        }


def chat_provider() -> ChatProvider:
    provider = voice_config.llm_provider()
    if provider == "groq":
        return GroqChat()
    if provider == "ollama":
        return OllamaChat()
    raise VoiceProviderError("The built-in command parser is active.")
