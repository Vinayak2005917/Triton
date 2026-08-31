import os
from utils import debug_print
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from langchain.agents import create_agent
from langgraph.checkpoint.memory import InMemorySaver
from tools import Get_relevant_webpages, batch_read_pages, search_images
from pydantic import BaseModel
from typing import List
import time

load_dotenv()
api_key = os.getenv("OPENAI_API_KEY")
memory = InMemorySaver()


current_model = ChatOpenAI(
    model="openai/gpt-5.6-luna",
    api_key=api_key,
    base_url="https://api.aicredits.in/v1",
)

class DiffBlock(BaseModel):
    search: str
    replace: str

class ResponseModel(BaseModel):
    response: str
    diffs: list[DiffBlock]
    suggested_next_prompts: list[str]



# Keep this outside ask_agent, near the top of the file
with open("prompts/main_agent.txt", "r") as f:
    system_prompt = f.read()

agent = create_agent(
    model=current_model,
    system_prompt=system_prompt,
    tools=[Get_relevant_webpages, batch_read_pages, search_images],
    checkpointer=memory,
    response_format=ResponseModel,
)


async def ask_agent(query, workspace_code, thread_id):
    debug_print(f"Received query: {query} for thread_id: {thread_id}")

    enriched_query = (
        f"{query}\n\n"
        f"Current date and time: {time.strftime('%Y-%m-%d %H:%M:%S')}\n"
        f"Workspace code:\n{workspace_code}"
    )

    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": enriched_query}]},
        config={"configurable": {"thread_id": thread_id}},
    )

    return result["structured_response"]


