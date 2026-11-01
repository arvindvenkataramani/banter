"""
faster-whisper FastAPI server — OpenAI-compatible /audio/transcriptions endpoint.
The cross-platform counterpart of ../whisper/server.py (which is MLX, Apple
Silicon only): the same routes and responses, with faster-whisper (CTranslate2)
doing the transcription on CPU or an NVIDIA GPU.

Usage:
  uvicorn server:app --host 127.0.0.1 --port 8766
  python server.py --model turbo --device cpu --compute-type int8 --port 8766

Settings come from the command line when run as a script, and from the
environment otherwise (uvicorn server:app, which is how the registry starts it):
  FASTER_WHISPER_MODEL         model name, or a path to a converted model (default: turbo)
  FASTER_WHISPER_DEVICE        cpu, cuda or auto (default: auto)
  FASTER_WHISPER_COMPUTE_TYPE  e.g. int8, float16, int8_float16 (default: int8 on cpu, auto otherwise)
  FASTER_WHISPER_CORS_ORIGINS  comma-separated origins allowed to call this server;
                               unset means no CORS headers at all
"""

from __future__ import annotations

import argparse
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from faster_whisper import WhisperModel
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

# ── Settings ────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser()
parser.add_argument("--model", default=os.getenv("FASTER_WHISPER_MODEL", "turbo"))
parser.add_argument("--device", default=os.getenv("FASTER_WHISPER_DEVICE", "auto"),
                    choices=["auto", "cpu", "cuda"])
parser.add_argument("--compute-type", default=os.getenv("FASTER_WHISPER_COMPUTE_TYPE", ""))
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--port", type=int, default=8766)
args, _ = parser.parse_known_args()

MODEL_NAME = args.model
DEVICE = args.device
# int8 is the CPU setting faster-whisper's own docs use; elsewhere let
# CTranslate2 choose what the device supports.
COMPUTE_TYPE = args.compute_type or ("int8" if DEVICE == "cpu" else "auto")
HOST = args.host
PORT = args.port

# ── App + model lifecycle ───────────────────────────────────────────────────

_model: WhisperModel | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _model
    # Loaded before the server accepts requests, so the health check passing
    # means the model is ready. The first run downloads the weights, which can
    # take longer than the registry's startupTime on a slow connection.
    print(f"[faster-whisper] loading model: {MODEL_NAME} (device={DEVICE}, compute_type={COMPUTE_TYPE})")
    _model = await run_in_threadpool(WhisperModel, MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)
    print("[faster-whisper] model ready")
    yield
    _model = None


app = FastAPI(title="faster-whisper STT", lifespan=lifespan)

# CORS — opt-in via env var, same pattern as the mlx-whisper service. Unset
# adds no CORS headers, so a browser on another origin is refused.
_cors_env = os.getenv("FASTER_WHISPER_CORS_ORIGINS", "").strip()
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


# ── Routes ──────────────────────────────────────────────────────────────────


@app.get("/healthz")
def health():
    return {"status": "ok", "model": MODEL_NAME}


def _run(path: str, language: Optional[str]):
    # transcribe() returns a lazy generator; the work happens as it is consumed,
    # so consume it here, in the worker thread.
    segments, info = _model.transcribe(path, language=language or None)
    text = "".join(seg.text for seg in segments).strip()
    return text, info


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
        text, info = await run_in_threadpool(_run, str(tmp_path), language)
    finally:
        tmp_path.unlink(missing_ok=True)

    if response_format == "text":
        return text

    return TranscriptionResponse(
        language=getattr(info, "language", None),
        duration=getattr(info, "duration", None),
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
    uvicorn.run(app, host=HOST, port=PORT)
