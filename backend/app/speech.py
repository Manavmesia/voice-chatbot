import re
from typing import List

import edge_tts
from app import config

# ISO 639-1 code → Edge TTS neural voice. Falls back to config.TTS_VOICE for unlisted codes.
LANGUAGE_VOICE_MAP: dict[str, str] = {
    "en": "en-US-EmmaMultilingualNeural",
    "hi": "hi-IN-SwaraNeural",
    "gu": "gu-IN-DhwaniNeural",
    "mr": "mr-IN-AarohiNeural",
    "ta": "ta-IN-PallaviNeural",
    "te": "te-IN-ShrutiNeural",
    "kn": "kn-IN-SapnaNeural",
    "ml": "ml-IN-SobhanaNeural",
    "bn": "bn-IN-TanishaaNeural",
    "pa": "pa-IN-OjasveeNeural",
    "fr": "fr-FR-DeniseNeural",
    "de": "de-DE-KatjaNeural",
    "es": "es-ES-ElviraNeural",
    "it": "it-IT-ElsaNeural",
    "pt": "pt-BR-FranciscaNeural",
    "ar": "ar-SA-ZariyahNeural",
    "zh": "zh-CN-XiaoxiaoNeural",
    "ja": "ja-JP-NanamiNeural",
    "ko": "ko-KR-SunHiNeural",
    "ru": "ru-RU-SvetlanaNeural",
}

# Minimum cleaned length to bother sending to TTS (avoids API calls for stray punctuation).
_MIN_TTS_LEN = 4

# Strips markdown symbols that should not be spoken aloud.
_MD_STRIP = re.compile(
    r'\*{1,3}|`{1,3}|#{1,6}\s?|^\s*[-•*]\s|^\s*\d+\.\s|\[[^\]]*\]',
    re.MULTILINE,
)


class EdgeTTS:
    def __init__(self, voice_name: str = None, rate: str = None):
        self.default_voice = voice_name or config.TTS_VOICE
        self.rate = rate or config.TTS_RATE

    def _voice(self, language_code: str) -> str:
        return LANGUAGE_VOICE_MAP.get((language_code or "en").lower()[:2], self.default_voice)

    async def synthesize_sentence_async(self, sentence: str, language_code: str = "en") -> bytes:
        """Synthesize `sentence` to MP3 bytes. Returns b'' for unspeakable input or errors."""
        clean = re.sub(r'\s+', ' ', _MD_STRIP.sub("", sentence)).strip()
        if not clean or clean.startswith("```") or len(clean) < _MIN_TTS_LEN:
            return b""
        voice = self._voice(language_code)
        try:
            communicate = edge_tts.Communicate(clean, voice, rate=self.rate)
            audio = b""
            async for chunk in communicate.stream():
                if chunk.get("type") == "audio":
                    audio += chunk["data"]
            if not audio:
                print(f"[TTS] Empty audio for: '{clean[:60]}'")
            return audio
        except Exception as e:
            print(f"[TTS] Synthesis error (voice={voice}): {e}")
            return b""


class SentenceBuffer:
    """
    Accumulates streaming LLM text and emits complete, speakable sentences.

    Boundaries: . ? !  (newlines are intentionally excluded — they appear
    constantly in markdown and produce tiny unspeakable fragments).
    Code fences (``` ... ```) are silently discarded.
    Segments shorter than MIN_WORDS are also discarded.
    """

    ENDINGS = {".", "?", "!"}
    ABBREVS = ("mr", "dr", "ms", "vs", "eg", "ie", "st", "jr")
    MIN_WORDS = 3

    def __init__(self):
        self.buffer = ""
        self._in_code = False

    def add_text(self, text: str) -> List[str]:
        self.buffer += text
        return self._extract()

    def flush(self) -> List[str]:
        if self._in_code:
            self.buffer = ""
            self._in_code = False
            return []
        remainder = self._clean(self.buffer)
        self.buffer = ""
        return [remainder] if remainder and len(remainder.split()) >= self.MIN_WORDS else []

    def _extract(self) -> List[str]:
        sentences: List[str] = []
        while True:
            fence = self.buffer.find("```")
            if fence != -1:
                if not self._in_code:
                    # Recurse on text before the fence, then enter code block.
                    saved, self.buffer = self.buffer, self.buffer[:fence]
                    sentences.extend(self._extract())
                    self.buffer = saved[fence + 3:]
                    self._in_code = True
                else:
                    self.buffer = self.buffer[fence + 3:]
                    self._in_code = False
                continue
            if self._in_code:
                break
            end = self._end_idx(self.buffer)
            if end == -1:
                break
            raw, self.buffer = self.buffer[: end + 1], self.buffer[end + 1:]
            clean = self._clean(raw)
            if clean and len(clean.split()) >= self.MIN_WORDS:
                sentences.append(clean)
        return sentences

    def _end_idx(self, text: str) -> int:
        for i, ch in enumerate(text):
            if ch not in self.ENDINGS:
                continue
            if ch == ".":
                if 0 < i < len(text) - 1 and text[i - 1].isdigit() and text[i + 1].isdigit():
                    continue  # decimal
                if text[i: i + 3] == "...":
                    continue  # ellipsis
                if any(text[max(0, i - 4): i].lower().endswith(a) for a in self.ABBREVS):
                    continue  # abbreviation
            return i
        return -1

    @staticmethod
    def _clean(text: str) -> str:
        clean = _MD_STRIP.sub("", text)
        return re.sub(r'\s+', ' ', clean).strip()
