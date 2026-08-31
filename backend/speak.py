import os
import tempfile
from openai import OpenAI

client = OpenAI(
    base_url="https://api.aicredits.in/v1",
    api_key=os.getenv("AICREDITS_API_KEY"),
)

MODEL = "openai/tts-1"
VOICE = "nova"


def text_to_speech(text: str) -> str:
    with tempfile.NamedTemporaryFile(delete=False, suffix=".mp3") as temp:
        output_path = temp.name
    response = client.audio.speech.create(model=MODEL,voice=VOICE,input=text,response_format="mp3",)
    response.write_to_file(output_path)
    return output_path


if __name__ == "__main__":
    audio_file_path = text_to_speech("Hello, this is a test of Triton's text to speech system.")
    print(f"Audio file generated at: {audio_file_path}")