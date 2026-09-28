// 声（VOICEVOX: ずんだもん / Kokoro: リリー・Emma・Ken）と音声認識（Whisper）

import { HttpError } from "./errors.js";

export const VOICEVOX_URL = (process.env.VOICEVOX_URL || "http://127.0.0.1:50021").replace(/\/$/, "");
export const KOKORO_PORT = Number(process.env.KOKORO_PORT || 50032);
const KOKORO_URL = `http://127.0.0.1:${KOKORO_PORT}`;
const GROQ_STT_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

export async function handleTts(body) {
  if (body.engine === "kokoro") return kokoroTts(body);
  // VOICEVOX はスペースごとに間（ポーズ）を入れるため、単語区切りのスペースは取り除く
  const text = String(body.text || "").replace(/[\s\u3000]+/g, "").replace(/[A-Za-z0-9Ａ-Ｚａ-ｚ０-９]+/g, "").slice(0, 600);
  const speaker = Number.isInteger(body.speaker) ? body.speaker : 3; // 3 = ずんだもん（ノーマル）
  const speed = Math.min(Math.max(Number(body.speed) || 1, 0.5), 2);
  if (!text) throw new HttpError(400, "text is required");
  const vv = async (p, init) => {
    const r = await fetch(`${VOICEVOX_URL}${p}`, { method: "POST", ...init });
    if (!r.ok) throw new HttpError(502, `VOICEVOX ${p.split("?")[0]} failed (${r.status})`);
    return r;
  };
  const notation = /['/]/.test(text) ? repairKanaNotation(text) : null;
  const plain = notation ? notation.replace(/['/_]/g, "") : text;
  const query = await (await vv(`/audio_query?text=${encodeURIComponent(plain)}&speaker=${speaker}`)).json();
  if (notation) {
    // 英語の強勢（ストレス）を音の高さ（アクセント）として反映する。記法エラーなら普通の読みのまま
    try {
      query.accent_phrases = await (await vv(`/accent_phrases?text=${encodeURIComponent(notation)}&speaker=${speaker}&is_kana=true`)).json();
    } catch (e) {
      console.warn("kana notation rejected, fallback to plain:", notation);
    }
  }
  query.speedScale = speed;
  query.intonationScale = 1.15;
  const s = await vv(`/synthesis?speaker=${speaker}`, { headers: { "Content-Type": "application/json" }, body: JSON.stringify(query) });
  const wav = Buffer.from(await s.arrayBuffer());
  return { audio: wav.toString("base64"), precise: true, ...mouthTimeline(query) };
}

// AI が書いた VOICEVOX 記法（AquesTalk 風）を、エンジンが受け付ける形に直す
//  - ー → 直前の母音、不要な記号の除去、文末の 。！ → 、
//  - アクセント ' のない句は次の句にくっつける（機能語）、' が複数なら最後の1つを残す
const KANA_VOWEL = {};
for (const [v, row] of Object.entries({
  a: "アカサタナハマヤラワガザダバパァャヵ", i: "イキシチニヒミリギジヂビピィ", u: "ウクスツヌフムユルグズヅブプゥュヴ",
  e: "エケセテネヘメレゲゼデベペェ", o: "オコソトノホモヨロヲゴゾドボポォョ",
})) for (const ch of row) KANA_VOWEL[ch] = v;
const VOWEL_KANA = { a: "ア", i: "イ", u: "ウ", e: "エ", o: "オ" };
const SMALL_KANA = "ァィゥェォャュョヮ";

function repairKanaNotation(src) {
  let s = "";
  for (const ch of src.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))) {
    if (ch === "ー") {
      const prev = [...s].reverse().find((c) => KANA_VOWEL[c]);
      s += prev ? VOWEL_KANA[KANA_VOWEL[prev]] : "";
    } else s += ch;
  }
  s = s.replace(/[。！!]/g, "、").replace(/\?/g, "？").replace(/_/g, "");
  s = s.replace(/[^ァ-ヴッン'/、？]/g, "").replace(/、+/g, "、").replace(/^[、/]+|[、/]+$/g, "");
  const parts = s.split(/([/、])/);
  const phrases = [];
  for (let i = 0; i < parts.length; i += 2) {
    const t = parts[i], d = parts[i + 1] || "";
    if (t.replace(/[？']/g, "")) phrases.push([t, d]);
  }
  const firstMora = (body) => {
    let n = 1;
    while (n < body.length && SMALL_KANA.includes(body[n])) n++;
    return n;
  };
  const out = [];
  let carry = "";
  phrases.forEach(([t, d], i) => {
    t = carry + t;
    carry = "";
    const q = t.endsWith("？");
    let body = t.replace(/？/g, "");
    const n = (body.match(/'/g) || []).length;
    if (n > 1) {
      const last = body.lastIndexOf("'");
      body = body.slice(0, last).replace(/'/g, "") + body.slice(last);
    }
    if (n === 0) {
      if (d === "/" && i + 1 < phrases.length && !q) {
        carry = body;
        return;
      }
      const k = firstMora(body);
      body = body.slice(0, k) + "'" + body.slice(k);
    }
    body = body.replace(/^'+/, "");
    if (/^[ッン]/.test(body)) body = body.replace(/^[ッン]+/, "");
    if (!body.replace(/'/g, "")) return;
    if (!body.includes("'")) body = body.slice(0, firstMora(body)) + "'" + body.slice(firstMora(body));
    out.push(body + (q ? "？" : "") + (i < phrases.length - 1 ? d : ""));
  });
  return out.join("").replace(/[/、]+$/, "");
}

// Kokoro（英語ネイティブ音声）: tts/speech_server.py へ中継
async function kokoroTts(body) {
  const text = String(body.text || "").trim().slice(0, 1000);
  if (!text) throw new HttpError(400, "text is required");
  let r;
  try {
    r = await fetch(`${KOKORO_URL}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: body.voice, speed: body.speed }),
    });
  } catch {
    throw new HttpError(503, "英語音声エンジン（Kokoro）に接続できません。");
  }
  const data = await r.json();
  if (!r.ok) throw new HttpError(502, `Kokoro エラー: ${data.error}`);
  return { ...data, precise: false };
}

export async function kokoroStatus() {
  try {
    const r = await fetch(`${KOKORO_URL}/health`, { signal: AbortSignal.timeout(1500) });
    const d = r.ok ? await r.json() : {};
    return { available: !!d.ok, stt: !!d.stt };
  } catch {
    return { available: false, stt: false };
  }
}

// 口パク用: モーラごとの母音と発音タイミング（秒）
// [開始, 終了, 母音]  母音 = a i u e o（大文字は無声化）/ N（ん）/ cl（っ）
function mouthTimeline(query) {
  const k = 1 / (query.speedScale || 1);
  let t = (query.prePhonemeLength || 0) * k;
  const timeline = [];
  for (const ap of query.accent_phrases) {
    for (const m of ap.moras) {
      const c = (m.consonant_length || 0) * k;
      const v = (m.vowel_length || 0) * k;
      timeline.push([+(t + c).toFixed(3), +(t + c + v).toFixed(3), m.vowel]);
      t += c + v;
    }
    if (ap.pause_mora) t += (ap.pause_mora.vowel_length || 0) * k;
  }
  t += (query.postPhonemeLength || 0) * k;
  return { timeline, total: +t.toFixed(3) };
}

// 英語 → ずんだもん用のカナ（発音辞書から規則で作る。LLM のトークンを使わない）
export async function g2pKana(text) {
  const r = await fetch(`${KOKORO_URL}/kana`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error("kana failed");
  return (await r.json()).kana || "";
}

export async function voicevoxStatus() {
  try {
    const r = await fetch(`${VOICEVOX_URL}/version`, { signal: AbortSignal.timeout(1500) });
    return { available: r.ok, version: r.ok ? await r.json() : null };
  } catch {
    return { available: false, version: null };
  }
}


// ---------------------------------------------------------------- 音声認識

// 日本人学習者の英語を「文法ミスも含めてそのまま」書き取らせるためのヒント（tts/speech_server.py と同じ）
// 例文は学習者が言いそうにない内容にする（似た発話が例文に書き換えられるのを防ぐ）
const VERBATIM_PROMPT =
  "The speaker is a Japanese learner of English. Transcribe exactly what they say, keeping grammar mistakes. " +
  "For example: Uh, last Sunday I buy new umbrella. My grandmother don't use smartphone.";

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, "録音が長すぎます（30秒以内で話してください）");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// PC の Whisper（無料・回数無制限）を優先し、使えなければ Groq の Whisper（無料枠）を使う
export async function handleStt(req, url) {
  const audio = await readBody(req, 10_000_000);
  if (audio.length < 1000) return { text: "" };
  const lang = url.searchParams.get("lang") === "ja" ? "ja" : "en";
  const context = (url.searchParams.get("context") || "").slice(0, 300);
  const type = String(req.headers["content-type"] || "audio/webm").split(";")[0];
  if ((await kokoroStatus()).stt) {
    const r = await fetch(`${KOKORO_URL}/stt?lang=${lang}&context=${encodeURIComponent(context)}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: audio,
    }).catch(() => null);
    if (r?.ok) return { text: (await r.json()).text || "" };
  }
  const key = process.env.GROQ_API_KEY || (process.env.LLM_BASE_URL ? "" : process.env.LLM_API_KEY) || "";
  if (!key) throw new HttpError(503, "音声認識が使えません（管理者向け: Whisper か GROQ_API_KEY が必要）。キーボードで入力してください。");
  const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : "webm";
  const form = new FormData();
  form.append("file", new Blob([audio], { type }), `speech.${ext}`);
  form.append("model", process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo");
  form.append("language", lang);
  form.append("temperature", "0");
  form.append("response_format", "verbose_json");
  if (lang === "en") form.append("prompt", VERBATIM_PROMPT + (context ? ` Question: ${context}` : ""));
  let r;
  try {
    r = await fetch(GROQ_STT_URL, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new HttpError(503, "音声認識サービスに接続できません。");
  }
  if (r.status === 429) throw new HttpError(429, "音声認識の無料枠の上限に達しました。少し待つか、キーボードで入力してください。");
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("Groq STT error:", r.status, JSON.stringify(data).slice(0, 300));
    throw new HttpError(502, "音声認識に失敗しました。もう一度話してください。");
  }
  return { text: cleanTranscript(data) };
}

// Whisper の「幻聴」（無音や雑音で出るでたらめな文）を取り除く（tts/speech_server.py と同じ基準）
export function cleanTranscript(result) {
  const segs = Array.isArray(result.segments) && result.segments.length ? result.segments : [{ text: result.text || "" }];
  const text = segs
    .filter((s) => !((s.compression_ratio ?? 0) > 2.4) && !((s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -1.0))
    .map((s) => String(s.text || "").trim())
    .filter(Boolean)
    .join(" ");
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((x) => x && !x.toLowerCase().startsWith("the speaker is a japanese learner"))
    .join(" ")
    .trim();
}
