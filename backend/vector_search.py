"""Shared embedding and Qdrant semantic-search helpers."""

import os
from functools import lru_cache
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from langchain_openai import OpenAIEmbeddings


load_dotenv(Path(__file__).with_name(".env"))

EMBEDDINGS_BASE_URL = "https://api.aicredits.in/v1"
EMBEDDINGS_MODEL = "text-embedding-3-small"
VECTOR_SIZE = 1536


@lru_cache(maxsize=1)
def _embedding_client() -> OpenAIEmbeddings:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    return OpenAIEmbeddings(
        model=EMBEDDINGS_MODEL,
        api_key=api_key,
        base_url=EMBEDDINGS_BASE_URL,
    )


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed document texts with the model used by Triton's web search."""
    if not texts:
        return []
    return _embedding_client().embed_documents(texts)


def embed_query(query: str) -> list[float]:
    """Embed one retrieval query with Triton's configured embedding model."""
    return _embedding_client().embed_query(query)


def semantic_search(
    client: Any,
    collection_name: str,
    query: str,
    owner_id: str,
    limit: int = 5,
    query_vector: list[float] | None = None,
) -> list[Any]:
    """Retrieve the closest points belonging to one local Triton installation."""
    from qdrant_client import models

    vector = query_vector if query_vector is not None else embed_query(query)
    response = client.query_points(
        collection_name=collection_name,
        query=vector,
        query_filter=models.Filter(
            must=[
                models.FieldCondition(
                    key="owner_id",
                    match=models.MatchValue(value=owner_id),
                )
            ]
        ),
        limit=limit,
        with_payload=True,
    )
    return response.points


def rank_by_similarity(
    query_vector: list[float],
    texts: list[str],
    document_vectors: list[list[float]],
    limit: int,
) -> list[dict[str, Any]]:
    """Rank candidate text chunks and retain vectors for direct Qdrant ingestion."""
    if len(texts) != len(document_vectors):
        raise ValueError("Each text must have a corresponding embedding")

    query_norm = sum(value * value for value in query_vector) ** 0.5
    ranked: list[dict[str, Any]] = []
    for text, vector in zip(texts, document_vectors):
        vector_norm = sum(value * value for value in vector) ** 0.5
        if not query_norm or not vector_norm:
            score = 0.0
        else:
            dot = sum(left * right for left, right in zip(query_vector, vector))
            score = dot / (query_norm * vector_norm)
        ranked.append({"text": text, "score": score, "vector": vector})

    return sorted(ranked, key=lambda item: item["score"], reverse=True)[:limit]
