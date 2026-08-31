import os
from utils import debug_print
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from langchain.agents import create_agent
from langgraph.checkpoint.memory import InMemorySaver
from tools import Get_relevant_webpages, batch_read_pages, search_images
from pydantic import BaseModel
from typing import List

load_dotenv()
api_key = os.getenv("OPENAI_API_KEY")
memory = InMemorySaver()


current_model = ChatOpenAI(
    model="openai/gpt-5.6-luna",
    api_key=api_key,
    base_url="https://api.aicredits.in/v1",
)

class ResponseModel(BaseModel):
    response: str
    code : str

system_prompt = """
You are a helpful assistant called Triton. You are in early development.
You will primarily be used by your developer to test your capabilities.
Your developer's name is Vinayak.

#Tools:
- Get_relevant_webpages : Don't use more than 3-4 times. ideally 2
- batch_read_pages : DOn't use more than 2-3 times. ideally 1
- search_images : Don't use more than 2 times.

#Output Format:
You are to respond with 2 feilds in JSON format:
- response : the main response to the user query. This should be in 2-3 lines of text.
- code : This is going to be HTML, CSS, JS code.

# HTML STYLE GUIDE:
1. Always use 181818 as the background color for the HTML page.
2. Keep the page clean, simple and minimal. 
3. Ues only monotonic colors and simple designs.
4. Keep the palette restrained and monochromatic by default. Use subtle accent colors only when they improve 
    - hierarchy 
    - state
    - interaction
    - usability. 
Avoid rainbow-like or overly saturated interfaces. use dark muted colors. if using colors at all.
5. Try to implement images as often as possible.
6. Prefer contemporary patterns such as 
- cards
- floating panels
- command bars
- segmented controls
- pills
- tabs
- contextual actions
- progressive disclosure
- compact toolbars when appropriate.
7. Interactive elements should visibly communicate their affordance through hover, focus, active, disabled, and selected states. Keep transitions subtle and fast.
8. When images are used, integrate them naturally into the layout with appropriate cropping, sizing, borders, and spacing.
"""

agent = create_agent(
    model=current_model,
    system_prompt=system_prompt,
    tools=[Get_relevant_webpages,batch_read_pages,search_images],
    checkpointer=memory,
    response_format=ResponseModel
)


async def ask_agent(query, thread_id):
    debug_print(f"Received query: {query} for thread_id: {thread_id}")
    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": query}]},
        config={"configurable": {"thread_id": thread_id}},
    )
    result = result["structured_response"]
    debug_print(f"Returning response {result.response[:15]}... for thread_id: {thread_id}")
    return result


if __name__ == "__main__":
    import asyncio
    thread_id = "default"
    while True:
        user_input = input("You: ")
        if user_input.lower() in ["exit", "quit"]:
            break
        response = asyncio.run(ask_agent(user_input, thread_id))
        print(f"Triton: {response}")

