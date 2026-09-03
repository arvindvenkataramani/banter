"""
Kokoro TTS server (PyTorch / KPipeline)
Exposes /v1/audio/speech (OpenAI-compatible), GET /health, and POST/DELETE
/v1/models for the load/unload the dashboard drives.
Models download to ~/.cache/huggingface on first run.
CORS is permissive and needs no configuration.
"""

import io
import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel
from kokoro import KPipeline

app = FastAPI()

# CORS — permissive, like mlx-audio and neutts-air. The dashboard calls this
# server directly from the browser, and the origin it calls from is whatever the
# registry's host and port resolve to. Making that a second thing to configure
# only creates a way to get it wrong: the symptom is a synthesis failure that
# looks like the service being down, on a service whose health check passes.
# This binds to localhost by default, so the reachable surface is the tailnet.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Lazy-loaded pipeline — initialised on first request
_pipeline: KPipeline | None = None

def get_pipeline() -> KPipeline:
    global _pipeline
    if _pipeline is None:
        _pipeline = KPipeline(lang_code="a")  # 'a' = American English
    return _pipeline


class SpeechRequest(BaseModel):
    input: str
    voice: str = "af_heart"
    speed: float = 1.0


@app.get("/health")
def health():
    return {"status": "ok"}


# Model lifecycle — the dashboard calls POST before its first utterance and waits
# on it, so "ready" means the pipeline is actually warm rather than merely
# reachable. DELETE backs the registry's idleUnload: drop the pipeline so an idle
# service releases its memory instead of holding it until the process exits.

@app.post("/v1/models")
def load_model(model_name: str | None = None):
    get_pipeline()
    return {"status": "ok"}


@app.delete("/v1/models")
def unload_model(model_name: str | None = None):
    global _pipeline
    _pipeline = None
    return {"status": "ok"}


@app.post("/v1/audio/speech")
def speech(req: SpeechRequest):
    if not req.input:
        raise HTTPException(status_code=400, detail="input is required")

    pipeline = get_pipeline()

    chunks = []
    for _, _, audio in pipeline(req.input, voice=req.voice, speed=req.speed):
        chunks.append(audio)

    if not chunks:
        raise HTTPException(status_code=500, detail="no audio generated")

    combined = np.concatenate(chunks)

    buf = io.BytesIO()
    sf.write(buf, combined, 24000, format="WAV")
    buf.seek(0)

    return Response(content=buf.read(), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8002)
