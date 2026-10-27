import math
import httpx
from fastembed import TextEmbedding
from sqlalchemy import select, delete
from sqlalchemy.orm import Session
from .config import settings
from .db import Chunk, Document

_embedder = None


class ConfigurationError(RuntimeError):
    pass


def require_client() -> str:
    if settings.gemini_api_key:
        return "gemini"
    if settings.groq_api_key:
        return "groq"
    raise ConfigurationError("Set GEMINI_API_KEY in the project .env file and restart the backend.")


def generate_text(system_prompt: str, user_prompt: str) -> str:
    """Generate a response with Gemini; retain Groq as a backwards-compatible fallback."""
    if settings.gemini_api_key:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{settings.gemini_text_model}:generateContent"
        payload = {
            "systemInstruction": {"parts": [{"text": system_prompt}]},
            "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
            "generationConfig": {"temperature": 0.4, "maxOutputTokens": 2048},
        }
        try:
            response = httpx.post(url, headers={"x-goog-api-key": settings.gemini_api_key}, json=payload, timeout=60)
            response.raise_for_status()
            data = response.json()
            return "".join(part.get("text", "") for part in data["candidates"][0]["content"]["parts"] if part.get("text"))
        except httpx.HTTPStatusError as exc:
            detail = exc.response.text[:400]
            raise RuntimeError(f"Gemini API request failed ({exc.response.status_code}): {detail}") from exc
        except (httpx.HTTPError, KeyError, IndexError, TypeError) as exc:
            raise RuntimeError("Gemini API request failed. Check the API key, model availability, and internet connection.") from exc
    if settings.groq_api_key:
        from openai import OpenAI
        client = OpenAI(api_key=settings.groq_api_key, base_url="https://api.groq.com/openai/v1")
        response = client.chat.completions.create(
            model=settings.groq_text_model,
            messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
        )
        return response.choices[0].message.content or ""
    raise ConfigurationError("Set GEMINI_API_KEY in the project .env file and restart the backend.")


def get_embedder() -> TextEmbedding:
    global _embedder
    if _embedder is None:
        _embedder = TextEmbedding(model_name=settings.local_embedding_model)
    return _embedder


def split_text(text: str, size: int = 1100, overlap: int = 160) -> list[str]:
    normalized = " ".join(text.split())
    if not normalized:
        return []
    chunks, start = [], 0
    while start < len(normalized):
        end = min(start + size, len(normalized))
        if end < len(normalized):
            boundary = normalized.rfind(" ", start + size // 2, end)
            if boundary > start:
                end = boundary
        chunk = normalized[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= len(normalized):
            break
        start = max(end - overlap, start + 1)
    return chunks


def embed_many(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    return [vector.tolist() for vector in get_embedder().embed(texts)]


def index_document(db: Session, filename: str, content_type: str, raw_text: str) -> Document:
    pieces = split_text(raw_text)
    if not pieces:
        raise ValueError("No readable text was found in this file.")
    vectors = embed_many(pieces)
    doc = Document(filename=filename[:255], content_type=content_type[:120])
    db.add(doc)
    db.flush()
    for idx, (piece, vector) in enumerate(zip(pieces, vectors)):
        db.add(Chunk(
            document_id=doc.id,
            filename=doc.filename,
            chunk_index=idx,
            content=piece,
            embedding=vector,
        ))
    db.commit()
    db.refresh(doc)
    return doc


def cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def retrieve(db: Session, query: str, limit: int = 5) -> list[Chunk]:
    vector = embed_many([query])[0]
    chunks = list(db.scalars(select(Chunk)).all())
    chunks.sort(
        key=lambda chunk: cosine_similarity(vector, chunk.embedding),
        reverse=True,
    )
    return chunks[:limit]


def answer_question(db: Session, question: str) -> dict:
    require_client()
    chunks = list(db.scalars(select(Chunk)).all())

    if not chunks:
        answer = generate_text(
            "You are QROYVAN, a helpful AI assistant. Answer clearly and naturally. Do not claim to have read documents unless they were provided.",
            question,
        )
        return {"answer": answer, "sources": []}

    relevant_chunks = retrieve(db, question)
    context = "\n\n".join(
        f"[Source {i+1}: {c.filename}, chunk {c.chunk_index+1}]\n{c.content}"
        for i, c in enumerate(relevant_chunks)
    )
    answer = generate_text(
        "You are QROYVAN, a helpful knowledge assistant. Answer using the retrieved context. If it does not support the answer, say so clearly. Do not invent citations. Cite supported claims with [Source N].",
        f"Retrieved context:\n{context}\n\nUser question: {question}",
    )
    sources = [
        {"filename": c.filename, "chunk": c.chunk_index + 1, "snippet": c.content[:280]}
        for c in relevant_chunks
    ]
    return {"answer": answer, "sources": sources}

def delete_document(db: Session, document_id: int) -> bool:
    doc = db.get(Document, document_id)
    if not doc:
        return False
    db.execute(delete(Chunk).where(Chunk.document_id == document_id))
    db.delete(doc)
    db.commit()
    return True
