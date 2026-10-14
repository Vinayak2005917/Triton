from elevenlabs.client import ElevenLabs
from dotenv import load_dotenv
from tools import debug_print
import os
from pathlib import Path
import hashlib

load_dotenv()

api_key = os.getenv("ELEVENLABS_API_KEY")
client = ElevenLabs(api_key=api_key)

def text_to_speech(text):
    try:
        debug_print("Sending the text-to-speech request")
        audio = client.text_to_speech.convert(
            text=text,
            voice_id="JBFqnCBsd6RMkjVDRZzb",
            model_id="eleven_flash_v2_5",
            output_format="mp3_44100_128",
        )
        audio_bytes = b"".join(audio)
        if not audio_bytes:
            raise RuntimeError("The text-to-speech service returned empty audio.")

        audio_dir = Path(__file__).parent / "audio"
        audio_dir.mkdir(parents=True, exist_ok=True)
        audio_path = audio_dir / f"{hashlib.sha256(text.encode('utf-8')).hexdigest()}.mp3"
        audio_path.write_bytes(audio_bytes)
        debug_print("Text-to-speech audio received and saved")
        return audio_bytes, audio_path.name
    except Exception as error:
        debug_print(f"Text-to-speech generation failed: {error}")
        raise RuntimeError("Text-to-speech generation failed.") from error

if __name__ == "__main__":
    text_to_speech("Hello, this is a test of the ElevenLabs text-to-speech functionality.")
