"""Provider tests that do not download models or call external services."""

import os
from types import SimpleNamespace

import pytest

import voice_config
import voice_providers


def test_unknown_transcription_provider_never_falls_back(monkeypatch) -> None:
    monkeypatch.setenv("VOICE_STT_PROVIDER", "paid-service")
    with pytest.raises(voice_providers.VoiceProviderError) as excinfo:
        voice_providers.transcribe_audio(b"audio", "voice.webm")
    assert "Unknown transcription provider" in str(excinfo.value)


def test_groq_transcription_requires_an_explicit_key_and_is_not_automatic(monkeypatch) -> None:
    monkeypatch.setenv("VOICE_STT_PROVIDER", "groq")
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    with pytest.raises(voice_providers.VoiceProviderError) as excinfo:
        voice_providers.transcribe_audio(b"audio", "voice.webm")
    assert "GROQ_API_KEY" in str(excinfo.value)


def test_local_transcription_returns_the_transcript_and_deletes_the_temp_file(monkeypatch) -> None:
    captured = {}

    class FakeModel:
        def transcribe(self, path, **kwargs):
            captured["path"] = path
            captured["exists_during"] = os.path.exists(path)
            captured["kwargs"] = kwargs
            return (
                [SimpleNamespace(text=" சென்னை "), SimpleNamespace(text="order 500 ")],
                SimpleNamespace(language="ta"),
            )

    transcriber = voice_providers.LocalFasterWhisper()
    monkeypatch.setattr(transcriber, "_model", lambda: FakeModel())

    text = transcriber.transcribe(b"fake audio bytes", "recording.webm")

    assert text == "சென்னை order 500"
    assert captured["exists_during"] is True
    assert not os.path.exists(captured["path"])
    assert captured["kwargs"]["vad_filter"] is True
    assert captured["kwargs"]["beam_size"] == 3


def test_local_transcription_reports_empty_transcripts(monkeypatch) -> None:
    class EmptyModel:
        def transcribe(self, path, **kwargs):
            return ([], None)

    transcriber = voice_providers.LocalFasterWhisper()
    monkeypatch.setattr(transcriber, "_model", lambda: EmptyModel())

    with pytest.raises(voice_providers.VoiceProviderError) as excinfo:
        transcriber.transcribe(b"fake audio bytes", "recording.webm")
    assert "could not understand" in str(excinfo.value)


def test_default_providers_are_local_and_deterministic(monkeypatch) -> None:
    for name in ("VOICE_STT_PROVIDER", "VOICE_LLM_PROVIDER"):
        monkeypatch.delenv(name, raising=False)
    assert voice_config.stt_provider() == "local"
    assert voice_config.llm_provider() == "deterministic"
    assert voice_config.provider_label() == "Built-in command parser"


def test_whispercpp_requires_explicit_binary_and_model(monkeypatch) -> None:
    monkeypatch.setenv("VOICE_STT_PROVIDER", "whispercpp")
    monkeypatch.setenv("VOICE_WHISPERCPP_BINARY", "/missing/whisper-cli")
    monkeypatch.delenv("VOICE_WHISPERCPP_MODEL", raising=False)
    with pytest.raises(voice_providers.VoiceProviderError) as excinfo:
        voice_providers.transcribe_audio(b"RIFF", "voice.wav", "ta")
    assert "executable" in str(excinfo.value)


def test_whispercpp_temp_audio_is_deleted(monkeypatch, tmp_path) -> None:
    binary = tmp_path / "whisper-cli"
    model = tmp_path / "model.bin"
    binary.write_text("placeholder")
    model.write_bytes(b"model")
    monkeypatch.setenv("VOICE_WHISPERCPP_BINARY", str(binary))
    monkeypatch.setenv("VOICE_WHISPERCPP_MODEL", str(model))
    captured = {}

    def fake_run(command, **kwargs):
        captured["path"] = command[command.index("--file") + 1]
        captured["exists_during"] = os.path.exists(captured["path"])
        return SimpleNamespace(returncode=0, stdout=" இன்று விற்பனை எவ்வளவு? ")

    monkeypatch.setattr(voice_providers.subprocess, "run", fake_run)
    result = voice_providers.WhisperCpp().transcribe(b"RIFF audio", "ignored.wav", "ta")
    assert result == "இன்று விற்பனை எவ்வளவு?"
    assert captured["exists_during"] is True
    assert not os.path.exists(captured["path"])
