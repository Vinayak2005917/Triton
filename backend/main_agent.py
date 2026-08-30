import os
from utils import debug_print
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from langchain.agents import create_agent
from langgraph.checkpoint.memory import InMemorySaver
from tools import Get_relevant_webpages, batch_read_pages

load_dotenv()
api_key = os.getenv("OPENAI_API_KEY")
memory = InMemorySaver()


current_model = ChatOpenAI(
    model="openai/gpt-5.6-luna",
    api_key=api_key,
    base_url="https://api.aicredits.in/v1",
)

system_prompt = """
You are a helpful assistant called Triton. You are in early development.
You will primarily be used by your developer to test your capabilities.
Your developer's name is Vinayak.

#Tools:
- Get_relevant_webpages : Don't use more than 3-4 times. ideally 2
- batch_read_pages : DOn't use more than 2-3 times. ideally 1
"""

agent = create_agent(
    model=current_model,
    system_prompt=system_prompt,
    tools=[Get_relevant_webpages,batch_read_pages,],
    checkpointer=memory,
)


async def ask_agent(query, thread_id):
    debug_print(f"Received query: {query} for thread_id: {thread_id}")
    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": query}]},
        config={"configurable": {"thread_id": thread_id}},
    )
    debug_print(f"Returning response {result['messages'][-1].content[:15]}... for thread_id: {thread_id}")
    return result["messages"][-1].content


if __name__ == "__main__":
    import asyncio
    thread_id = "default"
    while True:
        user_input = input("You: ")
        if user_input.lower() in ["exit", "quit"]:
            break
        response = asyncio.run(ask_agent(user_input, thread_id))
        print(f"Triton: {response}")

