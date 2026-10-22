# Triton

Triton is an experimental desktop AI assistant in early development.

![Triton new-tab page preview](New%20tab%20page.png)

## Tech stack

- **React, TypeScript, and Vite** power the chat interface and interactive workspace.
- **Tauri 2 and Rust** package and run Triton as a desktop app.
- **Python and FastAPI** provide the backend; **LangGraph** coordinates the AI agent, web research, and memory.
- **Fermion** handles live microphone transcription, and **ElevenLabs** generates spoken responses.

## Roadmap

Triton is still at a very early stage. Planned work includes an always-on agent.
## Live transcription

On launch, Triton runs `uv run fermion serve phonon-2 --port 8001` from `backend` for live microphone input. The Triton API runs on port `8000`; `uv` must be available on `PATH`.
