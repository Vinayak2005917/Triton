from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import tempfile
from main_agent import ask_agent, current_model
from graph import run_graph
from transcribe import transcribe_audio
import os
import uvicorn
from utils import debug_print
from fastapi.responses import FileResponse
from speak import text_to_speech

app = FastAPI()

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/ask")
async def ask(agent_request: dict):
    query = agent_request.get("query")
    thread_id = agent_request.get("thread_id", "default")
    workspace_code = agent_request.get("workspace_code", "")
    return await run_graph(query, thread_id, workspace_code=workspace_code)

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
    debug_print(f"Received text for TTS, now starting pre processing")
    text = current_model.invoke(f"Make the following text TTS ready, remove all the markdown elements {text}").content
    debug_print(f"TTS pre processing completed, Now starting TTS generation")
    audio_path = text_to_speech(text)
    debug_print(f"TTS completed, Now sending back to frontend")
    return FileResponse(audio_path,media_type="audio/wav",filename="response.wav")

if __name__ == "__main__":
    try:
        uvicorn.run(app, host="0.0.0.0", port=8000)
    except KeyboardInterrupt:
        print("Shutting down the server...")
