from elevenlabs.client import ElevenLabs
from elevenlabs.play import play
from dotenv import load_dotenv
from tools import debug_print
import os

load_dotenv()

api_key = os.getenv("ELEVENLABS_API_KEY")
client = ElevenLabs(api_key=api_key)

def text_to_speech(text):
    debug_print(f"sending the request")
    audio = client.text_to_speech.convert(
        text=text,
        voice_id="JBFqnCBsd6RMkjVDRZzb",
        model_id="eleven_flash_v2_5",
        output_format="mp3_44100_128",
    )
    debug_print(f"received the response")
    play(audio)

if __name__ == "__main__":
    text_to_speech("Hello, this is a test of the ElevenLabs text-to-speech functionality.")