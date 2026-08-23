"""
Kokoro TTS server (PyTorch / KPipeline)
Exposes /v1/audio/speech (OpenAI-compatible) and GET /health
Models download to ~/.cache/huggingface on first run.
"""

import io
import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from kokoro import KPipeline

app = FastAPI()

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
