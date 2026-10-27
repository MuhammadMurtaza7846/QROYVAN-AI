from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    gemini_api_key: str = ""
    gemini_text_model: str = "gemini-3.8-flash"
    gemini_live_model: str = "gemini-3.8-live"
    gemini_voice: str = "Puck"
    groq_api_key: str = ""  # optional legacy provider; Gemini is the primary provider
    groq_text_model: str = "openai/gpt-oss-20b"
    local_embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    database_url: str = "sqlite:///./qroyvan.db"
    frontend_origin: str = "http://localhost:3007"
    max_upload_mb: int = 20
    upload_dir: str = "/app/uploads"
    model_config = SettingsConfigDict(
    env_file=str(Path(__file__).resolve().parents[2] / ".env"),
    extra="ignore",
)
settings = Settings()

