#!/usr/bin/env python3
"""Transcribe an audio file with the local Whisper (HuggingFace) model."""
import sys
import os

MODEL_DIR = "/jardin/models/audio/whisper-small"

def main():
    if len(sys.argv) < 2:
        print("usage: transcribe_whisper.py <audio_file> [language]", file=sys.stderr)
        sys.exit(2)
    audio_path = sys.argv[1]
    language = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2].strip() else None

    import torch
    import librosa
    from transformers import WhisperProcessor, WhisperForConditionalGeneration

    processor = WhisperProcessor.from_pretrained(MODEL_DIR)
    model = WhisperForConditionalGeneration.from_pretrained(MODEL_DIR)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(device)
    model.eval()

    audio, _ = librosa.load(audio_path, sr=16000)
    inputs = processor(audio, sampling_rate=16000, return_tensors="pt")
    input_features = inputs["input_features"].to(device)

    gen_kwargs = {}
    if language:
        gen_kwargs["language"] = language
        gen_kwargs["task"] = "transcribe"

    with torch.no_grad():
        predicted_ids = model.generate(input_features, **gen_kwargs)
    text = processor.batch_decode(predicted_ids, skip_special_tokens=True)[0]
    print(text.strip())

if __name__ == "__main__":
    main()
