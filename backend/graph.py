from typing import Annotated
from typing_extensions import TypedDict
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages

from main_agent import ask_agent, current_model
from pydantic import BaseModel


class TritonState(TypedDict):
    thread_id: str
    request_id: str
    query: str
    messages: Annotated[list, add_messages]
    workspace_code: str
    tab_name: str
    response: str
    suggested_next_prompts: list[str]
    websocket: object


class SuggestionsModel(BaseModel):
    suggested_next_prompts: list[str]


async def tab_name_node(state: TritonState) -> TritonState:
    result = await current_model.ainvoke(
        "Create a short browser tab title for the user's request below. "
        "Return only a title of 1 to 4 words, without quotes or explanation.\n\n"
        f"User request: {state['query']}"
    )
    content = result.content
    if isinstance(content, str):
        name = content
    elif isinstance(content, list):
        name = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    else:
        name = str(content)
    name = " ".join(name.strip().strip("`\"' ").split()[:4])
    state["tab_name"] = name
    await state["websocket"].send_json({"type": "tab_name", "request_id": state["request_id"], "name": name})
    return state


async def research_edit_node(state: TritonState) -> TritonState:
    response, updated_workspace = await ask_agent(
        state["query"], state["workspace_code"], state["thread_id"],
        request_id=state["request_id"],
    )
    state["response"] = response.response
    state["workspace_code"] = updated_workspace
    state["messages"].append({"role": "assistant", "content": response.response})
    await state["websocket"].send_json({
        "type": "response",
        "request_id": state["request_id"],
        "response": response.response,
        "workspace_code": updated_workspace,
    })
    return state


async def suggestions_node(state: TritonState) -> TritonState:
    prompt = (
        "Suggest exactly 3 concise next prompts for the user based on their request "
        "and the agent's completed response. Each must be no more than 7 words. "
        "Return only the structured field.\n\n"
        f"Request: {state['query']}\nResponse: {state['response']}"
    )
    result = await current_model.with_structured_output(SuggestionsModel).ainvoke(prompt)
    state["suggested_next_prompts"] = result.suggested_next_prompts[:3]
    await state["websocket"].send_json({
        "type": "suggested_prompts",
        "request_id": state["request_id"],
        "suggested_next_prompts": state["suggested_next_prompts"],
    })
    return state


builder = StateGraph(TritonState)
builder.add_node("tab_name", tab_name_node)
builder.add_node("research_edit", research_edit_node)
builder.add_node("suggestions", suggestions_node)

builder.add_edge(START, "tab_name")
builder.add_edge("tab_name", "research_edit")
builder.add_edge("research_edit", "suggestions")
builder.add_edge("suggestions", END)
graph = builder.compile()


async def run_graph(query: str, thread_id: str, workspace_code: str, request_id: str, websocket) -> TritonState:
    if not workspace_code:
        raise ValueError("workspace_code must be provided by the frontend")

    initial_state: TritonState = {
        "thread_id": thread_id,
        "request_id": request_id,
        "query": query,
        "messages": [{"role": "user", "content": query}],
        "workspace_code": workspace_code,
        "tab_name": "",
        "response": "",
        "suggested_next_prompts": [],
        "websocket": websocket,
    }
    return await graph.ainvoke(initial_state)
