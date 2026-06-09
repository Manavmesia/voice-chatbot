# STS AI ChatBot

Real-time, full-duplex Speech-to-Speech AI Voice Assistant grounded strictly in your uploaded PDF documents. Supports multilingual input/output, barge-in interruption, and streaming TTS.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16, React 19, Tailwind CSS v4 |
| Backend | FastAPI, Python 3.11 |
| LLM | Groq (Llama 3.3 70B) |
| Embeddings | HuggingFace `all-MiniLM-L6-v2` (local) |
| Vector DB | ChromaDB (local) |
| TTS | Microsoft Edge TTS (free, via `edge-tts`) |
| STT | Web Speech API (browser-native) |

---

## Local Development

### Prerequisites

- Python 3.11+
- Node.js 20+
- A free Groq API key from [console.groq.com](https://console.groq.com)

### 1. Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate       # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
# Edit .env and set GROQ_API_KEY=your_key_here

uvicorn app.main:app --reload --port 8000
```

### 2. Frontend

```bash
cd frontend
npm install

cp .env.example .env.local
# .env.local already has the right localhost defaults

npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Production — Docker Compose

```bash
cp backend/.env.example backend/.env
# Edit backend/.env and set GROQ_API_KEY

docker compose up --build
```

App runs at [http://localhost:3000](http://localhost:3000).
PDF data and ChromaDB index persist in the `backend_data` Docker volume.

---

## Production — Custom Deployment

### Backend (any Python host)

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1
```

> Use `--workers 1`. The in-memory session state is not shared across multiple worker processes.

Required environment variables:

| Variable | Description |
|---|---|
| `GROQ_API_KEY` | Your Groq API key |
| `ALLOWED_ORIGINS` | Comma-separated frontend URLs (e.g. `https://app.yourdomain.com`) |
| `DATA_DIR` | Path to the persistent data directory |
| `GROQ_MODEL` | (optional) Groq model name, default `llama-3.3-70b-versatile` |
| `TTS_VOICE` | (optional) Edge TTS voice name |
| `TTS_RATE` | (optional) TTS speaking rate, e.g. `-10%` |
| `MAX_UPLOAD_MB` | (optional) Max PDF upload size in MB, default `50` |

### Frontend (Vercel / any Node host)

```bash
npm run build
npm start
```

Required environment variables:

| Variable | Description |
|---|---|
| `BACKEND_URL` | Backend URL for server-side proxy rewrites (e.g. `https://api.yourdomain.com`) |
| `NEXT_PUBLIC_WS_BASE` | WebSocket URL used by the browser (e.g. `wss://api.yourdomain.com`) |

---

## Configuration Reference

### `backend/.env`

See [`backend/.env.example`](backend/.env.example) for all options.

### `frontend/.env.local`

See [`frontend/.env.example`](frontend/.env.example) for all options.

---

## Project Structure

```
├── backend/
│   ├── app/
│   │   ├── config.py       # Environment config
│   │   ├── main.py         # FastAPI app, WebSocket pipeline
│   │   ├── memory.py       # Per-session conversation memory
│   │   ├── rag.py          # RAG engine: language detection, retrieval, LLM
│   │   └── speech.py       # Edge TTS synthesis + sentence buffering
│   ├── .env.example
│   ├── Dockerfile
│   └── requirements.txt
├── frontend/
│   ├── src/app/
│   │   ├── components/
│   │   │   └── FormattedMessage.tsx  # Markdown renderer
│   │   ├── hooks/
│   │   │   └── useAudioPlayer.ts     # Web Audio API playback hook
│   │   ├── globals.css
│   │   ├── layout.tsx
│   │   └── page.tsx                  # Main UI
│   ├── .env.example
│   ├── Dockerfile
│   ├── next.config.ts
│   └── package.json
├── docker-compose.yml
├── .gitignore
└── README.md
```
