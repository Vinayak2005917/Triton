import asyncio
import contextvars
from fastapi import WebSocket


_active_connection: contextvars.ContextVar[WebSocket | None] = contextvars.ContextVar("active_connection", default=None)
_active_request_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("active_request_id", default=None)
_active_thread_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("active_thread_id", default=None)
_active_loop: contextvars.ContextVar[asyncio.AbstractEventLoop | None] = contextvars.ContextVar("active_loop", default=None)


def set_active_connection(websocket: WebSocket, request_id: str, thread_id: str | None = None):
    return (
        _active_connection.set(websocket),
        _active_request_id.set(request_id),
        _active_thread_id.set(thread_id),
        _active_loop.set(asyncio.get_running_loop()),
    )


def reset_active_connection(tokens):
    connection_token, request_token, thread_token, loop_token = tokens
    _active_connection.reset(connection_token)
    _active_request_id.reset(request_token)
    _active_thread_id.reset(thread_token)
    _active_loop.reset(loop_token)


async def send_event(websocket: WebSocket, message: dict):
    await websocket.send_json(message)


def _schedule_active_event(event: dict, wait: bool = False):
    websocket = _active_connection.get()
    if websocket is None:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # LangChain runs synchronous tools in worker threads; this helper is
        # called there too, so schedule the send on the socket's event loop.
        loop = _active_loop.get()
        if loop is None:
            return
        future = asyncio.run_coroutine_threadsafe(send_event(websocket, event), loop)
        if wait:
            future.result(timeout=15)
    else:
        task = loop.create_task(send_event(websocket, event))
        if wait:
            # Synchronous agent tools run in worker threads. Avoid blocking
            # the event-loop thread if a tool is ever invoked directly there.
            task.add_done_callback(lambda completed: completed.exception())


def send_tool_update(contents: str, tool_name: str = "tool", request_id: str | None = None):
    active_request_id = request_id or _active_request_id.get()
    thread_id = _active_thread_id.get()
    if thread_id and active_request_id:
        from storage import store
        store.save_tool_update(thread_id, active_request_id, f"{tool_name}: {contents}")
    _schedule_active_event({
        "type": "tool_update",
        "request_id": active_request_id,
        "tool": tool_name,
        "content": contents,
    }, wait=True)


def send_workspace_update(html: str, request_id: str | None = None):
    _schedule_active_event({
        "type": "workspace_update",
        "request_id": request_id or _active_request_id.get(),
        "workspace_code": html,
    }, wait=True)
