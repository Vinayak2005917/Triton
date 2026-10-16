import os
from utils import debug_print
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage
from pydantic import BaseModel
import time
from langchain.tools import tool
from utils import diff_applier
from websocket import send_tool_update, send_workspace_update

load_dotenv()
api_key = os.getenv("OPENAI_API_KEY")
memory = None


def set_checkpointer(checkpointer):
    global memory
    memory = checkpointer


async def delete_request_checkpoint(thread_id, request_id):
    if memory is not None:
        try:
            await memory.adelete_thread(f"{thread_id}:{request_id}")
        except Exception as error:
            debug_print(f"Could not remove interrupted checkpoint for {thread_id}: {error}")


current_model = ChatOpenAI(
    model="openai/gpt-6-luna",
    api_key=api_key,
    base_url="https://api.aicredits.in/v1",
)

class ResponseModel(BaseModel):
    response: str



# Keep this outside ask_agent, near the top of the file
with open(os.path.join(os.path.dirname(__file__), "prompts", "main_agent.md"), "r", encoding="utf-8") as f:
    system_prompt = f.read()

from tools import search_images, search_youtube_videos, check_weather, get_wiki_page
from search import multi_search


async def ask_agent(query, workspace_code, thread_id, request_id=None, conversation_history=None):
    debug_print(f"Received query: {query} for thread_id: {thread_id}")

    workspace = {"html": workspace_code}

    @tool("edit_workspace", description="Apply one precise search-and-replace edit to the current workspace HTML. Also give a summary of the change this edit will make.")
    def edit_workspace(search: str, replace: str, changes: str) -> str:
        debug_print(f"Workspace changes='{changes}'")
        send_tool_update(f"Workspace changes='{changes}'", tool_name="edit_workspace", request_id=request_id)
        workspace["html"] = diff_applier(workspace["html"], [{"search": search, "replace": replace}])
        from storage import store
        if store.save_workspace_update(thread_id, request_id or "", workspace["html"]):
            send_workspace_update(workspace["html"], request_id=request_id)
        return f"Workspace updated. Current workspace HTML:\n{workspace['html']}"

    agent = create_agent(
        model=current_model,
        system_prompt=system_prompt,
        tools=[multi_search, search_images, search_youtube_videos, check_weather, get_wiki_page, edit_workspace],
        checkpointer=memory,
        response_format=ResponseModel,
    )

    enriched_query = f"{query}\n\nCurrent date and time: {time.strftime('%Y-%m-%d %H:%M:%S')}\nCurrent workspace HTML (use edit_workspace to modify it):\n{workspace['html']}"

    messages = []
    for item in conversation_history or []:
        content = str(item.get("text") or "").strip()
        if not content:
            continue
        if item.get("role") == "user":
            messages.append(HumanMessage(content=content))
        elif item.get("role") == "agent":
            messages.append(AIMessage(content=content))
    messages.append(HumanMessage(content=enriched_query))

    request_checkpoint_id = f"{thread_id}:{request_id or 'request'}"
    result = await agent.ainvoke(
        {"messages": messages},
        config={"configurable": {"thread_id": request_checkpoint_id}},
    )
    debug_print(f"Agent response for thread_id {thread_id} with response {result['structured_response'].response}")

    return result["structured_response"], workspace["html"]


