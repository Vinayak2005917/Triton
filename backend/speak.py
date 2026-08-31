import subprocess
import tempfile
import sys


VOICE = "en_US-lessac-medium"


def text_to_speech(text: str) -> str:
    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as temp:
        output_path = temp.name

    subprocess.run(
        [sys.executable, "-m", "piper", "-m", VOICE, "-f", output_path, "--", text],
        check=True,
    )

    return output_path

if __name__ == "__main__":
    text = "Hello, this is a test of the text-to-speech functionality."
    audio_path = text_to_speech(text)
    print(f"Audio file generated at: {audio_path}")
