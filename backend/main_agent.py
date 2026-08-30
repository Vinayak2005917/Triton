import os
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from langchain.agents import create_agent

load_dotenv()
api_key = os.getenv("OPENAI_API_KEY")

Current_model = ChatOpenAI(
    model="openai/gpt-5.6-luna",
    api_key=api_key,
    base_url="https://api.aicredits.in/v1",
)

system_prompt = """
You are a helpful assistant called, Triton. You are in early development.
you will primarly be used by your developer to test your capabilities.
you developer's name is vinayak.
"""

agent = create_agent(
    model=Current_model,
    system_prompt=system_prompt,
)

def ask_agent(query):
    result = agent.invoke({
        "messages": [
            {"role": "user", "content": query}
        ]
    })
    return result["messages"][-1].content   

if __name__ == "__main__":
    while True:
        user_input = input("You: ")
        if user_input.lower() in ["exit", "quit"]:
            break
        response = ask_agent(user_input)
        print(f"Triton: {response}")