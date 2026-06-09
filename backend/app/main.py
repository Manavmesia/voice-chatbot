import asyncio
import base64
import json
import shutil
from contextlib import asynccontextmanager
from typing import Any, List

from app import config
from app.memory import MemoryManager
from app.rag import RAGEngine
from app.speech import EdgeTTS, SentenceBuffer
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

# ---------------------------------------------------------------------------
# Application lifespan (replaces deprecated @app.on_event)
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Validate configuration on startup; clean up on shutdown."""
    print("Starting Speech-to-Speech AI Chatbot backend...")
    errors = config.validate_config()
    if errors:
        print("\n" + "=" * 55 + "\nWARNING: CONFIGURATION ERRORS — RAG features may fail.")
        for e in errors:
            print(f"  - {e}")
        print("=" * 55 + "\n")
    else:
        print("Configuration validated.")
    yield
    print("Shutting down.")


app = FastAPI(title="Antigravity Speech AI", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Singletons — initialised once at module load.
rag_engine = RAGEngine()
memory_manager = MemoryManager(llm=rag_engine.rewrite_llm)
edge_tts = EdgeTTS()

_TTS_DONE = object()  # Sentinel: tells the TTS worker to exit cleanly.

# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    """Lightweight liveness probe for load balancers and container orchestrators."""
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# PDF management endpoints
# ---------------------------------------------------------------------------

@app.post("/api/pdfs/upload")
async def upload_pdfs(files: List[UploadFile] = File(...)):
    max_bytes = config.MAX_UPLOAD_MB * 1024 * 1024
    ingested, failed = [], []

    for file in files:
        if not (file.filename or "").endswith(".pdf"):
            failed.append({"filename": file.filename, "error": "Only PDF files are supported."})
            continue

        # Enforce upload size limit before writing to disk.
        content = await file.read()
        if len(content) > max_bytes:
            failed.append({
                "filename": file.filename,
                "error": f"File exceeds the {config.MAX_UPLOAD_MB} MB upload limit.",
            })
            continue

        file_path = config.DOCUMENTS_DIR / file.filename
        try:
            file_path.write_bytes(content)
            res = rag_engine.ingest_pdf(str(file_path), file.filename)
            if res.get("status") == "success":
                ingested.append({
                    "filename": file.filename,
                    "chunks": res.get("chunks_count"),
                    "pages": res.get("pages_count"),
                })
            else:
                file_path.unlink(missing_ok=True)
                failed.append({"filename": file.filename, "error": res.get("message")})
        except Exception as e:
            file_path.unlink(missing_ok=True)
            failed.append({"filename": file.filename, "error": str(e)})

    return {"status": "success" if ingested else "error", "ingested": ingested, "failed": failed}


@app.get("/api/pdfs/list")
async def list_pdfs():
    return rag_engine.list_pdfs()


@app.delete("/api/pdfs/delete/{filename}")
async def delete_pdf(filename: str):
    if not rag_engine.delete_pdf(filename):
        raise HTTPException(status_code=404, detail="File not found.")
    return {"status": "success", "message": f"Successfully deleted {filename}"}


@app.post("/api/pdfs/reindex")
async def reindex_pdfs():
    return rag_engine.reindex_all()


# ---------------------------------------------------------------------------
# Session state
# ---------------------------------------------------------------------------

class SessionState:
    """
    Tracks the active pipeline generation. Each pipeline run owns its gen_id
    and only mutates shared state when that ID is still current — preventing
    a finalising old pipeline from corrupting a newly started one.
    """

    def __init__(self):
        self.active_generation_id: Any = None
        self.llm_task: asyncio.Task | None = None
        self.tts_task: asyncio.Task | None = None
        self.is_ai_speaking: bool = False

    def cancel_active(self, reason: str = "new query") -> tuple:
        """Cancel active tasks. Returns (llm_task, tts_task) so the caller can await them."""
        llm, tts = self.llm_task, self.tts_task
        for task, label in ((llm, "LLM"), (tts, "TTS")):
            if task and not task.done():
                task.cancel()
                print(f"[Session] {label} task cancelled ({reason}).")
        self.llm_task = self.tts_task = None
        return llm, tts


# ---------------------------------------------------------------------------
# TTS worker
# ---------------------------------------------------------------------------

async def tts_worker(
    queue: asyncio.Queue,
    websocket: WebSocket,
    state: SessionState,
    gen_id: Any,
    language_code: str,
):
    """
    Synthesises sentences from the queue and streams MP3 audio chunks.
    Exits cleanly on the _TTS_DONE sentinel or via asyncio.CancelledError on interruption.
    """
    print(f"[TTS:{gen_id}] Worker started — lang={language_code}")
    spoken = 0

    def active() -> bool:
        return state.is_ai_speaking and state.active_generation_id == gen_id

    try:
        while True:
            item = await queue.get()
            try:
                if item is _TTS_DONE:
                    print(f"[TTS:{gen_id}] Done — {spoken} sentence(s) spoken.")
                    break
                if not active():
                    print(f"[TTS:{gen_id}] Superseded — dropping sentence.")
                    break

                audio = await edge_tts.synthesize_sentence_async(item, language_code=language_code)

                if not active():
                    print(f"[TTS:{gen_id}] Superseded after synthesis — discarding audio.")
                    break
                if audio:
                    await websocket.send_json({
                        "type": "audio-chunk",
                        "audio": base64.b64encode(audio).decode(),
                        "text": item,
                        "generationId": gen_id,
                    })
                    spoken += 1
                    print(f"[TTS:{gen_id}] Audio sent ({len(audio):,} bytes).")
                else:
                    print(f"[TTS:{gen_id}] Empty audio for: '{item[:50]}'")
            finally:
                queue.task_done()

    except asyncio.CancelledError:
        # Drain the queue so queue.join() in the pipeline doesn't hang.
        while not queue.empty():
            try:
                queue.get_nowait()
                queue.task_done()
            except asyncio.QueueEmpty:
                break
        print(f"[TTS:{gen_id}] Cancelled after {spoken} sentence(s).")
        raise


# ---------------------------------------------------------------------------
# Response pipeline
# ---------------------------------------------------------------------------

async def run_response_pipeline(
    text: str,
    session_id: str,
    websocket: WebSocket,
    state: SessionState,
    gen_id: Any,
):
    """
    Language detection → RAG retrieval → LLM streaming →
    sentence buffering → TTS synthesis → audio streaming.

    All state mutations are guarded by gen_id: a finalising old pipeline
    cannot corrupt a newly started one.
    """
    print(f"[Pipeline:{gen_id}] Starting — '{text[:60]}'")
    state.active_generation_id = gen_id
    state.is_ai_speaking = True

    queue: asyncio.Queue = asyncio.Queue()
    session = memory_manager.get_session(session_id)
    history = session.get_messages()
    session.add_message("user", text)

    full_response = ""
    buf = SentenceBuffer()
    lang_code = "en"
    tts_task: asyncio.Task | None = None
    tts_started = False

    def active() -> bool:
        return state.is_ai_speaking and state.active_generation_id == gen_id

    def start_tts(lc: str) -> None:
        nonlocal tts_task, tts_started
        tts_task = asyncio.create_task(tts_worker(queue, websocket, state, gen_id, lc))
        state.tts_task = tts_task
        tts_started = True
        print(f"[Pipeline:{gen_id}] TTS worker started (lang={lc}).")

    try:
        async for event in rag_engine.stream_query(text, history):
            if not active():
                print(f"[Pipeline:{gen_id}] Superseded mid-stream.")
                break

            if event["type"] == "language":
                lang_code = event.get("language_code", "en")
                lang_name = event.get("language_name", "English")
                print(f"[Pipeline:{gen_id}] Language: {lang_name} ({lang_code})")
                await websocket.send_json({
                    "type": "language-detected",
                    "language_name": lang_name,
                    "language_code": lang_code,
                    "generationId": gen_id,
                })
                if not tts_started:
                    start_tts(lang_code)

            elif event["type"] == "text":
                if not tts_started:
                    start_tts(lang_code)
                chunk = event["content"]
                full_response += chunk
                await websocket.send_json({"type": "llm-chunk", "text": chunk, "generationId": gen_id})
                for sentence in buf.add_text(chunk):
                    print(f"[Pipeline:{gen_id}] Queued: '{sentence[:60]}'")
                    await queue.put(sentence)

        if active():
            for sentence in buf.flush():
                print(f"[Pipeline:{gen_id}] Queued (flush): '{sentence[:60]}'")
                await queue.put(sentence)

        if tts_started and active():
            await queue.put(_TTS_DONE)
            print(f"[Pipeline:{gen_id}] Sentinel queued.")

        if tts_started and tts_task:
            await queue.join()
            print(f"[Pipeline:{gen_id}] TTS queue drained.")

        if active() and full_response.strip():
            session.add_message("assistant", full_response)
            asyncio.create_task(session.summarize_if_needed())
            await websocket.send_json({"type": "response-complete", "generationId": gen_id})
            print(f"[Pipeline:{gen_id}] Complete — {len(full_response)} chars.")

    except asyncio.CancelledError:
        print(f"[Pipeline:{gen_id}] Cancelled.")
        raise
    except Exception as e:
        print(f"[Pipeline:{gen_id}] Error: {e}")
        try:
            await websocket.send_json({"type": "error", "message": f"An error occurred: {str(e)}"})
        except Exception:
            pass
    finally:
        if tts_task and not tts_task.done():
            tts_task.cancel()
            try:
                await tts_task
            except asyncio.CancelledError:
                pass
        if state.active_generation_id == gen_id:
            state.is_ai_speaking = False
            print(f"[Pipeline:{gen_id}] Released is_ai_speaking.")
        else:
            print(f"[Pipeline:{gen_id}] Finalised — gen {state.active_generation_id} now active.")


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------

@app.websocket("/ws/chat/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    await websocket.accept()
    print(f"[WS] Connected: {session_id}")
    state = SessionState()
    await websocket.send_json({"type": "connection-status", "status": "ready"})

    try:
        while True:
            message = await websocket.receive_text()
            try:
                data = json.loads(message)
                msg_type = data.get("type")

                if msg_type == "text-query":
                    text = data.get("text", "").strip()
                    gen_id = data.get("generationId")
                    if not text:
                        continue
                    print(f"[WS:{session_id}] text-query gen={gen_id}: '{text[:60]}'")
                    old_llm, old_tts = state.cancel_active("new query")
                    tasks = [t for t in (old_llm, old_tts) if t]
                    if tasks:
                        await asyncio.gather(*tasks, return_exceptions=True)
                        print(f"[WS:{session_id}] Old tasks terminated.")
                    state.llm_task = asyncio.create_task(
                        run_response_pipeline(text, session_id, websocket, state, gen_id)
                    )

                elif msg_type == "interrupt":
                    print(f"[WS:{session_id}] Barge-in — cancelling gen={state.active_generation_id}.")
                    old_llm, old_tts = state.cancel_active("barge-in")
                    state.active_generation_id = None
                    state.is_ai_speaking = False
                    tasks = [t for t in (old_llm, old_tts) if t]
                    if tasks:
                        await asyncio.gather(*tasks, return_exceptions=True)

                elif msg_type == "clear-memory":
                    memory_manager.clear_session(session_id)
                    await websocket.send_json({
                        "type": "memory-cleared",
                        "message": "Conversation history reset.",
                    })

            except Exception as e:
                print(f"[WS:{session_id}] Message handling error: {e}")

    except WebSocketDisconnect:
        print(f"[WS] Disconnected: {session_id}")
    except Exception as e:
        print(f"[WS] Loop error {session_id}: {e}")
    finally:
        state.cancel_active("session end")
        print(f"[WS] Session cleaned up: {session_id}")
