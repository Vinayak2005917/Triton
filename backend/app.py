from fastapi import FastAPI, UploadFile, File, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import tempfile
from graph import run_graph
from transcribe import transcribe_audio
import os
import uvicorn
from utils import debug_print
from fastapi.responses import Response
from speak import text_to_speech
from dotenv import load_dotenv
from websocket import set_active_connection, reset_active_connection
import uuid

load_dotenv()
api_key = os.getenv("OPENAI_API_KEY")
if not api_key:
    raise RuntimeError("OPENAI_API_KEY is not set")

app = FastAPI()

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.websocket("/ws")
async def agent_socket(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            request = await websocket.receive_json()
            request_id = str(request.get("request_id") or uuid.uuid4())
            query = str(request.get("query") or "").strip()
            if not query:
                await websocket.send_json({"type": "error", "request_id": request_id, "message": "Prompt cannot be empty."})
                continue

            tokens = set_active_connection(websocket, request_id)
            try:
                await run_graph(
                    query=query,
                    thread_id=str(request.get("thread_id") or "default"),
                    workspace_code=str(request.get("workspace_code") or ""),
                    request_id=request_id,
                    websocket=websocket,
                )
                await websocket.send_json({"type": "done", "request_id": request_id})
            except Exception as error:
                debug_print(f"WebSocket agent request failed: {error}")
                await websocket.send_json({"type": "error", "request_id": request_id, "message": "The agent could not complete this request."})
            finally:
                reset_active_connection(tokens)
    except WebSocketDisconnect:
        debug_print("Agent WebSocket disconnected")

@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    debug_print(f"Received file for transcription: {file.filename}")
    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as temp:
        temp.write(await file.read())
        temp_path = temp.name
    
    debug_print(f"Temporary file created at: {temp_path} for transcription")
    text = transcribe_audio(temp_path)
    debug_print(f"Transcription completed :{text[:20]}")

    os.remove(temp_path)
    return {"text": text}

@app.post("/tts")
async def tts(text: str):
    debug_print(f"Received text for TTS: {text[:10]}...")
    audio_bytes, filename = text_to_speech(text)
    return Response(
        content=audio_bytes,
        media_type="audio/mpeg",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )

if __name__ == "__main__":
    try:
        uvicorn.run(app, host="0.0.0.0", port=8000)
    except KeyboardInterrupt:
        print("Shutting down the server...")
