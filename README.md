# QROYVAN AI — Gemini integration

This source package keeps the existing QROYVAN frontend design and connects the existing chat/RAG backend to Google's Gemini API. The permanent Gemini key is read only by the backend from `.env`; it is not included in this ZIP or frontend bundle.

## Features

- Chat responses through Gemini (`GEMINI_TEXT_MODEL`).
- Document upload and RAG retrieval using local FastEmbed embeddings, with source snippets returned to chat.
- Live voice through Gemini Live API WebSockets using a short-lived ephemeral token minted by the backend.
- Optional legacy Groq text fallback if `GEMINI_API_KEY` is blank and `GROQ_API_KEY` is configured.
- SQLite default for local runs; Docker Compose uses PostgreSQL/pgvector service settings already in the compose file.

## Configure on Windows

1. Copy `.env.example` to `.env` in the project root.
2. In Google AI Studio, create a Gemini API key. Put it in `.env` as `GEMINI_API_KEY=YOUR_KEY`. Do not put the key in `frontend` code or send it in chat.
3. Open PowerShell in the project root and install backend dependencies in your Python environment:

   `python -m pip install -r backend/requirements.txt`

4. Start backend in one PowerShell window:

   `cd backend`

   `python -m uvicorn app.main:app --host 127.0.0.1 --port 8011`

5. In a second PowerShell window, start frontend:

   `cd frontend`

   `npm.cmd install`

   `$env:NEXT_PUBLIC_API_URL='http://127.0.0.1:8011'`

   `npm.cmd run dev -- --port 3007`

6. Open `http://localhost:3007`.

## Configuration

- `GEMINI_API_KEY`: required for Gemini chat/RAG and Gemini Live voice.
- `GEMINI_TEXT_MODEL`: default `gemini-3.8-flash`.
- `GEMINI_LIVE_MODEL`: default `gemini-3.8-live`; availability depends on the Google AI Studio project/model access.
- `GEMINI_VOICE`: default `Puck`.
- `DATABASE_URL`: defaults to local SQLite when omitted from `.env.example` adjustments. Docker Compose sets PostgreSQL URL for its backend service.
- `FRONTEND_ORIGIN`: set to `http://localhost:3007` for local dev. Docker Compose overrides it for its port 3000 setup.

## Security

Treat API keys like passwords. If a key was pasted into a chat, screenshot, source file, or public repository, revoke it and create a new one. Only `.env.example` is included; your actual `.env`, database, uploaded documents, local embeddings, and backups are intentionally excluded.

## Validation status

Backend Python files passed `py_compile`, and the existing frontend encoding-fix script passed `node --check`. A full Next.js build and authenticated Gemini chat/Live voice session require installing dependencies and using a valid Gemini key in your own environment; those network-dependent tests have not been claimed as passed here.
