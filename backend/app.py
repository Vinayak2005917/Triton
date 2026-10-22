import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, UploadFile, File, WebSocket, WebSocketDisconnect, Body, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import sqlite3
import tempfile
from graph import run_graph
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
import main_agent
import os
import uvicorn
from utils import debug_print
from fastapi.responses import Response
from speak import text_to_speech
from dotenv import load_dotenv
from websocket import set_active_connection, reset_active_connection
from storage import store
from memory import close_memory_storage, initialize_memory_storage
import uuid

load_dotenv()
api_key = os.getenv("OPENAI_API_KEY")
if not api_key:
    raise RuntimeError("OPENAI_API_KEY is not set")

@asynccontextmanager
async def lifespan(app: FastAPI):
    initialize_memory_storage()
    checkpoint_path = store.path.with_name(f"{store.path.stem}_checkpoints{store.path.suffix}")
    connection = sqlite3.connect(checkpoint_path, timeout=30)
    try:
        connection.execute("PRAGMA journal_mode=WAL")
    finally:
        connection.close()
    async with AsyncSqliteSaver.from_conn_string(str(checkpoint_path)) as checkpointer:
        await checkpointer.setup()
        main_agent.set_checkpointer(checkpointer)
        for thread_id, request_id in store.recover_interrupted_requests():
            await main_agent.delete_request_checkpoint(thread_id, request_id)
        try:
            yield
        finally:
            main_agent.set_checkpointer(None)
            close_memory_storage()


app = FastAPI(lifespan=lifespan)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/conversations")
async def list_conversations():
    return store.list_conversations()


@app.get("/conversations/{thread_id}")
async def get_conversation(thread_id: str):
    conversation = store.get_conversation(thread_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return conversation


@app.put("/conversations/{thread_id}")
async def save_conversation(thread_id: str, body: dict = Body(...)):
    state = body.get("state")
    if not isinstance(state, dict):
        raise HTTPException(status_code=422, detail="Conversation state must be an object.")
    store.save_state(thread_id, state)
    return {"ok": True}


@app.websocket("/ws")
async def agent_socket(websocket: WebSocket):
    await websocket.accept()
    active_request_id = None
    active_task = None
    try:
        while True:
            request = await websocket.receive_json()
            if request.get("type") == "cancel":
                request_id = str(request.get("request_id") or "")
                if active_task and not active_task.done() and request_id == active_request_id:
                    active_task.cancel()
                    try:
                        await active_task
                    except asyncio.CancelledError:
                        pass
                    active_task = None
                    active_request_id = None
                continue

            if active_task and not active_task.done():
                request_id = str(request.get("request_id") or uuid.uuid4())
                await websocket.send_json({
                    "type": "error",
                    "request_id": request_id,
                    "message": "An agent request is already running.",
                })
                continue

            request_id = str(request.get("request_id") or uuid.uuid4())
            query = str(request.get("query") or "").strip()
            if not query:
                await websocket.send_json({"type": "error", "request_id": request_id, "message": "Prompt cannot be empty."})
                continue

            thread_id = str(request.get("thread_id") or "default")
            conversation_state = request.get("conversation_state")
            if not isinstance(conversation_state, dict):
                await websocket.send_json({"type": "error", "request_id": request_id, "message": "Conversation state is missing."})
                continue
            workspace_snapshot = str(request.get("workspace_code") or "")
            try:
                store.begin_request(
                    thread_id=thread_id,
                    request_id=request_id,
                    state=conversation_state,
                    workspace_html=workspace_snapshot,
                    user_message_id=request.get("user_message_id"),
                    agent_message_id=request.get("agent_message_id"),
                )
            except RuntimeError as error:
                await websocket.send_json({"type": "error", "request_id": request_id, "message": str(error)})
                continue

            active_request_id = request_id
            active_task = asyncio.create_task(run_agent_request(websocket, request, request_id, thread_id))
    except WebSocketDisconnect:
        debug_print("Agent WebSocket disconnected")
    finally:
        if active_task and not active_task.done():
            active_task.cancel()
            try:
                await active_task
            except asyncio.CancelledError:
                pass


async def run_agent_request(websocket: WebSocket, request: dict, request_id: str, thread_id: str):
    tokens = set_active_connection(websocket, request_id, thread_id)
    try:
        result = await run_graph(
            query=str(request.get("query") or "").strip(),
            thread_id=thread_id,
            workspace_code=str(request.get("workspace_code") or ""),
            request_id=request_id,
            websocket=websocket,
            conversation_history=request.get("conversation_history") or [],
        )
        store.finish_request(thread_id, request_id, str(result.get("workspace_code") or ""))
        await websocket.send_json({"type": "done", "request_id": request_id})
    except asyncio.CancelledError:
        workspace = store.cancel_request(thread_id, request_id)
        await main_agent.delete_request_checkpoint(thread_id, request_id)
        try:
            await websocket.send_json({"type": "stopped", "request_id": request_id, "workspace_code": workspace or str(request.get("workspace_code") or "")})
        except Exception:
            pass
        raise
    except Exception as error:
        debug_print(f"WebSocket agent request failed: {error}")
        store.finish_request(thread_id, request_id)
        await main_agent.delete_request_checkpoint(thread_id, request_id)
        try:
            await websocket.send_json({"type": "error", "request_id": request_id, "message": "The agent could not complete this request."})
        except Exception:
            pass
    finally:
        reset_active_connection(tokens)

@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    from transcribe import transcribe_audio

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
