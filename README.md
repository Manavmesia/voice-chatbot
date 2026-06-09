# Antigravity Speech AI

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

## Production — Render Deployment

The project ships with a `render.yaml` Blueprint that defines both services. This is the fastest way to deploy.

### Step 1 — Push to GitHub

```bash
cd /path/to/Voice-ChatBot\(AI\)
git init
git add .
git commit -m "Initial commit"
# Create a repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

> The `.gitignore` is already configured — `backend/.env`, `backend/data/`, `node_modules/`, and `.next/` are all excluded.

### Step 2 — Create a Render Blueprint

1. Go to [dashboard.render.com](https://dashboard.render.com) → **New** → **Blueprint**
2. Connect your GitHub repo
3. Render detects `render.yaml` automatically and shows two services: `antigravity-backend` and `antigravity-frontend`
4. Click **Apply**

### Step 3 — Set Secret Environment Variables

Render will pause and ask you to fill in variables marked `sync: false`:

| Service | Variable | Value |
|---|---|---|
| `antigravity-backend` | `GROQ_API_KEY` | Your Groq API key from [console.groq.com](https://console.groq.com) |
| `antigravity-backend` | `ALLOWED_ORIGINS` | Set this after Step 4 (see below) |

For now set `ALLOWED_ORIGINS` to `*` temporarily so the frontend can connect during the first deploy. You will lock it down in Step 5.

### Step 4 — Note Your URLs

After both services deploy, Render assigns public URLs:
- Backend: `https://antigravity-backend.onrender.com` (or similar)
- Frontend: `https://antigravity-frontend.onrender.com`

### Step 5 — Lock Down CORS

Go to the **backend service** → Environment → update `ALLOWED_ORIGINS`:
```
https://antigravity-frontend.onrender.com
```
Click **Save Changes** — Render redeploys automatically.

### Step 6 — Verify

Open `https://antigravity-frontend.onrender.com`. Upload a PDF, start a conversation, and confirm voice works.

---

### Important Render Notes

**Free tier (Starter plan) spins down after 15 minutes of inactivity.** The first request after spin-down takes ~30 seconds. Upgrade to the **Standard plan** ($7/mo per service) for always-on behaviour.

**Data persistence:** The `render.yaml` mounts a 1 GB disk at `/app/data` on the backend. Your uploaded PDFs and ChromaDB index survive across redeploys. Without the disk, everything resets on each deploy.

**WebSockets:** Render supports WebSocket connections natively — no extra configuration needed.

**Workers:** The backend runs with `--workers 1`. Do not increase this — session state is in-memory and not shared across processes.

**URL format:** Render uses `https://` for web traffic and your WebSocket connections must use `wss://` (already configured in `render.yaml`).

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
