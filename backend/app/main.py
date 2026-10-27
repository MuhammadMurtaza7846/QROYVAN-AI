from contextlib import asynccontextmanager
from html.parser import HTMLParser
from urllib.parse import parse_qs, urljoin, urlparse
from pathlib import Path
from uuid import uuid4
import io
import httpx
from docx import Document as DocxDocument
from fastapi import FastAPI, UploadFile, File, HTTPException, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pypdf import PdfReader
from sqlalchemy.orm import Session
from sqlalchemy import select, func
from .config import settings
from .db import SessionLocal, init_db, Document, Chunk
from .rag import answer_question, index_document, delete_document, ConfigurationError, require_client

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield

app = FastAPI(title="QROYVAN AI API", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=list(dict.fromkeys([settings.frontend_origin, "http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:3001", "http://127.0.0.1:3001", "http://localhost:3007", "http://127.0.0.1:3007"])), allow_credentials=True, allow_methods=["GET", "POST", "DELETE", "OPTIONS"], allow_headers=["*"])

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=12000)
    conversation_id: str | None = None

@app.get("/api/health")
def health():
    return {"status": "ok", "service": "qroyvan-api", "configured": bool(settings.gemini_api_key or settings.groq_api_key)}

@app.get("/api/documents")
def list_documents(db: Session = Depends(get_db)):
    rows = db.execute(select(Document, func.count(Chunk.id).label("chunks")).outerjoin(Chunk, Chunk.document_id == Document.id).group_by(Document.id).order_by(Document.created_at.desc())).all()
    return [{"id": d.id, "filename": d.filename, "content_type": d.content_type, "created_at": d.created_at.isoformat() if d.created_at else None, "chunks": count} for d, count in rows]



class DuckDuckGoResultParser(HTMLParser):
    """Small standard-library parser for DuckDuckGo's HTML results page."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.results = []
        self.current = None
        self.div_depth = 0
        self.capture = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = attrs.get("class", "").split()
        if tag == "div" and self.current is None and any(c.startswith("result") for c in classes):
            self.current = {"title": "", "url": "", "snippet": ""}
            self.div_depth = 1
        elif self.current is not None and tag == "div":
            self.div_depth += 1
        if self.current is not None and tag == "a" and "result__a" in classes:
            self.current["url"] = attrs.get("href", "")
            self.capture = "title"
        elif self.current is not None and ("result__snippet" in classes or "result__snippet" in attrs.get("class", "")):
            self.capture = "snippet"
        if self.current is not None and tag in {"br", "p"} and self.capture == "snippet":
            self.current["snippet"] += " "

    def handle_data(self, data):
        if self.current is not None and self.capture in {"title", "snippet"}:
            self.current[self.capture] += data

    def handle_endtag(self, tag):
        if self.current is None:
            return
        if tag == "a" and self.capture == "title":
            self.capture = None
        if tag == "a" and self.capture == "snippet":
            self.capture = None
        if tag == "div":
            self.div_depth -= 1
            if self.div_depth <= 0:
                title = " ".join(self.current["title"].split())
                snippet = " ".join(self.current["snippet"].split())
                raw_url = self.current["url"].strip()
                if title and raw_url:
                    full_url = urljoin("https://html.duckduckgo.com", raw_url)
                    parsed = urlparse(full_url)
                    redirected = parse_qs(parsed.query).get("uddg", [])
                    if redirected:
                        full_url = redirected[0]
                    if full_url.startswith(("https://", "http://")):
                        self.results.append({"title": title, "url": full_url, "snippet": snippet})
                self.current = None
                self.capture = None
                self.div_depth = 0

class WebSearchRequest(BaseModel):
    query: str = Field(min_length=2, max_length=300)

@app.get("/api/web-search")
async def web_search(q: str = Query(..., min_length=2, max_length=300)):
    """Search public web results via DuckDuckGo HTML; no additional API key required."""
    query = q.strip()
    if len(query) < 2:
        raise HTTPException(status_code=422, detail="Enter at least 2 characters to search.")
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"}) as client:
            response = await client.get("https://html.duckduckgo.com/html/", params={"q": query})
        response.raise_for_status()
        parser = DuckDuckGoResultParser()
        parser.feed(response.text)
        # Deduplicate URLs and keep a compact, useful result set.
        unique = []
        seen = set()
        for item in parser.results:
            if item["url"] in seen:
                continue
            seen.add(item["url"])
            unique.append(item)
            if len(unique) >= 10:
                break
        return {"query": query, "provider": "DuckDuckGo", "results": unique}
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="Web search timed out. Try again.") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Could not reach the web search provider. Check internet access.") from exc


def extract_text(filename: str, content_type: str, data: bytes) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix == ".pdf" or content_type == "application/pdf":
        reader = PdfReader(io.BytesIO(data))
        return "\n".join(page.extract_text() or "" for page in reader.pages)
    if suffix == ".docx" or "wordprocessingml" in content_type:
        doc = DocxDocument(io.BytesIO(data))
        return "\n".join(p.text for p in doc.paragraphs)
    if suffix in {".txt", ".md", ".csv", ".json"} or content_type.startswith("text/"):
        return data.decode("utf-8", errors="replace")
    raise HTTPException(status_code=415, detail="Supported formats: PDF, DOCX, TXT, MD, CSV, JSON")

@app.post("/api/documents")
async def upload_document(file: UploadFile = File(...), db: Session = Depends(get_db)):
    data = await file.read()
    max_bytes = settings.max_upload_mb * 1024 * 1024
    if len(data) > max_bytes:
        raise HTTPException(status_code=413, detail=f"File exceeds the {settings.max_upload_mb} MB limit.")
    try:
        text = extract_text(file.filename or "upload.txt", file.content_type or "", data)
        doc = index_document(db, file.filename or f"upload-{uuid4().hex}.txt", file.content_type or "text/plain", text)
    except ConfigurationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not index document: {exc}") from exc
    return {"id": doc.id, "filename": doc.filename, "status": "indexed"}

@app.delete("/api/documents/{document_id}")
def remove_document(document_id: int, db: Session = Depends(get_db)):
    if not delete_document(db, document_id):
        raise HTTPException(status_code=404, detail="Document not found")
    return {"status": "deleted", "id": document_id}

@app.post("/api/chat")
def chat(request: ChatRequest, db: Session = Depends(get_db)):
    try:
        result = answer_question(db, request.message)
    except ConfigurationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI request failed: {exc}") from exc
    return {**result, "conversation_id": request.conversation_id or str(uuid4())}

@app.post("/api/voice/session")
async def create_voice_session():
    """Create a short-lived Gemini Live API token; never return the permanent API key."""
    if not settings.gemini_api_key:
        raise HTTPException(status_code=503, detail="Set GEMINI_API_KEY in the backend .env file to enable Gemini live voice.")
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    # Auth-token creation uses the CreateAuthTokenRequest wrapper. Keep the
    # token short-lived and constrain it to the intended Live API session.
    auth_token = {
        "uses": 1,
        "expireTime": (now + timedelta(minutes=30)).isoformat().replace("+00:00", "Z"),
        "newSessionExpireTime": (now + timedelta(minutes=1)).isoformat().replace("+00:00", "Z"),
        "liveConnectConstraints": {
            "model": f"models/{settings.gemini_live_model}",
            "config": {
                "responseModalities": ["AUDIO"],
                "systemInstruction": {"parts": [{"text": "You are QROYVAN, a warm, concise voice assistant. Speak naturally, answer in the user's language, and allow interruptions. For questions about uploaded files, ask the user to use the chat knowledge search; never invent file contents."}]},
                "inputAudioTranscription": {},
                "outputAudioTranscription": {},
                "realtimeInputConfig": {"automaticActivityDetection": {}},
                "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": settings.gemini_voice}}}
            }
        }
    }
    payload = {"authToken": auth_token}
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                "https://generativelanguage.googleapis.com/v1alpha/auth_tokens",
                headers={"x-goog-api-key": settings.gemini_api_key, "Content-Type": "application/json"},
                json=payload,
            )
        if response.is_error:
            raise HTTPException(status_code=502, detail=f"Gemini Live token setup failed ({response.status_code}): {response.text[:350]}")
        data = response.json()
        token = data.get("name")
        if not token:
            raise HTTPException(status_code=502, detail="Gemini did not return a short-lived Live API token.")
        return {"token": token, "model": settings.gemini_live_model, "voice": settings.gemini_voice,
                "websocket_url": "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained"}
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Could not connect to the Gemini Live API. Check internet access.") from exc
