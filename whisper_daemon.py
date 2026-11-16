#!/usr/bin/env python3
"""Persistent Whisper transcription daemon.

Loads the HuggingFace Whisper model once and serves transcriptions over a
local HTTP endpoint. Reduces per-note latency from 2-4s to <500ms.

Usage:
  python3 whisper_daemon.py [--port 8877] [--model /path/to/model]

Endpoint: POST /transcribe with JSON {"path": "/path/to/audio.ogg", "language": "auto"}
Response: 200 text/plain with the transcript, or 400/500 with error text.
"""
import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_DIR = "/jardin/models/audio/whisper-small"


def load_model():
    import torch
    from transformers import WhisperProcessor, WhisperForConditionalGeneration
    import logging
    logging.getLogger("transformers").setLevel(logging.ERROR)
    processor = WhisperProcessor.from_pretrained(MODEL_DIR)
    model = WhisperForConditionalGeneration.from_pretrained(MODEL_DIR)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(device)
    model.eval()
    return processor, model, torch, device


class Handler(BaseHTTPRequestHandler):
    processor = None
    model = None
    torch = None
    device = None

    def do_POST(self):
        if self.path == "/transcribe/stream":
            self._handle_stream()
            return
        if self.path != "/transcribe":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf8"))
            path = body.get("path", "")
            language = body.get("language", "auto")
            if not path:
                self.send_error(400, "missing path")
                return
            import librosa
            audio, _ = librosa.load(path, sr=16000)
            inputs = self.processor(audio, sampling_rate=16000, return_tensors="pt")
            features = inputs["input_features"].to(self.device)
            gen_kwargs = {"task": "transcribe"}
            if language and language.lower() not in ("auto", "detect"):
                gen_kwargs["language"] = language
            with self.torch.no_grad():
                ids = self.model.generate(features, **gen_kwargs)
            text = self.processor.batch_decode(ids, skip_special_tokens=True)[0].strip()
            data = text.encode("utf8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as exc:
            msg = str(exc).encode("utf8")[:1000]
            self.send_response(500)
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    def _handle_stream(self):
        """SSE endpoint: transcribe audio in chunks, emitting partial text."""
        import json, subprocess, os, tempfile
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf8"))
            path = body.get("path", "")
            language = body.get("language", "auto")
            if not path:
                self.send_error(400, "missing path")
                return
            import librosa
            audio, sr = librosa.load(path, sr=16000)
            duration = len(audio) / sr
            # Split into ~10s chunks with 1s overlap for continuity.
            chunk_len = int(10 * sr)
            overlap = int(1 * sr)
            step = chunk_len - overlap
            accumulated = ""
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            offset = 0
            while offset < len(audio):
                chunk = audio[offset:offset + chunk_len]
                if len(chunk) < sr // 2:
                    break
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                    import soundfile as sf
                    sf.write(f.name, chunk, sr)
                    tmp = f.name
                try:
                    inputs = self.processor(chunk, sampling_rate=sr, return_tensors="pt")
                    features = inputs["input_features"].to(self.device)
                    gen = {"task": "transcribe"}
                    if language and language.lower() not in ("auto", "detect"):
                        gen["language"] = language
                    with self.torch.no_grad():
                        ids = self.model.generate(features, **gen)
                    text = self.processor.batch_decode(ids, skip_special_tokens=True)[0].strip()
                    if text:
                        accumulated = (accumulated + " " + text).strip()
                        msg = accumulated.replace("\n", "\\n")
                        self.wfile.write(f"data: {msg}\n\n".encode("utf8"))
                        self.wfile.flush()
                except Exception as ex:
                    self.wfile.write(f"event: error\ndata: {str(ex)[:200]}\n\n".encode("utf8"))
                    self.wfile.flush()
                finally:
                    os.unlink(tmp)
                offset += step
            self.wfile.write(b"event: done\ndata: {}\n\n")
            self.wfile.flush()
        except Exception as exc:
            try:
                self.wfile.write(f"event: error\ndata: {str(exc)[:200]}\n\n".encode("utf8"))
                self.wfile.flush()
            except Exception:
                pass

    def log_message(self, fmt, *args):
        pass  # Quiet by default.


def main():
    global MODEL_DIR
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8877)
    ap.add_argument("--model", default=MODEL_DIR)
    args = ap.parse_args()
    MODEL_DIR = args.model
    print(f"[whisper-daemon] loading model from {MODEL_DIR}...", file=sys.stderr, flush=True)
    Handler.processor, Handler.model, Handler.torch, Handler.device = load_model()
    print(f"[whisper-daemon] ready on port {args.port} (device={Handler.device})", file=sys.stderr, flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
