"""
NeuTTS-Air TTS server.
Exposes /v1/audio/speech (OpenAI-compatible) and GET /health.
Voices are pre-configured in voices.yaml alongside this file.

Streaming: send stream=true + response_format=mp3 to get MP3 bytes streamed
as they are generated. Compatible with the dashboard TtsPlayer (MSE/MMS).
"""

import asyncio
import io
import logging
import os
import warnings
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Generator

import lameenc
import numpy as np
import soundfile as sf
import yaml
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

# Suppress noisy startup warnings
logging.getLogger("transformers").setLevel(logging.ERROR)
warnings.filterwarnings("ignore", message=".*clean_up_tokenization_spaces.*")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

HERE = Path(__file__).parent
SAMPLE_RATE = 24000

_tts = None
_voices: dict = {}
_default_voice: str = ""


def _load_voices_config():
    with open(HERE / "voices.yaml") as f:
        return yaml.safe_load(f)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _tts, _voices, _default_voice

    from neutts import NeuTTS

    cfg = _load_voices_config()
    _default_voice = cfg["default_voice"]
    ref_dir = Path(cfg["ref_dir"])

    print("Loading NeuTTS-Air model...")
    _tts = NeuTTS(
        backbone_repo="neuphonic/neutts-air-q4-gguf",
        backbone_device="cpu",
        codec_repo="neuphonic/neucodec",
        codec_device="cpu",
        max_context=2048,
    )

    print("Pre-encoding voice references...")
    for name, voice in cfg["voices"].items():
        ref_audio_path = ref_dir / voice["ref_audio"]
        ref_text_path = ref_dir / voice["ref_text"]
        ref_text = ref_text_path.read_text().strip()
        ref_codes = _tts.encode_reference(str(ref_audio_path))
        _voices[name] = {"ref_codes": ref_codes, "ref_text": ref_text}
        print(f"  encoded: {name}")

    print("Warming up...")
    warmup_voice = _voices[_default_voice]
    _tts.infer("Warmup.", warmup_voice["ref_codes"], warmup_voice["ref_text"])
    print("NeuTTS-Air ready.")

    yield

    del _tts


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


_inference_lock = asyncio.Lock()


class SpeechRequest(BaseModel):
    input: str
    voice: str = ""
    response_format: str = "wav"
    stream: bool = False
    speed: float = 1.0


def _make_mp3_encoder() -> lameenc.Encoder:
    enc = lameenc.Encoder()
    enc.set_bit_rate(128)
    enc.set_in_sample_rate(SAMPLE_RATE)
    enc.set_channels(1)
    enc.set_quality(2)  # 2 = high quality
    return enc


def _pcm_to_int16(audio: np.ndarray) -> bytes:
    return (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16).tobytes()


async def _locked_stream_mp3(chunks: Generator[np.ndarray, None, None]):
    async with _inference_lock:
        enc = _make_mp3_encoder()
        for chunk in chunks:
            mp3_bytes = enc.encode(_pcm_to_int16(chunk))
            if mp3_bytes:
                yield bytes(mp3_bytes)
        final = enc.flush()
        if final:
            yield bytes(final)


def _audio_to_mp3(audio: np.ndarray) -> bytes:
    enc = _make_mp3_encoder()
    mp3 = bytes(enc.encode(_pcm_to_int16(audio)))
    mp3 += bytes(enc.flush())
    return mp3


@app.post("/v1/models")
def load_model():
    # Model is always loaded at startup — nothing to do
    return {"status": "ok"}


@app.delete("/v1/models")
def unload_model():
    # Model stays loaded — nothing to do
    return {"status": "ok"}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/v1/audio/speech")
async def speech(req: SpeechRequest):
    if not req.input:
        raise HTTPException(status_code=400, detail="input is required")

    voice_name = req.voice or _default_voice
    if voice_name not in _voices:
        raise HTTPException(
            status_code=400,
            detail=f"unknown voice '{voice_name}'. Available: {list(_voices)}",
        )

    voice = _voices[voice_name]
    want_mp3 = req.response_format == "mp3"

    if req.stream:
        chunks = _tts.infer_stream(req.input, voice["ref_codes"], voice["ref_text"])
        return StreamingResponse(_locked_stream_mp3(chunks), media_type="audio/mpeg")

    # Non-streaming — hold lock for the duration of inference
    async with _inference_lock:
        try:
            audio = _tts.infer(req.input, voice["ref_codes"], voice["ref_text"])
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"inference failed: {e}")

    if want_mp3:
        return Response(content=_audio_to_mp3(audio), media_type="audio/mpeg")

    buf = io.BytesIO()
    sf.write(buf, audio, SAMPLE_RATE, format="WAV")
    buf.seek(0)
    return Response(content=buf.read(), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8004)
