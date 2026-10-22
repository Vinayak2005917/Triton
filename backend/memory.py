import json
from datetime import datetime, timezone
from typing import Any

from langchain.agents import create_agent
from langchain_core.messages import HumanMessage
from langchain.tools import tool
from langchain_text_splitters import RecursiveCharacterTextSplitter

from storage import store
from vector_search import embed_query, embed_texts, semantic_search


MEMORY_COLLECTION = "memory"
KNOWLEDGE_COLLECTION = "knowledge"
COLLECTION_NAMES = (MEMORY_COLLECTION, KNOWLEDGE_COLLECTION)
TOP_K = 5

MEMORY_WRITER_PROMPT = """You maintain Triton's long-term memory.
You will receive the user's current request and Triton's completed response.
Save only durable preferences, user-stated facts, ongoing projects, or goals
that are likely to help in a future conversation. Use the upsert_memory tool
only when the exchange contains something worth remembering. Do not save
one-off requests, assistant speculation, secrets, or the full response. Write
one concise, standalone memory and choose an appropriate category. If nothing
is useful long term, do not call the tool.
"""


def initialize_memory_storage() -> None:
    """Initialize Triton's local Qdrant store and the two vector collections."""
    store.initialize()
    store.get_install_id()
    store.initialize_vector_storage(COLLECTION_NAMES)


def close_memory_storage() -> None:
    store.close_vector_storage()


def _retrieve_both(query: str) -> dict[str, list[dict[str, Any]]]:
    if not store.vector_store_initialized:
        initialize_memory_storage()

    query_vector = embed_query(query)
    owner_id = store.get_install_id()
    results: dict[str, list[dict[str, Any]]] = {}
    for collection_name in COLLECTION_NAMES:
        with store.vector_lock:
            hits = semantic_search(
                store.vector_client,
                collection_name,
                query,
                owner_id,
                limit=TOP_K,
                query_vector=query_vector,
            )
        results[collection_name] = [
            {
                "text": str((hit.payload or {}).get("text") or ""),
                "score": float(hit.score),
                **{
                    key: value
                    for key, value in (hit.payload or {}).items()
                    if key not in {"text", "owner_id"}
                },
            }
            for hit in hits
        ]
    return results


def retrieve_context_for_prompt(query: str) -> dict[str, list[dict[str, Any]]]:
    """Retrieve five likely matches from each collection for prompt context."""
    return _retrieve_both(query)


@tool(
    "upsert_memory",
    description=(
        "Save one concise, durable user memory for future conversations. "
        "Use only for user-stated preferences, facts, ongoing projects, or goals; "
        "do not store one-off requests or assistant guesses."
    ),
)
def upsert_memory(text: str, category: str = "fact") -> str:
    normalized_text = " ".join(text.split())
    if not normalized_text:
        return "No memory saved: the text was empty."
    if len(normalized_text) > 1200:
        return "No memory saved: keep each memory under 1,200 characters."
    if category not in {"preference", "fact", "project", "goal"}:
        return "No memory saved: choose preference, fact, project, or goal."
    if not store.vector_store_initialized:
        initialize_memory_storage()

    vector = embed_texts([normalized_text])[0]
    saved_count = store.upsert_vector_records(
        MEMORY_COLLECTION,
        [{
            "text": normalized_text,
            "vector": vector,
            "metadata": {
                "category": category,
                "created_at": datetime.now(timezone.utc).isoformat(),
            },
        }],
    )
    return f"Saved {saved_count} memory item." if saved_count else "No memory was saved."


@tool("retrieve_memory_and_knowledge",description=("Retrieve up to five relevant saved memories and five source-backed web knowledge chunks for a query. Use this when prior context may help. Knowledge results include their source and retrieval metadata."),)
def retrieve_memory_and_knowledge(query: str) -> str:
    try:
        return json.dumps(_retrieve_both(query), ensure_ascii=False)
    except Exception:
        return json.dumps({"memory": [], "knowledge": [], "available": False})


def format_retrieved_context(results: dict[str, list[dict[str, Any]]]) -> str:
    """Format retrieved records as reference text, keeping source metadata visible."""
    sections = []
    for collection_name, title in (
        (MEMORY_COLLECTION, "Saved user memory"),
        (KNOWLEDGE_COLLECTION, "Saved web knowledge"),
    ):
        records = results.get(collection_name) or []
        if not records:
            continue
        sections.append(title + ":")
        for record in records:
            text = str(record.get("text") or "").strip()
            if not text:
                continue
            source = record.get("source_url")
            retrieved_at = record.get("retrieved_at")
            details = []
            if source:
                details.append(f"source: {source}")
            if retrieved_at:
                details.append(f"retrieved: {retrieved_at}")
            suffix = f" ({'; '.join(details)})" if details else ""
            sections.append(f"- {text}{suffix}")
    return "\n".join(sections)


def upsert_knowledge_chunks(records: list[dict[str, Any]]) -> int:
    """Persist ranked web chunks using their already-computed embeddings."""
    if not records:
        return 0
    if not store.vector_store_initialized:
        initialize_memory_storage()
    return store.upsert_vector_records(KNOWLEDGE_COLLECTION, records)


def upsert_knowledge_text(text: str, metadata: dict[str, Any]) -> int:
    """Embed and store a text result from a non-chunked research tool."""
    if not text.strip():
        return 0
    if not store.vector_store_initialized:
        initialize_memory_storage()
    splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=150)
    chunks = splitter.split_text(text.strip())
    return store.upsert_text_records(
        KNOWLEDGE_COLLECTION,
        [
            {
                "text": chunk,
                "metadata": {**metadata, "chunk_index": index},
            }
            for index, chunk in enumerate(chunks, start=1)
        ],
    )


async def consider_saving_memory(
    query: str,
    response: str,
    model,
) -> None:
    """Run the post-response memory curator agent; it may choose not to write."""
    writer = create_agent(
        model=model,
        system_prompt=MEMORY_WRITER_PROMPT,
        tools=[upsert_memory],
    )
    await writer.ainvoke({
        "messages": [
            HumanMessage(
                content=(
                    f"User request:\n{query}\n\n"
                    f"Triton's completed response:\n{response}"
                )
            )
        ]
    })
