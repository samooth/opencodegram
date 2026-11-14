#!/usr/bin/env python3
"""Transcribe an audio file with the local Whisper (HuggingFace) model.

Usage: transcribe_whisper.py <audio_file> [language]
  language: ISO code or name (default: es). Prints the transcript to stdout.
"""
import sys
import warnings
from pathlib import Path
warnings.filterwarnings("ignore", message=".*attention mask is not set.*")

MODEL_DIR = "/jardin/models/audio/whisper-small"
DEFAULT_LANGUAGE = "es"


def fail(msg: str, code: int = 1) -> None:
    print(f"transcribe_whisper: {msg}", file=sys.stderr)
    sys.exit(code)


def main() -> None:
    if len(sys.argv) < 2:
        fail("usage: transcribe_whisper.py <audio_file> [language]", 2)

    audio_path = sys.argv[1]
    language = sys.argv[2].strip() if len(sys.argv) > 2 and sys.argv[2].strip() else DEFAULT_LANGUAGE

    path = Path(audio_path)
    if not path.is_file():
        fail(f"audio file not found: {audio_path}")
    if path.stat().st_size == 0:
        fail(f"audio file is empty: {audio_path}")

    try:
        import torch
        import librosa
        from transformers import WhisperProcessor, WhisperForConditionalGeneration
        import logging
        logging.getLogger("transformers").setLevel(logging.ERROR)
    except Exception as exc:  # pragma: no cover - import-time
        fail(f"missing dependency: {exc}")

    try:
        processor = WhisperProcessor.from_pretrained(MODEL_DIR)
        model = WhisperForConditionalGeneration.from_pretrained(MODEL_DIR)
    except Exception as exc:
        fail(f"could not load model from {MODEL_DIR}: {exc}")

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(device)
    model.eval()

    try:
        audio, _ = librosa.load(str(path), sr=16000)
    except Exception as exc:
        fail(f"could not read audio ({path.suffix or 'unknown'}): {exc}")
    if audio is None or len(audio) == 0:
        fail("audio contains no samples")

    try:
        inputs = processor(audio, sampling_rate=16000, return_tensors="pt")
        input_features = inputs["input_features"].to(device)

        gen_kwargs = {"language": language, "task": "transcribe"}

        with torch.no_grad():
            predicted_ids = model.generate(input_features, **gen_kwargs)
        text = processor.batch_decode(predicted_ids, skip_special_tokens=True)[0]
    except Exception as exc:
        fail(f"transcription failed: {exc}")

    text = (text or "").strip()
    if not text:
        fail("transcription produced no text")
    print(text)


if __name__ == "__main__":
    main()
