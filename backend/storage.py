import json
import os
import sys
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ConversationStore:
    """Durable UI conversation state and workspace snapshots for Triton."""

    def __init__(self, path: str | Path | None = None):
        configured_dir = os.getenv("TRITON_DATA_DIR")
        if configured_dir:
            data_dir = Path(configured_dir)
        elif sys.platform == "win32":
            data_dir = Path(os.getenv("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "Triton"
        elif sys.platform == "darwin":
            data_dir = Path.home() / "Library" / "Application Support" / "Triton"
        else:
            data_dir = Path(os.getenv("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "triton"
        self.path = Path(path) if path else data_dir / "triton.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    @contextmanager
    def _connection(self):
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA busy_timeout=30000")
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def initialize(self) -> None:
        with self._lock, self._connection() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS conversations (
                    thread_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL DEFAULT 'New Agent',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    state_json TEXT NOT NULL,
                    workspace_html TEXT NOT NULL DEFAULT '',
                    active_request_id TEXT,
                    active_snapshot_html TEXT,
                    active_user_message_id INTEGER,
                    active_agent_message_id INTEGER
                );
                CREATE TABLE IF NOT EXISTS workspace_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    thread_id TEXT NOT NULL REFERENCES conversations(thread_id) ON DELETE CASCADE,
                    request_id TEXT,
                    phase TEXT NOT NULL,
                    html TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS workspace_snapshots_thread_idx
                    ON workspace_snapshots(thread_id, id DESC);
                CREATE INDEX IF NOT EXISTS conversations_updated_idx
                    ON conversations(updated_at DESC);
            """)

    @staticmethod
    def _clean_state(state: dict[str, Any]) -> dict[str, Any]:
        cleaned = dict(state)
        messages = []
        for message in cleaned.get("messages", []):
            item = {key: value for key, value in message.items() if key not in {"audioUrl", "audioPending"}}
            messages.append(item)
        cleaned["messages"] = messages
        return cleaned

    @staticmethod
    def _set_workspace(state: dict[str, Any], html: str) -> dict[str, Any]:
        state["code"] = html
        state["canvasState"] = html
        state["currentCanvasState"] = html
        return state

    @staticmethod
    def _mark_stopped(state: dict[str, Any], user_message_id: int | None, agent_message_id: int | None) -> dict[str, Any]:
        stopped_at = int(datetime.now(timezone.utc).timestamp() * 1000)
        for message in state.get("messages", []):
            if message.get("id") == user_message_id:
                started_at = message.get("requestStartedAt", stopped_at)
                message["requestDurationMs"] = max(0, stopped_at - started_at)
            elif message.get("id") == agent_message_id:
                message["text"] = "stopped by the user"
                message["pending"] = False
            if message.get("id") == user_message_id:
                message["toolUpdates"] = []
        state["isSending"] = False
        state["workspacePending"] = False
        state["workspaceWasEdited"] = False
        return state

    def save_state(self, thread_id: str, state: dict[str, Any]) -> None:
        state = self._clean_state(state)
        now = _utc_now()
        with self._lock, self._connection() as connection:
            existing = connection.execute(
                "SELECT created_at, workspace_html, active_request_id FROM conversations WHERE thread_id = ?",
                (thread_id,),
            ).fetchone()
            # While a request is active, its durable state is updated by the
            # request-scoped methods below. A delayed whole-tab autosave from
            # the browser must not overwrite tool output or a newer prompt.
            if existing and existing["active_request_id"]:
                return
            if existing and state.get("isSending"):
                return
            created_at = existing["created_at"] if existing else now
            incoming_workspace = str(state.get("currentCanvasState") or state.get("canvasState") or state.get("code") or "")
            workspace = existing["workspace_html"] if existing and (existing["active_request_id"] or existing["workspace_html"]) else incoming_workspace
            self._set_workspace(state, workspace)
            connection.execute("""
                INSERT INTO conversations(thread_id, name, created_at, updated_at, state_json, workspace_html)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(thread_id) DO UPDATE SET
                    name = excluded.name,
                    updated_at = excluded.updated_at,
                    state_json = excluded.state_json,
                    workspace_html = CASE
                        WHEN conversations.active_request_id IS NULL AND conversations.workspace_html = '' THEN excluded.workspace_html
                        ELSE conversations.workspace_html
                    END
            """, (
                thread_id,
                str(state.get("name") or "New Agent"),
                created_at,
                now,
                json.dumps(state, ensure_ascii=False),
                workspace,
            ))
            if workspace and (not existing or not existing["workspace_html"]):
                connection.execute(
                    "INSERT INTO workspace_snapshots(thread_id, request_id, phase, html, created_at) VALUES (?, NULL, 'initial', ?, ?)",
                    (thread_id, workspace, now),
                )

    def begin_request(
        self,
        thread_id: str,
        request_id: str,
        state: dict[str, Any],
        workspace_html: str,
        user_message_id: int | None,
        agent_message_id: int | None,
    ) -> None:
        state = self._clean_state(state)
        now = _utc_now()
        with self._lock, self._connection() as connection:
            existing = connection.execute(
                "SELECT created_at, active_request_id FROM conversations WHERE thread_id = ?",
                (thread_id,),
            ).fetchone()
            if existing and existing["active_request_id"]:
                raise RuntimeError("This conversation already has an active request.")
            created_at = existing["created_at"] if existing else now
            self._set_workspace(state, workspace_html)
            connection.execute("""
                INSERT INTO conversations(
                    thread_id, name, created_at, updated_at, state_json, workspace_html,
                    active_request_id, active_snapshot_html, active_user_message_id, active_agent_message_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(thread_id) DO UPDATE SET
                    name = excluded.name,
                    updated_at = excluded.updated_at,
                    state_json = excluded.state_json,
                    workspace_html = excluded.workspace_html,
                    active_request_id = excluded.active_request_id,
                    active_snapshot_html = excluded.active_snapshot_html,
                    active_user_message_id = excluded.active_user_message_id,
                    active_agent_message_id = excluded.active_agent_message_id
            """, (
                thread_id,
                str(state.get("name") or "New Agent"),
                created_at,
                now,
                json.dumps(state, ensure_ascii=False),
                workspace_html,
                request_id,
                workspace_html,
                user_message_id,
                agent_message_id,
            ))
            connection.execute(
                "INSERT INTO workspace_snapshots(thread_id, request_id, phase, html, created_at) VALUES (?, ?, 'prompt', ?, ?)",
                (thread_id, request_id, workspace_html, now),
            )

    def save_workspace_update(self, thread_id: str, request_id: str, html: str) -> bool:
        now = _utc_now()
        with self._lock, self._connection() as connection:
            row = connection.execute(
                "SELECT state_json FROM conversations WHERE thread_id = ? AND active_request_id = ?",
                (thread_id, request_id),
            ).fetchone()
            if not row:
                return False
            state = self._set_workspace(json.loads(row["state_json"]), html)
            state["workspaceWasEdited"] = True
            connection.execute(
                "UPDATE conversations SET workspace_html = ?, state_json = ?, updated_at = ? WHERE thread_id = ? AND active_request_id = ?",
                (html, json.dumps(state, ensure_ascii=False), now, thread_id, request_id),
            )
            connection.execute(
                "INSERT INTO workspace_snapshots(thread_id, request_id, phase, html, created_at) VALUES (?, ?, 'update', ?, ?)",
                (thread_id, request_id, html, now),
            )
        return True

    def save_tool_update(self, thread_id: str, request_id: str, update: str) -> None:
        with self._lock, self._connection() as connection:
            row = connection.execute("""
                SELECT state_json, active_user_message_id FROM conversations
                WHERE thread_id = ? AND active_request_id = ?
            """, (thread_id, request_id)).fetchone()
            if not row:
                return
            state = json.loads(row["state_json"])
            for message in state.get("messages", []):
                if message.get("id") == row["active_user_message_id"]:
                    message.setdefault("toolUpdates", []).append(update)
                    break
            connection.execute(
                "UPDATE conversations SET state_json = ?, updated_at = ? WHERE thread_id = ? AND active_request_id = ?",
                (json.dumps(state, ensure_ascii=False), _utc_now(), thread_id, request_id),
            )

    def save_tab_name(self, thread_id: str, request_id: str, name: str) -> None:
        with self._lock, self._connection() as connection:
            row = connection.execute(
                "SELECT state_json FROM conversations WHERE thread_id = ? AND active_request_id = ?",
                (thread_id, request_id),
            ).fetchone()
            if not row:
                return
            state = json.loads(row["state_json"])
            state["name"] = name
            connection.execute(
                "UPDATE conversations SET name = ?, state_json = ?, updated_at = ? WHERE thread_id = ? AND active_request_id = ?",
                (name, json.dumps(state, ensure_ascii=False), _utc_now(), thread_id, request_id),
            )

    def save_response(self, thread_id: str, request_id: str, response: str, workspace_html: str) -> None:
        now = _utc_now()
        stopped_at = int(datetime.now(timezone.utc).timestamp() * 1000)
        with self._lock, self._connection() as connection:
            row = connection.execute("""
                SELECT state_json, active_user_message_id, active_agent_message_id, active_snapshot_html
                FROM conversations WHERE thread_id = ? AND active_request_id = ?
            """, (thread_id, request_id)).fetchone()
            if not row:
                return
            state = json.loads(row["state_json"])
            for message in state.get("messages", []):
                if message.get("id") == row["active_user_message_id"]:
                    started_at = message.get("requestStartedAt", stopped_at)
                    message["requestDurationMs"] = max(0, stopped_at - started_at)
                elif message.get("id") == row["active_agent_message_id"]:
                    message["text"] = response
                    message["canvasState"] = workspace_html
                    message["pending"] = False
            self._set_workspace(state, workspace_html)
            state["workspacePending"] = False
            state["workspaceWasEdited"] = workspace_html != (row["active_snapshot_html"] or "")
            connection.execute(
                "UPDATE conversations SET state_json = ?, workspace_html = ?, updated_at = ? WHERE thread_id = ? AND active_request_id = ?",
                (json.dumps(state, ensure_ascii=False), workspace_html, now, thread_id, request_id),
            )

    def save_suggested_prompts(self, thread_id: str, request_id: str, prompts: list[str]) -> None:
        with self._lock, self._connection() as connection:
            row = connection.execute(
                "SELECT state_json FROM conversations WHERE thread_id = ? AND active_request_id = ?",
                (thread_id, request_id),
            ).fetchone()
            if not row:
                return
            state = json.loads(row["state_json"])
            state["suggestedPrompts"] = prompts
            connection.execute(
                "UPDATE conversations SET state_json = ?, updated_at = ? WHERE thread_id = ? AND active_request_id = ?",
                (json.dumps(state, ensure_ascii=False), _utc_now(), thread_id, request_id),
            )

    def finish_request(self, thread_id: str, request_id: str, workspace_html: str | None = None) -> None:
        now = _utc_now()
        finished_at = int(datetime.now(timezone.utc).timestamp() * 1000)
        with self._lock, self._connection() as connection:
            row = connection.execute(
                "SELECT workspace_html, state_json, active_user_message_id, active_agent_message_id FROM conversations WHERE thread_id = ? AND active_request_id = ?",
                (thread_id, request_id),
            ).fetchone()
            if not row:
                return
            html = row["workspace_html"] if workspace_html is None else workspace_html
            state = json.loads(row["state_json"])
            for message in state.get("messages", []):
                if message.get("id") == row["active_user_message_id"]:
                    started_at = message.get("requestStartedAt", finished_at)
                    message["requestDurationMs"] = max(0, finished_at - started_at)
                elif message.get("id") == row["active_agent_message_id"] and message.get("pending"):
                    message["text"] = "The agent could not complete this request."
                    message["pending"] = False
            state["isSending"] = False
            state["workspacePending"] = False
            self._set_workspace(state, html)
            connection.execute("""
                UPDATE conversations
                SET workspace_html = ?, state_json = ?, active_request_id = NULL, active_snapshot_html = NULL,
                    active_user_message_id = NULL, active_agent_message_id = NULL, updated_at = ?
                WHERE thread_id = ? AND active_request_id = ?
            """, (html, json.dumps(state, ensure_ascii=False), now, thread_id, request_id))
            connection.execute(
                "INSERT INTO workspace_snapshots(thread_id, request_id, phase, html, created_at) VALUES (?, ?, 'complete', ?, ?)",
                (thread_id, request_id, html, now),
            )

    def cancel_request(self, thread_id: str, request_id: str) -> str | None:
        now = _utc_now()
        with self._lock, self._connection() as connection:
            row = connection.execute("""
                SELECT state_json, active_snapshot_html, active_user_message_id, active_agent_message_id
                FROM conversations WHERE thread_id = ? AND active_request_id = ?
            """, (thread_id, request_id)).fetchone()
            if not row:
                return None
            workspace = row["active_snapshot_html"] or ""
            state = json.loads(row["state_json"])
            self._set_workspace(state, workspace)
            self._mark_stopped(state, row["active_user_message_id"], row["active_agent_message_id"])
            connection.execute("""
                UPDATE conversations
                SET workspace_html = ?, state_json = ?, active_request_id = NULL,
                    active_snapshot_html = NULL, active_user_message_id = NULL,
                    active_agent_message_id = NULL, updated_at = ?
                WHERE thread_id = ? AND active_request_id = ?
            """, (workspace, json.dumps(state, ensure_ascii=False), now, thread_id, request_id))
            connection.execute(
                "INSERT INTO workspace_snapshots(thread_id, request_id, phase, html, created_at) VALUES (?, ?, 'rollback', ?, ?)",
                (thread_id, request_id, workspace, now),
            )
        return workspace

    def recover_interrupted_requests(self) -> list[tuple[str, str]]:
        with self._lock, self._connection() as connection:
            rows = connection.execute("""
                SELECT thread_id, active_request_id, active_snapshot_html,
                       active_user_message_id, active_agent_message_id
                FROM conversations WHERE active_request_id IS NOT NULL
            """).fetchall()
        for row in rows:
            self.cancel_request(row["thread_id"], row["active_request_id"])
        return [(row["thread_id"], row["active_request_id"]) for row in rows]

    def get_conversation(self, thread_id: str) -> dict[str, Any] | None:
        with self._lock, self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM conversations WHERE thread_id = ?",
                (thread_id,),
            ).fetchone()
        if not row:
            return None
        state = json.loads(row["state_json"])
        state["currentCanvasState"] = row["workspace_html"]
        state["canvasState"] = state.get("canvasState") or row["workspace_html"]
        state["code"] = state.get("code") or row["workspace_html"]
        return {
            "thread_id": row["thread_id"],
            "name": row["name"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "workspace_html": row["workspace_html"],
            "state": state,
        }

    def list_conversations(self) -> list[dict[str, Any]]:
        with self._lock, self._connection() as connection:
            rows = connection.execute("""
                SELECT thread_id, name, created_at, updated_at, state_json
                FROM conversations ORDER BY updated_at DESC
            """).fetchall()
        results = []
        for row in rows:
            state = json.loads(row["state_json"])
            messages = state.get("messages", [])
            visible_messages = [message for message in messages if message.get("text")]
            results.append({
                "thread_id": row["thread_id"],
                "name": row["name"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "preview": visible_messages[-1]["text"][:120] if visible_messages else "No messages yet",
                "message_count": len(messages),
            })
        return results


store = ConversationStore()
