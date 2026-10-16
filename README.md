# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Live transcription

When Triton opens, it starts `fermion serve phonon-2 --port 8001` from the repository's `backend` directory. The live microphone stream connects to that server; the Triton API continues to use port 8000. `uv` must be available on `PATH`. Triton stops the server process when the app exits.

To run the standalone `backend/testing.py` client, start the same server manually from `backend` first.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
