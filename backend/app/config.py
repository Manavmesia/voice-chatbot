import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(dotenv_path=BASE_DIR / ".env")

# ── Storage ────────────────────────────────────────────────────────────────────
DATA_DIR = Path(os.getenv("DATA_DIR", str(BASE_DIR / "data")))
DOCUMENTS_DIR = DATA_DIR / "documents"
CHROMA_DIR = DATA_DIR / "chroma"

DOCUMENTS_DIR.mkdir(parents=True, exist_ok=True)
CHROMA_DIR.mkdir(parents=True, exist_ok=True)

# ── Groq AI ────────────────────────────────────────────────────────────────────
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")

# ── TTS ────────────────────────────────────────────────────────────────────────
TTS_VOICE = os.getenv("TTS_VOICE", "en-US-EmmaMultilingualNeural")
TTS_RATE = os.getenv("TTS_RATE", "-10%")

# ── Server ─────────────────────────────────────────────────────────────────────
# Comma-separated list of allowed CORS origins.
# Example: ALLOWED_ORIGINS=https://app.yourdomain.com,https://yourdomain.com
# Defaults to localhost only for local development.
ALLOWED_ORIGINS: list[str] = [
    o.strip()
    for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:3000").split(",")
    if o.strip()
]

# Maximum PDF upload size in megabytes.
MAX_UPLOAD_MB: int = int(os.getenv("MAX_UPLOAD_MB", "50"))


def validate_config() -> list[str]:
    """Returns a list of configuration error messages, empty if all is well."""
    errors = []
    if not GROQ_API_KEY or GROQ_API_KEY == "your_groq_api_key_here":
        errors.append("GROQ_API_KEY is not set or is still using the placeholder value.")
    return errors
