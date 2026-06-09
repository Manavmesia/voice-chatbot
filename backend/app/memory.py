import time
from typing import Dict, List

from langchain_core.messages import HumanMessage


class SessionMemory:
    def __init__(self, session_id: str, llm=None):
        self.session_id = session_id
        self.messages: List[Dict[str, str]] = []
        self.summary: str = ""
        self.llm = llm

    def add_message(self, role: str, content: str) -> None:
        self.messages.append({"role": role, "content": content, "timestamp": str(time.time())})

    def get_messages(self) -> List[Dict[str, str]]:
        return [{"role": m["role"], "content": m["content"]} for m in self.messages]

    async def summarize_if_needed(self, threshold: int = 14, keep_latest: int = 6) -> None:
        """Summarises old messages when history exceeds `threshold`, keeping the latest `keep_latest`."""
        if len(self.messages) <= threshold:
            return

        to_summarize = self.messages[:-keep_latest]
        latest = self.messages[-keep_latest:]

        if not self.llm:
            self.messages = latest
            return

        conv_str = "".join(
            f"{'User' if m['role'] == 'user' else 'Assistant'}: {m['content']}\n"
            for m in to_summarize
        )
        prompt = (
            "Summarize the key information and questions from the following conversation history. "
            "Keep the summary concise but capture context for future follow-up questions.\n\n"
            f"Existing Summary (if any): {self.summary}\n\n"
            f"New conversation to add:\n{conv_str}\nUpdated Summary:"
        )
        try:
            response = await self.llm.ainvoke([HumanMessage(content=prompt)])
            self.summary = response.content.strip()
            self.messages = latest
        except Exception as e:
            print(f"[Memory] Summarization error: {e}")
            self.messages = latest


class MemoryManager:
    def __init__(self, llm=None):
        self.sessions: Dict[str, SessionMemory] = {}
        self.llm = llm

    def get_session(self, session_id: str) -> SessionMemory:
        if session_id not in self.sessions:
            self.sessions[session_id] = SessionMemory(session_id, self.llm)
        return self.sessions[session_id]

    def clear_session(self, session_id: str) -> None:
        self.sessions.pop(session_id, None)
