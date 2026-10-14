from faster_whisper import WhisperModel

# Use CPU inference so transcription works without CUDA runtime libraries.
model = WhisperModel(
    "small",
    device="cpu",
    compute_type="int8",
)

def transcribe_audio(file_path: str) -> str:
    segments, info = model.transcribe(file_path)
    return " ".join(segment.text for segment in segments).strip()
