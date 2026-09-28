"""音声サーバー: 英語ネイティブの読み上げ（Kokoro）と、日本人の英語に強い音声認識（Whisper）

POST /tts  {"text": "...", "voice": "af_heart", "speed": 1.0}
  -> {"audio": <base64 wav>, "timeline": [[開始秒, 終了秒, 母音(a/i/u/e/o)], ...], "total": 秒}
POST /stt?lang=en&prompt=...   本文 = 録音データ（webm / mp4 / wav など。ffmpeg で読み込む）
  -> {"text": "..."}
GET  /health -> {"ok": true, "tts": true, "stt": true}

Node サーバー（server.js）から自動で起動されます。単体で動かす場合:
  python3 tts/speech_server.py --port 50032
"""

import argparse
import base64
import io
import json
import os
import re
import tempfile
import threading
import urllib.parse
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

warnings.filterwarnings("ignore")

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from kokoro import KPipeline  # noqa: E402

SR = 24000
VOICES = {"af_heart", "af_bella", "af_nicole", "af_sky", "af_sarah", "am_michael", "am_echo", "am_puck", "am_fenrir"}

# 発音記号（misaki）の母音 → 口の形。二重母音は最初の音で代表させる
VOWEL_SHAPE = {
    "ɑ": "a", "æ": "a", "ʌ": "a", "ɐ": "a", "a": "a", "I": "a", "W": "a",
    "i": "i", "ɪ": "i", "ᵻ": "i",
    "u": "u", "ʊ": "u",
    "ɛ": "e", "e": "e", "A": "e", "ə": "e", "ɚ": "e", "ɜ": "e",
    "ɔ": "o", "o": "o", "O": "o", "Y": "o",
}

pipeline = None
lock = threading.Lock()

# 音声認識（Whisper）。Apple シリコンなら mlx-whisper（速い）、なければ openai-whisper
WHISPER_MLX = "mlx-community/whisper-large-v3-turbo"
stt_lock = threading.Lock()
stt_impl = None

# 日本人学習者の英語を「文法ミスも含めてそのまま」書き取らせるためのヒント。
# 例文は学習者が実際に言いそうにない内容にする（言いそうな文だと、似た発話がその例文に書き換えられてしまう）。
# 測定: 日本人風のカタカナ発音 30 件で、ヒントなし 誤り 5.2% → このヒント 1.7%
VERBATIM_PROMPT = (
    "The speaker is a Japanese learner of English. Transcribe exactly what they say, keeping grammar mistakes. "
    "For example: Uh, last Sunday I buy new umbrella. My grandmother don't use smartphone."
)

def load_stt():
    global stt_impl
    try:
        import mlx_whisper

        def run(path, lang, prompt):
            return mlx_whisper.transcribe(path, path_or_hf_repo=WHISPER_MLX, language=lang, temperature=0.0,
                                          initial_prompt=prompt, condition_on_previous_text=False)
        stt_impl = run
    except ImportError:
        try:
            import whisper
            model = whisper.load_model("large-v3-turbo")

            def run(path, lang, prompt):
                return model.transcribe(path, language=lang, temperature=0.0, fp16=False,
                                        initial_prompt=prompt, condition_on_previous_text=False)
            stt_impl = run
        except ImportError:
            stt_impl = None


def transcribe(data, lang, context):
    lang = "ja" if lang.startswith("ja") else "en"
    prompt = None
    if lang == "en":
        prompt = VERBATIM_PROMPT + (f" Question: {context[:300]}" if context else "")
    with tempfile.NamedTemporaryFile(suffix=".audio", delete=False) as f:
        f.write(data)
        path = f.name
    try:
        with stt_lock:
            result = stt_impl(path, lang, prompt)
    finally:
        os.unlink(path)
    return clean_transcript(result)


def clean_transcript(result):
    """Whisper の「幻聴」（無音や雑音で出るでたらめな文）を取り除く"""
    parts = []
    for seg in result.get("segments") or [{"text": result.get("text", "")}]:
        # 同じ文の繰り返し（圧縮率が高い）や、無音らしくて自信もない区間は捨てる（Whisper 標準の判定基準）
        if seg.get("compression_ratio", 0) > 2.4:
            continue
        if seg.get("no_speech_prob", 0) > 0.6 and seg.get("avg_logprob", 0) < -1.0:
            continue
        parts.append(seg.get("text", ""))
    text = " ".join(p.strip() for p in parts if p.strip())
    # ヒントの指示文がそのまま出てきた場合は、その文だけ取り除く
    sentences = [x for x in re.split(r"(?<=[.!?])\s+", text) if x and not x.lower().startswith("the speaker is a japanese learner")]
    return " ".join(sentences).strip()


def word_timeline(tokens, offset):
    """単語ごとの開始・終了時刻と発音記号から、母音ごとの区間を作る"""
    timeline = []
    for tk in tokens:
        if tk.start_ts is None or tk.end_ts is None or not tk.phonemes:
            continue
        vowels = [VOWEL_SHAPE[p] for p in tk.phonemes if p in VOWEL_SHAPE]
        if not vowels:
            continue
        start, end = offset + tk.start_ts, offset + tk.end_ts
        step = (end - start) / len(vowels)
        for i, v in enumerate(vowels):
            # 各母音区間の前 25% は子音として口を閉じ気味にする
            s = start + step * i
            timeline.append([round(s + step * 0.25, 3), round(s + step, 3), v])
    return timeline


def synthesize(text, voice, speed):
    chunks, timeline, offset = [], [], 0.0
    with lock:  # モデルは1つなので同時に1リクエストずつ
        for r in pipeline(text, voice=voice, speed=speed):
            audio = r.audio.numpy()
            timeline += word_timeline(r.tokens, offset)
            chunks.append(audio)
            offset += len(audio) / SR
    audio = np.concatenate(chunks) if chunks else np.zeros(SR // 10, dtype=np.float32)
    buf = io.BytesIO()
    sf.write(buf, audio, SR, format="WAV", subtype="PCM_16")
    return {"audio": base64.b64encode(buf.getvalue()).decode(), "timeline": timeline, "total": round(len(audio) / SR, 3)}


class Handler(BaseHTTPRequestHandler):
    def _json(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": pipeline is not None, "tts": pipeline is not None, "stt": stt_impl is not None})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/stt":
            if stt_impl is None:
                return self._json(501, {"error": "音声認識（Whisper）が入っていません"})
            try:
                q = urllib.parse.parse_qs(url.query)
                data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                if not data:
                    return self._json(400, {"error": "audio is required"})
                text = transcribe(data, q.get("lang", ["en"])[0], q.get("context", [""])[0])
                return self._json(200, {"text": text})
            except Exception as e:  # noqa: BLE001
                return self._json(500, {"error": str(e)})
        if url.path != "/tts":
            return self._json(404, {"error": "not found"})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            text = str(req.get("text", "")).strip()[:1000]
            voice = req.get("voice") if req.get("voice") in VOICES else "af_heart"
            speed = min(max(float(req.get("speed") or 1), 0.5), 2.0)
            if not text:
                return self._json(400, {"error": "text is required"})
            self._json(200, synthesize(text, voice, speed))
        except Exception as e:  # noqa: BLE001
            self._json(500, {"error": str(e)})

    def log_message(self, *args):
        pass


def main():
    global pipeline
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=50032)
    args = ap.parse_args()
    pipeline = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
    warm = synthesize("Hi!", "af_heart", 1.0)  # 初回の読み込みを済ませておく
    load_stt()
    if stt_impl:
        transcribe(base64.b64decode(warm["audio"]), "en", "")  # Whisper も読み込んでおく
    print(f"Speech server ready on http://127.0.0.1:{args.port} (tts: yes, stt: {'yes' if stt_impl else 'no'})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
