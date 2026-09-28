import { mouthAt, envelope } from "./lipsync.js";

// 音声まわり: 音声認識（Web Speech API）/ 読み上げ（VOICEVOX・ブラウザ音声）/ 口パク連動

// ---------------------------------------------------------------- 音声認識

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const recognitionSupported = !!SR;

export class Listener {
  constructor({ onInterim, onFinal, onStateChange, onError }) {
    this.onInterim = onInterim;
    this.onFinal = onFinal;
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.active = false;
    this.silenceMs = 2000;
  }

  start(lang = "en-US") {
    if (!SR || this.active) return;
    const rec = new SR();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    this.rec = rec;
    this.finalText = "";
    this.interimText = "";
    this.active = true;
    this._cancelled = false;

    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.finalText += (this.finalText ? " " : "") + r[0].transcript.trim();
        else interim += r[0].transcript;
      }
      this.interimText = interim;
      this.onInterim?.((this.finalText + " " + interim).trim());
      // 一定時間しゃべらなければ自動で送信
      clearTimeout(this._silence);
      this._silence = setTimeout(() => this.stop(), this.silenceMs);
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      this.onError?.(e.error);
    };
    rec.onend = () => {
      clearTimeout(this._silence);
      const wasActive = this.active;
      this.active = false;
      this.onStateChange?.(false);
      const text = (this.finalText + " " + (this.interimText || "")).trim();
      if (wasActive && !this._cancelled) this.onFinal?.(text);
    };
    rec.start();
    // 何も話さない場合も一定時間で終了
    this._silence = setTimeout(() => this.stop(), 8000);
    this.onStateChange?.(true);
  }

  stop() {
    clearTimeout(this._silence);
    if (this.rec && this.active) this.rec.stop();
  }

  cancel() {
    this._cancelled = true;
    this.stop();
  }
}

// ---------------------------------------------------------------- 音声認識（Whisper）
// 録音して PC の Whisper で文字起こしする。日本人の英語（カタカナ発音）にも強く、
// 文法ミスもそのまま書き取る。Listener と同じ使い方ができる。

export const recordingSupported = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

let sharedCtx = null;
function audioCtx() {
  if (!sharedCtx) sharedCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (sharedCtx.state === "suspended") sharedCtx.resume();
  return sharedCtx;
}

export class Recorder {
  constructor({ onInterim, onFinal, onStateChange, onError, onTranscribing }) {
    Object.assign(this, { onInterim, onFinal, onStateChange, onError, onTranscribing });
    this.active = false;
    this.silenceMs = 2000;
    this.context = ""; // 直前の AI の質問（認識のヒント）
    this.stream = null;
  }

  async start(lang = "en-US") {
    if (this.active) return;
    this.active = true;
    this._cancelled = false;
    this.lang = lang.startsWith("ja") ? "ja" : "en";
    this.onStateChange?.(true);
    try {
      if (!this.stream || this.stream.getTracks().some((t) => t.readyState === "ended")) {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      }
    } catch (e) {
      this.active = false;
      this.onStateChange?.(false);
      this.onError?.(e.name === "NotAllowedError" ? "not-allowed" : "audio-capture");
      return;
    }
    if (!this.active) return; // 待っている間に止められた
    const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((m) => MediaRecorder.isTypeSupported?.(m)) || "";
    const rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => this._finish(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
    this.rec = rec;
    rec.start(250);
    this._watch();
  }

  // 声の大きさを見て、話し終わり（一定時間の無音）を検出する
  _watch() {
    const ac = audioCtx();
    const src = ac.createMediaStreamSource(this.stream);
    const an = ac.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    const t0 = performance.now();
    let noise = 0.01, spoke = false, lastVoice = t0, samples = 0;
    this._timer = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      // 最初の 0.3 秒で周りの雑音レベルを測る
      if (now - t0 < 300) {
        noise = (noise * samples + rms) / ++samples;
        return;
      }
      const threshold = Math.max(0.015, noise * 3);
      if (rms > threshold) {
        spoke = true;
        lastVoice = now;
      }
      const level = Math.min(5, Math.round((rms / threshold) * 2));
      this.onInterim?.(`🎤 ${"▮".repeat(level)}${"▯".repeat(5 - level)}  ${spoke ? "話し終わったら少し待ってね" : "どうぞ話してください"}`);
      if (spoke && now - lastVoice > this.silenceMs) this.stop();
      else if (!spoke && now - t0 > 8000) this.stop(); // 何も話さなかった（→ 聞き取れず）
      else if (now - t0 > 30000) this.stop(); // 最長 30 秒
    }, 50);
    this._disconnect = () => src.disconnect();
    this._spoke = () => spoke;
  }

  stop() {
    if (!this.active) return;
    clearInterval(this._timer);
    this._disconnect?.();
    if (this.rec?.state === "recording") this.rec.stop();
    else this._finish(null);
  }

  cancel() {
    this._cancelled = true;
    this.stop();
  }

  async _finish(blob) {
    const wasActive = this.active;
    this.active = false;
    this.onStateChange?.(false);
    if (!wasActive) return;
    if (this._cancelled) return; // 利用者・画面側からの中止
    if (!blob || blob.size < 1000 || !this._spoke?.()) return this.onFinal?.("");
    this.onTranscribing?.(true);
    try {
      const q = new URLSearchParams({ lang: this.lang, context: this.context || "" });
      const res = await fetch(`/api/stt?${q}`, { method: "POST", body: blob });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      this.onFinal?.(data.text || "");
    } catch (e) {
      this.onError?.(e.message || "stt-failed");
      this.onFinal?.("");
    } finally {
      this.onTranscribing?.(false);
    }
  }
}

// ---------------------------------------------------------------- 読み上げ

// 再生は <audio> 要素を1つ使い回す。
// iOS はタップ操作の中で一度再生した要素でないと、後から（AIの応答後に）再生できないため。
const voiceAudio = new Audio();
voiceAudio.preload = "auto";
voiceAudio.setAttribute("playsinline", "");

// 0.05秒の無音 WAV（アンロック用）
function silentWav() {
  const n = 1200, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 24000, true); v.setUint32(28, 48000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

// ユーザー操作時に呼んで音声出力を有効化（スマホの自動再生制限対策）
let primed = false;
export function unlockAudio() {
  if (primed) return;
  primed = true;
  try {
    audioCtx();
    voiceAudio.src = silentWav();
    voiceAudio.play().catch(() => {});
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    speechSynthesis.speak(u);
  } catch {}
}

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

export function englishVoices() {
  return speechSynthesis.getVoices().filter((v) => /^en[-_]/i.test(v.lang));
}

const FEMALE_HINTS = /samantha|victoria|karen|moira|tessa|fiona|allison|ava|susan|zira|aria|jenny|female|woman|google us english|serena|kate|libby|sonia|natasha|michelle|emma|olivia/i;
const MALE_HINTS = /alex|daniel|fred|tom|aaron|oliver|arthur|rishi|david|mark|guy|ryan|male|man|google uk english male|thomas|james|eric|christopher|brian|andrew/i;

export function pickVoice(gender, preferredName) {
  const voices = englishVoices();
  if (preferredName) {
    const v = voices.find((v) => v.name === preferredName);
    if (v) return v;
  }
  const hint = gender === "male" ? MALE_HINTS : FEMALE_HINTS;
  const other = gender === "male" ? FEMALE_HINTS : MALE_HINTS;
  const us = voices.filter((v) => /en[-_]US/i.test(v.lang));
  return (
    us.find((v) => hint.test(v.name) && !(gender === "female" && MALE_HINTS.test(v.name) && !FEMALE_HINTS.test(v.name))) ||
    voices.find((v) => hint.test(v.name)) ||
    us.find((v) => !other.test(v.name)) ||
    voices[0] ||
    null
  );
}

let activeSpeaker = null;

export class Speaker {
  constructor(character) {
    activeSpeaker = this;
    this.character = character; // CharacterView
    this.speaking = false;
    this._stopFns = [];
  }

  stop() {
    this._gen = (this._gen || 0) + 1;
    this._stopFns.forEach((f) => f());
    this._stopFns = [];
    speechSynthesis.cancel();
    this.speaking = false;
    this.character?.setMouth(0);
  }

  // VOICEVOX（ずんだもん）/ Kokoro（リリー）で再生。母音のタイミングに合わせて口の形を変える
  // 全文を一度に合成すると待ち時間が長いので、1文ずつ合成し、再生中に次の文を用意する
  async speakTts(text, { engine = "voicevox", speaker = 3, voice = "af_heart", speed = 1 } = {}) {
    this.stop();
    const gen = this._gen;
    const pattern = engine === "kokoro" ? /[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g : /[^。！？!?]+[。！？!?]*/g;
    const chunks = (text.match(pattern) || [text]).map((c) => c.trim()).filter(Boolean);
    const fetchChunk = async (chunk) => {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engine, text: chunk, speaker, voice, speed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "TTS failed");
      return data;
    };
    let pending = fetchChunk(chunks[0]);
    for (let i = 0; i < chunks.length; i++) {
      const data = await pending;
      if (gen !== this._gen) return; // 途中で止められた
      pending = i + 1 < chunks.length ? fetchChunk(chunks[i + 1]) : null;
      pending?.catch(() => {}); // 未処理の reject 警告を防ぐ（エラーは await 時に拾う）
      await this.playWithTimeline(base64ToBlob(data.audio, "audio/wav"), data.timeline, data.total, data.precise !== false);
      if (gen !== this._gen) return;
      this.speaking = true; // 文と文の間も「話し中」
    }
    this.speaking = false;
  }

  playWithTimeline(blob, timeline, total, precise = true) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const audio = voiceAudio;
      let raf, safety, finished = false;
      let idx = 0;
      // タイミングが単語単位で粗い音声（Kokoro）は、波形の音量で開き具合を補う
      let env = null;
      if (!precise) blob.arrayBuffer().then((b) => (env = envelope(new Uint8Array(b))));
      const tick = () => {
        const m = mouthAt(timeline, audio.currentTime, idx, env);
        idx = m.index;
        this.character?.setMouth(m.open, m.width);
        raf = requestAnimationFrame(tick);
      };
      const finish = (err) => {
        if (finished) return;
        finished = true;
        cancelAnimationFrame(raf);
        clearTimeout(safety);
        audio.onended = audio.onerror = null;
        URL.revokeObjectURL(url);
        this.character?.setMouth(0);
        this.speaking = false;
        err ? reject(err) : resolve();
      };
      this._stopFns.push(() => {
        audio.pause();
        finish();
      });
      audio.onended = () => finish();
      audio.onerror = () => finish(new Error("音声を再生できませんでした"));
      audio.src = url;
      audio.playbackRate = 1;
      this.speaking = true;
      // 万一 ended が来なくても止まったままにしない
      safety = setTimeout(() => { audio.pause(); finish(); }, (total + 3) * 1000);
      audio
        .play()
        .then(() => tick())
        .catch(() => finish(new Error("音声の自動再生がブロックされました。画面をタップしてから「もう一度」を押してください。")));
    });
  }

  // ブラウザの英語音声で再生（単語境界イベント＋揺らぎで口パク）
  speakBrowser(text, { voice = null, rate = 1 } = {}) {
    this.stop();
    // Chrome は長文が途中で止まることがあるので文単位で分割
    const parts = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
    return new Promise((resolve) => {
      let idx = 0;
      let raf;
      let cancelled = false;
      let t0 = performance.now();
      let bump = 0;
      const loop = () => {
        const t = (performance.now() - t0) / 1000;
        bump *= 0.9;
        const v = 0.35 + 0.35 * Math.abs(Math.sin(t * 13)) * (0.6 + 0.4 * Math.sin(t * 5.3)) + bump;
        this.character?.setMouth(this._pausing ? 0 : v, Math.sin(t * 7) > 0.6 ? 1.5 : 1);
        raf = requestAnimationFrame(loop);
      };
      const done = () => {
        cancelAnimationFrame(raf);
        this.character?.setMouth(0);
        this.speaking = false;
        resolve();
      };
      this._stopFns.push(() => {
        cancelled = true;
        done();
      });
      const next = () => {
        if (cancelled) return;
        if (idx >= parts.length) return done();
        const u = new SpeechSynthesisUtterance(parts[idx++].trim());
        if (voice) u.voice = voice;
        u.lang = voice?.lang || "en-US";
        u.rate = rate;
        u.onstart = () => { this._pausing = false; };
        u.onboundary = () => { bump = 0.35; };
        let advanced = false;
        const advance = () => {
          if (advanced) return;
          advanced = true;
          clearTimeout(guard);
          this._pausing = true;
          setTimeout(next, 120);
        };
        u.onend = advance;
        u.onerror = advance;
        // 端末によっては onend が来ないことがあるので、文の長さから上限時間を決めておく
        const guard = setTimeout(advance, (2 + u.text.length * 0.12 / rate) * 1000);
        speechSynthesis.speak(u);
      };
      this.speaking = true;
      this._pausing = true;
      loop();
      // Chrome は cancel() 直後の speak() を無視することがあるので少し待つ
      setTimeout(next, 80);
    });
  }
}

// 単語帳などでネイティブ発音を聞く（キャラクター口パクなし）
// Kokoro が使えればそれで鳴らす（ブラウザの読み上げは環境によって鳴らないことがあるため）
const pronounceCache = new Map();
const pronounceOpts = { kokoro: false, voice: "af_heart" };
export function setPronounceOptions(opts) {
  Object.assign(pronounceOpts, opts);
}

export async function pronounce(text, { rate = 0.9 } = {}) {
  activeSpeaker?.stop();
  if (pronounceOpts.kokoro) {
    try {
      const key = `${pronounceOpts.voice}|${rate}|${text}`;
      let url = pronounceCache.get(key);
      if (!url) {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ engine: "kokoro", text, voice: pronounceOpts.voice, speed: rate }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error);
        url = URL.createObjectURL(base64ToBlob(d.audio, "audio/wav"));
        pronounceCache.set(key, url);
      }
      voiceAudio.src = url;
      await voiceAudio.play();
      return;
    } catch {
      // ブラウザの読み上げで代用
    }
  }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice("female");
  if (v) u.voice = v;
  u.lang = v?.lang || "en-US";
  u.rate = rate;
  // Chrome は cancel() 直後の speak() を無視することがあるので少し待つ
  setTimeout(() => speechSynthesis.speak(u), 80);
}
