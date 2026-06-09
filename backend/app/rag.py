import os
from pathlib import Path
from typing import Any, AsyncGenerator, Dict, List, Tuple

import fitz  # PyMuPDF
from app import config
from langchain_community.embeddings import HuggingFaceEmbeddings
from langchain_community.vectorstores import Chroma
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_groq import ChatGroq
from langchain_text_splitters import RecursiveCharacterTextSplitter

# ISO 639-1 codes accepted from language detection; anything else falls back to English.
VALID_LANG_CODES = {
    "en", "hi", "gu", "mr", "ta", "te", "kn", "ml", "bn", "pa",
    "fr", "de", "es", "it", "pt", "ar", "zh", "ja", "ko", "ru",
    "nl", "tr", "pl", "sv", "da", "fi", "no", "cs", "sk", "ro",
    "hu", "uk", "vi", "th", "id", "ms",
}


class RAGEngine:
    def __init__(self):
        self.embeddings = HuggingFaceEmbeddings(model_name="all-MiniLM-L6-v2")
        self.db = Chroma(
            persist_directory=str(config.CHROMA_DIR),
            embedding_function=self.embeddings,
            collection_name="pdf_chatbot_collection",
        )
        self.chat_llm = ChatGroq(
            groq_api_key=config.GROQ_API_KEY,
            model_name=config.GROQ_MODEL,
            temperature=0.0,
            streaming=True,
        )
        self.rewrite_llm = ChatGroq(
            groq_api_key=config.GROQ_API_KEY,
            model_name=config.GROQ_MODEL,
            temperature=0.0,
            streaming=False,
        )
        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=800, chunk_overlap=150, length_function=len
        )

    # ------------------------------------------------------------------
    # PDF management
    # ------------------------------------------------------------------

    def ingest_pdf(self, file_path: str, filename: str) -> Dict[str, Any]:
        """Extract text from a PDF, chunk it, and store in ChromaDB."""
        try:
            doc = fitz.open(file_path)
            documents = []
            for page_idx in range(len(doc)):
                text = doc[page_idx].get_text()
                if not text.strip():
                    continue
                for chunk_idx, chunk in enumerate(self.text_splitter.split_text(text)):
                    documents.append((chunk, {"source": filename, "page": page_idx + 1, "chunk": chunk_idx}))

            if not documents:
                return {"status": "error", "message": "No text extracted from PDF."}

            self.db.add_texts(
                texts=[d[0] for d in documents],
                metadatas=[d[1] for d in documents],
                ids=[f"{filename}_p{m['page']}_c{m['chunk']}" for _, m in documents],
            )
            return {"status": "success", "chunks_count": len(documents), "pages_count": len(doc)}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def list_pdfs(self) -> List[Dict[str, Any]]:
        """List all uploaded PDFs with size and index status."""
        pdfs = []
        if not os.path.exists(config.DOCUMENTS_DIR):
            return pdfs
        for filename in os.listdir(config.DOCUMENTS_DIR):
            if not filename.endswith(".pdf"):
                continue
            path = os.path.join(config.DOCUMENTS_DIR, filename)
            chunks_count = 0
            try:
                res = self.db._collection.get(where={"source": filename})
                chunks_count = len(res["ids"]) if res and "ids" in res else 0
            except Exception:
                pass
            pdfs.append({
                "filename": filename,
                "size_bytes": os.path.getsize(path),
                "chunks_count": chunks_count,
                "status": "indexed" if chunks_count > 0 else "not_indexed",
            })
        return pdfs

    def delete_pdf(self, filename: str) -> bool:
        """Delete a PDF from disk and remove its vectors from ChromaDB."""
        file_path = Path(config.DOCUMENTS_DIR) / filename
        deleted = False
        if file_path.exists():
            try:
                os.remove(file_path)
                deleted = True
            except Exception as e:
                print(f"[RAG] File remove error {filename}: {e}")
        try:
            res = self.db._collection.get(where={"source": filename})
            if res and res.get("ids"):
                self.db._collection.delete(ids=res["ids"])
                return True
        except Exception as e:
            print(f"[RAG] Vector delete error {filename}: {e}")
        return deleted

    def reindex_all(self) -> Dict[str, Any]:
        """Clear ChromaDB and re-index every PDF in the documents directory."""
        try:
            self.db.delete_collection()
            self.db = Chroma(
                persist_directory=str(config.CHROMA_DIR),
                embedding_function=self.embeddings,
                collection_name="pdf_chatbot_collection",
            )
        except Exception as e:
            print(f"[RAG] Reset error: {e}")

        ingested, errors = [], []
        for filename in os.listdir(config.DOCUMENTS_DIR):
            if not filename.endswith(".pdf"):
                continue
            res = self.ingest_pdf(os.path.join(config.DOCUMENTS_DIR, filename), filename)
            if res.get("status") == "success":
                ingested.append(filename)
            else:
                errors.append(f"{filename}: {res.get('message')}")

        return {"status": "success" if not errors else "partial_success", "ingested": ingested, "errors": errors}

    # ------------------------------------------------------------------
    # Language detection
    # ------------------------------------------------------------------

    async def detect_language(self, question: str) -> Tuple[str, str]:
        """
        Detect the language of `question`.
        Returns (language_name, iso_code), e.g. ("Hindi", "hi").
        Falls back to ("English", "en") on failure or unrecognised output.
        """
        system = (
            "You are a language identification system. "
            "Reply with EXACTLY this format and nothing else: LanguageName|xx "
            "where xx is the ISO 639-1 two-letter code."
        )
        examples = (
            "Examples:\n"
            "Input: What is a list? -> English|en\n"
            "Input: Python mein list kya hai? -> Hindi|hi\n"
            "Input: Python ma list shu che? -> Gujarati|gu\n"
            "Input: Was ist eine Liste? -> German|de\n"
        )
        try:
            response = await self.rewrite_llm.ainvoke([
                SystemMessage(content=system),
                HumanMessage(content=f"{examples}\nInput: {question}"),
            ])
            raw = response.content.strip().strip("`\"' \n").splitlines()[0]
            if "|" in raw:
                name, code = raw.split("|", 1)
                code = code.strip().lower()[:2]
                if code in VALID_LANG_CODES and name.strip():
                    print(f"[LangDetect] '{question[:60]}' -> {name.strip()} ({code})")
                    return name.strip(), code
            print(f"[LangDetect] Unexpected response '{raw}' — falling back to English.")
        except Exception as e:
            print(f"[LangDetect] Error: {e} — falling back to English.")
        return "English", "en"

    # ------------------------------------------------------------------
    # Query rewriting for retrieval
    # ------------------------------------------------------------------

    async def rewrite_query_for_retrieval(self, question: str, history: List[Dict[str, str]]) -> str:
        """
        Produce a standalone English query for vector search.
        Resolves conversation coreferences and translates to English if needed.
        """
        if not history:
            prompt = (
                "Translate and rephrase the following question into clear, natural English. "
                "If already in English, return as-is. Return ONLY the English question.\n\n"
                f"Question: {question}"
            )
        else:
            history_text = "\n".join(
                f"{'User' if m['role'] == 'user' else 'Assistant'}: {m['content']}"
                for m in history[-6:]
            )
            prompt = (
                "Given a conversation history and a follow-up question:\n"
                "1. Resolve references to earlier turns (e.g. 'it', 'that').\n"
                "2. Translate to clear English if not already.\n"
                "Return ONLY the final standalone English question.\n\n"
                f"History:\n{history_text}\n\nFollow-up: {question}"
            )
        try:
            response = await self.rewrite_llm.ainvoke([SystemMessage(content=prompt)])
            rewritten = response.content.strip()
            print(f"[QueryRewrite] '{question[:60]}' -> '{rewritten[:80]}'")
            return rewritten
        except Exception as e:
            print(f"[QueryRewrite] Error: {e} — using original question.")
            return question

    # ------------------------------------------------------------------
    # Main streaming pipeline
    # ------------------------------------------------------------------

    async def stream_query(
        self, question: str, history: List[Dict[str, str]]
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Full RAG pipeline. Yields:
          {"type": "language", "language_name": str, "language_code": str}
          {"type": "text", "content": str}

        Language is detected from the current query only (history excluded from
        detection to prevent language bleed). The system prompt anchors the
        response language at both the top and bottom. Only user turns from
        history are forwarded to the LLM to prevent wrong-language assistant
        turns from biasing the output.
        """
        lang_name, lang_code = await self.detect_language(question)
        yield {"type": "language", "language_name": lang_name, "language_code": lang_code}

        english_query = await self.rewrite_query_for_retrieval(question, history)

        docs = []
        try:
            docs = self.db.similarity_search(english_query, k=4)
        except Exception as e:
            print(f"[RAG] Similarity search error: {e}")

        context_str = "".join(
            f"--- Source: {d.metadata.get('source', 'Unknown')}, Page {d.metadata.get('page', '?')} ---\n{d.page_content}\n\n"
            for d in docs
        )

        lang_rule = (
            f"LANGUAGE RULE — NON-NEGOTIABLE:\n"
            f"The user is communicating in {lang_name}. "
            f"You MUST write your entire response in {lang_name} ({lang_code}). "
            f"Do NOT use any other language or mix languages."
        )
        system_prompt = (
            f"{lang_rule}\n\n"
            "ROLE: You are a knowledgeable AI assistant. Answer based ONLY on the document context below.\n\n"
            "CONTENT RULES:\n"
            "1. Use ONLY facts explicitly stated in the context.\n"
            f"2. If the context is insufficient, say so in {lang_name}.\n"
            "3. Do NOT hallucinate or use outside knowledge.\n"
            "4. Do NOT cite page numbers, filenames, or source names.\n\n"
            "FORMATTING RULES:\n"
            "5. For technical topics: definition → example → code block (if applicable) → bullet points.\n"
            "6. Use **bold** for key terms, `backticks` for code/keywords.\n"
            "7. Be concise.\n\n"
            f"Document Context:\n{context_str}\n"
            f"--- REMINDER: Respond in {lang_name} only. ---"
        )

        messages: List[Any] = [SystemMessage(content=system_prompt)]
        for msg in history[-8:]:
            if msg["role"] == "user":
                messages.append(HumanMessage(content=msg["content"]))
        messages.append(HumanMessage(content=f"[Respond in {lang_name} ({lang_code}) only]\n{question}"))

        try:
            async for chunk in self.chat_llm.astream(messages):
                if chunk.content:
                    yield {"type": "text", "content": chunk.content}
        except Exception as e:
            print(f"[RAG] LLM streaming error: {e}")
            yield {"type": "text", "content": f"\nError generating response: {str(e)}"}
