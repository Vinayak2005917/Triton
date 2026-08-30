from faster_whisper import WhisperModel
import asyncio
import os

model = WhisperModel(
    "small",
    device="cpu",
    compute_type="int8"
)

def transcribe_audio(file_path: str) -> str:
    segments, info = model.transcribe(file_path)
    return " ".join(segment.text for segment in segments).strip()