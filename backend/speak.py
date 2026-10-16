from elevenlabs.client import ElevenLabs
from dotenv import load_dotenv
from tools import debug_print
import os
from pathlib import Path
import hashlib

load_dotenv()
key1 = os.getenv("ELEVENLABS_API_KEY")
key2 = os.getenv("ELEVENLABS_API_KEY2")


def _is_insufficient_balance_error(error):
    body = getattr(error, "body", None)
    if not isinstance(body, dict):
        return False

    detail = body.get("detail", body)
    if not isinstance(detail, dict):
        return False

    code = str(detail.get("code", "")).lower()
    message = str(detail.get("message", "")).lower()
    if code in {"insufficient_balance", "insufficient_credits"}:
        return True

    return (
        code == "quota_exceeded"
        and "credit" in message
        and ("required" in message or "insufficient" in message or "not enough" in message)
    )

def text_to_speech(text):
    try:
        api_keys = [api_key for api_key in (key1, key2) if api_key]
        if not api_keys:
            raise RuntimeError("No ElevenLabs API key is configured.")

        for index, api_key in enumerate(api_keys):
            try:
                debug_print("Sending the text-to-speech request")
                audio = ElevenLabs(api_key=api_key).text_to_speech.convert(
                    text=text,
                    voice_id="nPczCjzI2devNBz1zQrb",
                    model_id="eleven_flash_v2_5",
                    output_format="mp3_44100_128",
                )
                audio_bytes = b"".join(audio)
                break
            except Exception as error:
                if index + 1 < len(api_keys) and _is_insufficient_balance_error(error):
                    debug_print("Insufficient ElevenLabs balance; retrying with the second API key")
                    continue
                raise

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
