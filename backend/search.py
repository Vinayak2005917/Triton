import asyncio
import os
import re
import time
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from firecrawl import Firecrawl
from langchain.tools import tool
from websocket import send_tool_update
from langchain_text_splitters import RecursiveCharacterTextSplitter

from vector_search import EMBEDDINGS_MODEL, embed_texts, rank_by_similarity
from utils import debug_print


JINA_SEARCH_URL = "https://s.jina.ai/"
NUM_RESULTS = 1
CHUNK_SIZE = 1000
CHUNK_OVERLAP = 150
TOP_K = 3
MAX_QUERIES = 5


def _validate_queries(queries: list[str]) -> None:
    if not isinstance(queries, list):
        raise TypeError("queries must be a list of strings")
    if len(queries) > MAX_QUERIES:
        raise ValueError(f"At most {MAX_QUERIES} queries are allowed")
    if any(not isinstance(query, str) or not query.strip() for query in queries):
        raise ValueError("Every query must be a non-empty string")


def _field(value: Any, *names: str) -> Any:
    for name in names:
        if isinstance(value, Mapping) and name in value:
            return value[name]
        attribute = getattr(value, name, None)
        if attribute is not None:
            return attribute
    return None


def _extract_firecrawl_result(response: Any) -> tuple[str, str | None, str | None]:
    items = _field(response, "web", "web_results", "results", "data")
    if items is None:
        items = response
    if isinstance(items, Mapping):
        items = [items]
    elif not isinstance(items, (list, tuple)):
        try:
            items = list(items)
        except TypeError:
            items = [items]

    content = []
    source_url = None
    source_title = None
    for item in items:
        text = _field(item, "markdown", "content", "text", "description")
        if not text:
            continue
        content.append(str(text).strip())
        if source_url is None:
            source_url = _field(item, "url", "source_url", "link")
            source_title = _field(item, "title", "name")
    return "\n\n".join(content), source_url, source_title


def _first_url(content: str) -> str | None:
    match = re.search(r"https?://[^\s\])>\"']+", content)
    return match.group(0).rstrip(".,;") if match else None


def _fetch_search_content(
    query: str,
    query_number: int,
    client: httpx.Client,
    jina_api_key: str | None,
    firecrawl: Firecrawl | None,
) -> tuple[str, str, str | None, str | None]:
    errors = []

    if jina_api_key:
        try:
            start = time.perf_counter()
            response = client.get(
                JINA_SEARCH_URL,
                params={"q": query, "num": NUM_RESULTS},
                headers={"Authorization": f"Bearer {jina_api_key}"},
            )
            response.raise_for_status()
            content = response.text.strip()
            if not content:
                raise ValueError("Jina returned empty content")
            debug_print(f"Query {query_number} Jina search took {time.perf_counter() - start:.2f}s; {len(content):,} characters")
            return content, "jina", _first_url(content), None
        except Exception as error:
            errors.append(f"Jina: {error}")
            debug_print(f"Query {query_number} Jina failed; trying Firecrawl: {error}")
    else:
        errors.append("Jina: JINA_API_KEY is not set")
        debug_print(f"Query {query_number} has no JINA_API_KEY; trying Firecrawl")

    if firecrawl:
        try:
            start = time.perf_counter()
            response = firecrawl.search(query,limit=NUM_RESULTS,scrape_options={"formats": ["markdown"]},)
            content, source_url, source_title = _extract_firecrawl_result(response)
            if not content:
                raise ValueError("Firecrawl returned no markdown/text")
            debug_print(f"Query {query_number} Firecrawl fallback took {time.perf_counter() - start:.2f}s; {len(content):,} characters")
            return content, "firecrawl", source_url or _first_url(content), source_title
        except Exception as error:
            errors.append(f"Firecrawl: {error}")
    else:
        errors.append("Firecrawl: FIRECRAWL_API_KEY is not set")

    raise RuntimeError("; ".join(errors))


def _chunk_and_rank(
    query: str,
    content: str,
    splitter: RecursiveCharacterTextSplitter,
    query_number: int,
) -> list[dict[str, Any]]:
    start = time.perf_counter()
    chunks = splitter.split_text(content)
    debug_print(f"Query {query_number} chunking took {time.perf_counter() - start:.2f}s; created {len(chunks)} chunks")
    if not chunks:
        return []

    start = time.perf_counter()
    vectors = embed_texts([query, *chunks])
    debug_print(f"Query {query_number} embedding call ({EMBEDDINGS_MODEL}) took {time.perf_counter() - start:.2f}s for {len(vectors)} texts")

    start = time.perf_counter()
    query_vector, chunk_vectors = vectors[0], vectors[1:]
    ranked = rank_by_similarity(query_vector, chunks, chunk_vectors, TOP_K)
    debug_print(f"Query {query_number} ranking took {time.perf_counter() - start:.2f}s; returning {len(ranked)} chunks")
    return ranked


def _search_one_query(
    query: str,
    query_number: int,
    jina_api_key: str | None,
    firecrawl_api_key: str | None,
) -> dict[str, Any]:
    source = None
    source_url = None
    source_title = None
    try:
        firecrawl = Firecrawl(api_key=firecrawl_api_key) if firecrawl_api_key else None
        splitter = RecursiveCharacterTextSplitter(
            chunk_size=CHUNK_SIZE,
            chunk_overlap=CHUNK_OVERLAP,
        )
        with httpx.Client(timeout=60.0) as client:
            content, source, source_url, source_title = _fetch_search_content(
                query,
                query_number,
                client,
                jina_api_key,
                firecrawl,
            )
        chunks = _chunk_and_rank(query, content, splitter, query_number)
        return {
            "query": query,
            "source": source,
            "source_url": source_url,
            "source_title": source_title,
            "chunks": chunks,
            "error": None if chunks else "Search result produced no chunks",
        }
    except Exception as error:
        debug_print(f"Query {query_number} failed: {error}")
        return {
            "query": query,
            "source": source,
            "source_url": source_url,
            "source_title": source_title,
            "chunks": [],
            "error": str(error),
        }


@tool("multi_search",description=("Search up to five queries get the three most relevant text chunks per query."),)
async def multi_search(queries: list[str]) -> list[dict[str, Any]]:
    _validate_queries(queries)
    if not queries:
        return []

    load_dotenv(Path(__file__).with_name(".env"))
    jina_api_key = os.getenv("JINA_API_KEY")
    firecrawl_api_key = os.getenv("FIRECRAWL_API_KEY")
    openai_api_key = os.getenv("OPENAI_API_KEY")
    if not openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not set in the environment or .env file.")
    if not jina_api_key and not firecrawl_api_key:
        raise RuntimeError("Set JINA_API_KEY or FIRECRAWL_API_KEY in the environment or .env file.")

    debug_print(f"Starting multi_search for {queries} queries")
    send_tool_update(f"Starting multi_search for {queries} queries", tool_name="multi_search")

    tasks = [
        asyncio.to_thread(
            _search_one_query,
            query,
            query_number,
            jina_api_key,
            firecrawl_api_key,
        )
        for query_number, query in enumerate(queries, 1)
    ]
    results = await asyncio.gather(*tasks)
    from memory import upsert_knowledge_chunks

    retrieved_at = datetime.now(timezone.utc).isoformat()
    for result in results:
        chunk_records = []
        for chunk_index, chunk in enumerate(result.get("chunks") or [], start=1):
            vector = chunk.pop("vector", None)
            if vector is None:
                continue
            chunk_records.append({
                "text": chunk["text"],
                "vector": vector,
                "metadata": {
                    "query": result["query"],
                    "provider": result.get("source"),
                    "source_url": result.get("source_url"),
                    "source_title": result.get("source_title"),
                    "retrieved_at": retrieved_at,
                    "rank": chunk_index,
                    "similarity": chunk.get("score"),
                },
            })
        if chunk_records:
            try:
                upsert_knowledge_chunks(chunk_records)
            except Exception as error:
                debug_print(f"Could not store web knowledge for {result['query']}: {error}")
        result["chunks"] = [
            {"text": chunk["text"], "score": chunk["score"]}
            for chunk in result.get("chunks") or []
        ]
    return results

if __name__ == "__main__":
    test_queries = [
        "What is the capital of France?",
        "Explain the theory of relativity.",
        "How does photosynthesis work?",
    ]
    start = time.perf_counter()
    search_results = asyncio.run(multi_search(test_queries))
    end = time.perf_counter()
    print(f"Search completed in {end - start:.2f} seconds")
