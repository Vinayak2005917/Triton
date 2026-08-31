from typing import Annotated
from typing_extensions import TypedDict
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages

from main_agent import ask_agent
from utils import diff_applier, debug_print


class TritonState(TypedDict):
    thread_id: str
    messages: Annotated[list, add_messages]
    workspace_code: str
    suggested_next_prompts: list[str]


async def main_agent(state: TritonState) -> TritonState:
    response = await ask_agent(
        state["messages"][-1].content,
        state["workspace_code"],
        state["thread_id"],
    )

    # Update state with response and suggested prompts
    state["messages"].append({
        "role": "assistant",
        "content": response.response
    })

    state["suggested_next_prompts"] = response.suggested_next_prompts

    # Apply diffs to workspace
    if response.diffs:
        state["workspace_code"] = diff_applier(
            state["workspace_code"],
            response.diffs
        )

    return state


builder = StateGraph(TritonState)

builder.add_node("main_agent", main_agent)

builder.add_edge(START, "main_agent")
builder.add_edge("main_agent", END)

graph = builder.compile()


async def run_graph(query: str,thread_id: str,workspace_code: str) -> TritonState:
    # Read default workspace
    if not workspace_code:
        debug_print(f"No workspace code provided, loading default workspace from workspace.html")
        with open("workspace.html", "r") as f:
            workspace_code = f.read()

    # Define initial state
    initial_state: TritonState = {
        "thread_id": thread_id,
        "messages": [{"role": "user","content": query}],
        "workspace_code": workspace_code,
        "suggested_next_prompts": [],
    }

    debug_print(f"State defined, now running graph for thread_id: {thread_id}")

    final_state = await graph.ainvoke(initial_state)
    return final_state
