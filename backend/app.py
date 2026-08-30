from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import tempfile
from main_agent import ask_agent, current_model
from transcribe import transcribe_audio
import os
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
async def ask(query: str, Thread_id: str):
    #No DEBUG needed as it is already logged in main_agent.py
    response = await ask_agent(query, Thread_id)
    return {"response": response}

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
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)