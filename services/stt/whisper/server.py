"""
mlx-whisper FastAPI server — OpenAI-compatible /audio/transcriptions endpoint.
Drop-in replacement for parakeet-mlx-fastapi.

Usage:
  python server.py --model mlx-community/whisper-large-v3-turbo --port 8766
"""

from __future__ import annotations

import argparse
import tempfile
from pathlib import Path
from contextlib import asynccontextmanager

import mlx_whisper
from fastapi import FastAPI, File, Form, UploadFile, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from typing import Optional, Literal
import os

# ── CLI args ────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser()
parser.add_argument("--model", default="mlx-community/whisper-large-v3-turbo")
parser.add_argument("--port", type=int, default=8766)
args, _ = parser.parse_known_args()

MODEL_NAME = args.model
PORT = args.port

# ── App + model lifecycle ────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Warm up: run a tiny transcription so the model is compiled before first request
    print(f"[whisper] loading model: {MODEL_NAME}")
    # mlx_whisper loads lazily on first call; trigger it now with silence
    import numpy as np
    silence = np.zeros(16000, dtype=np.float32)
    mlx_whisper.transcribe(silence, path_or_hf_repo=MODEL_NAME)
    print("[whisper] model ready")
    yield

app = FastAPI(title="mlx-whisper STT", lifespan=lifespan)

# CORS — opt-in via env var, same pattern as parakeet service
_cors_env = os.getenv("WHISPER_CORS_ORIGINS", "").strip()
_cors_origins = [o.strip() for o in _cors_env.split(",") if o.strip()]
if _cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# ── Response schema (OpenAI-compatible) ─────────────────────────────────────

class TranscriptionResponse(BaseModel):
    task: Literal["transcribe"] = "transcribe"
    language: Optional[str] = None
    duration: Optional[float] = None
    text: str

# ── Routes ───────────────────────────────────────────────────────────────────

@app.get("/healthz")
def health():
    return {"status": "ok", "model": MODEL_NAME}

async def _transcribe(
    file: UploadFile,
    response_format: str = "json",
    language: Optional[str] = None,
) -> TranscriptionResponse | str:
    suffix = Path(file.filename or "").suffix or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp_path = Path(tmp.name)
        tmp.write(await file.read())

    try:
        result = mlx_whisper.transcribe(
            str(tmp_path),
            path_or_hf_repo=MODEL_NAME,
            language=language,
            # fp16 on ANE/GPU via MLX
            verbose=False,
        )
    finally:
        tmp_path.unlink(missing_ok=True)

    text = result["text"].strip()

    if response_format == "text":
        return text

    return TranscriptionResponse(
        language=result.get("language"),
        text=text,
    )


@app.post("/audio/transcriptions")
@app.post("/v1/audio/transcriptions")
async def transcribe_audio(
    file: UploadFile = File(...),
    model: str = Form("whisper"),
    language: Optional[str] = Form(None),
    response_format: Literal["json", "text", "verbose_json", "srt", "vtt"] = Form("json"),
    temperature: float = Form(0.0),
):
    result = await _transcribe(file, response_format=response_format, language=language)
    if isinstance(result, str):
        return PlainTextResponse(content=result, media_type="text/plain")
    return result


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
