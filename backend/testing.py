# The Triton desktop app starts this server automatically. For this standalone
# client, run `uv run fermion serve phonon-2 --port 8001` from the backend folder.

import asyncio
import json
import queue

import sounddevice as sd
import websockets

SERVER_URL = "ws://127.0.0.1:8001/v1/audio/stream"
SAMPLE_RATE = 16000
CHUNK_SECONDS = 0.1

audio_queue = queue.Queue(maxsize=100)


def audio_callback(indata, frames, time_info, status):
    if status:
        print(f"\nAudio warning: {status}")

    try:
        audio_queue.put_nowait(indata[:, 0].copy().tobytes())
    except queue.Full:
        pass


async def main():
    print("Connecting to Phonon-2...")

    async with websockets.connect(SERVER_URL) as ws:
        await ws.send(json.dumps({
            "sample_rate": SAMPLE_RATE,
            "format": "pcm_f32le",
        }))

        print("Connected. Speak English; press Ctrl+C to stop.\n")

        async def receive_transcripts():
            async for message in ws:
                data = json.loads(message)
                kind = data.get("type")
                text = data.get("text", "")

                if kind == "partial":
                    # A partial replaces the previous partial.
                    print(f"\rPartial: {text:<100}", end="", flush=True)

                elif kind == "final":
                    # Finalized text is stable; print it permanently.
                    print(f"\rFinal:   {text:<100}", flush=True)

                elif kind == "done":
                    print(f"\nComplete transcript: {text}")
                    return

                elif kind == "error":
                    print(f"\nServer error: {data.get('message')}")
                    return

        receiver = asyncio.create_task(receive_transcripts())

        try:
            with sd.InputStream(
                samplerate=SAMPLE_RATE,
                channels=1,
                dtype="float32",
                blocksize=int(SAMPLE_RATE * CHUNK_SECONDS),
                callback=audio_callback,
            ):
                while not receiver.done():
                    try:
                        chunk = await asyncio.to_thread(
                            audio_queue.get, True, 0.1
                        )
                    except queue.Empty:
                        continue

                    await ws.send(chunk)

        except asyncio.CancelledError:
            raise
        finally:
            if not receiver.done():
                await ws.send(json.dumps({"type": "end"}))
                try:
                    await asyncio.wait_for(receiver, timeout=5)
                except asyncio.TimeoutError:
                    receiver.cancel()
                    await asyncio.gather(receiver, return_exceptions=True)

            print("\nTranscription stopped.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopped.")
