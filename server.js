// フリートーク英会話アプリ - バックエンド
// - /api/chat   : AI で「返答＋質問」「和訳」「添削」「単語」「返答例」を生成
// - /api/word   : 単語をタップしたときの意味調べ
// - /api/tts    : VOICEVOX（ずんだもん等）への音声合成プロキシ
//
// AI バックエンド（EIKAIWA_BACKEND）
// - claude-code : Claude Code CLI（`claude -p`）経由。ログイン済みのサブスクリプションで動き、APIキー不要
// - api         : Claude API（ANTHROPIC_API_KEY が必要）
// - ollama      : ローカルLLM（Ollama）。オフラインで動くが品質は落ちる
// - auto（既定）: APIキーがあれば api、なければ claude-code、それもなければ ollama
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
if (fs.existsSync(path.join(here, ".env"))) process.loadEnvFile(path.join(here, ".env"));

const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.EIKAIWA_MODEL || "claude-opus-5"; // api 用
const CLI_MODEL = process.env.EIKAIWA_CLI_MODEL || "sonnet"; // claude-code 用（テンポ重視で sonnet）
const CLAUDE_BIN = process.env.EIKAIWA_CLAUDE_BIN || "claude";
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.EIKAIWA_OLLAMA_MODEL || "llama3.1:8b";
// 会話はテンポが大事なので effort は low を既定にする（.env で変更可）
const EFFORT = process.env.EIKAIWA_EFFORT || "low";
const VOICEVOX_URL = (process.env.VOICEVOX_URL || "http://127.0.0.1:50021").replace(/\/$/, "");
const KOKORO_PORT = Number(process.env.KOKORO_PORT || 50032);
const KOKORO_URL = `http://127.0.0.1:${KOKORO_PORT}`;
const PYTHON = process.env.EIKAIWA_PYTHON || "python3";
const PUBLIC_DIR = path.join(here, "public");

function detectBackend() {
  const b = (process.env.EIKAIWA_BACKEND || "auto").toLowerCase();
  if (b !== "auto") return b;
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return "api";
  const r = spawnSync(CLAUDE_BIN, ["--version"], { encoding: "utf8" });
  if (r.status === 0) return "claude-code";
  return "ollama";
}
const BACKEND = detectBackend();
const client = BACKEND === "api" ? new Anthropic() : null;

// ---------------------------------------------------------------- prompts

const LEVELS = {
  beginner:
    "The learner is a BEGINNER (around CEFR A1-A2 / 英検3級). Use very short, simple sentences (max ~12 words each), common words, and only one simple question.",
  intermediate:
    "The learner is INTERMEDIATE (around CEFR B1 / 英検2級). Use natural everyday English with some useful idioms, 2-3 sentences, one question.",
  advanced:
    "The learner is ADVANCED (around CEFR B2-C1). Speak naturally like a native friend, with idioms and phrasal verbs, 2-4 sentences, one engaging question.",
};

const PERSONAS = {
  zundamon:
    "Your name is Zundamon, a cheerful, cute fairy from Tohoku (Japan) who loves zunda mochi (sweet edamame paste). You are energetic and friendly. You speak English (you are practicing too, so you are very encouraging). In reply_ja, translate in Zundamon's signature speech style: first person 「ボク」, sentence endings like 「〜なのだ」「〜のだ」「〜なのだ？」 (e.g. 「ボクはずんだもんなのだ！今日は何をしたのだ？」).",
  female:
    "Your name is Emma, a warm and friendly woman from California who loves cafes, travel and movies.",
  male:
    "Your name is Ken, a relaxed and friendly man from Seattle who loves hiking, cooking and sports.",
  lily:
    "Your name is Lily, a bright, bubbly girl from Vancouver, Canada, and a native English speaker. You love anime, Japanese sweets (especially mochi and matcha), cats and karaoke, and you are Zundamon's best friend. You are like a cheerful, supportive big sister: warm, playful and never strict. In reply_ja, translate in a friendly, casual girl's tone (e.g. 「〜だよ！」「〜なの？」「いいね！」).",
};

function systemPrompt({ level, persona, correction, reviewWords }) {
  return `You are an English conversation partner in a free-talk English speaking app for Japanese learners.
${PERSONAS[persona] || PERSONAS.zundamon}
${LEVELS[level] || LEVELS.intermediate}

How the conversation works:
- The learner speaks via speech recognition, so their text may contain recognition errors, missing punctuation, or odd words. Guess the intended meaning generously.
- Every reply = a short, natural reaction/answer to what they said + exactly ONE follow-up question that keeps the conversation going. Topics are free: daily life, hobbies, food, work, school, travel, feelings, plans, Japan, etc. If the conversation stalls, gently move to a new everyday topic.
- Keep it spoken-style: no lists, no emojis, no markdown. It will be read aloud.
- If the learner speaks Japanese (or mixes Japanese), reply in English as usual, and use the correction field to show how to say it in English.
- Never lecture inside reply_en; corrections go in the correction field only.
${reviewWords.length ? `- The learner is memorizing these words/phrases. If it fits naturally, use one of them in your reply (don't force it): ${reviewWords.join(", ")}` : ""}

Output fields:
- reply_en: what you say (English).
- reply_ja: natural Japanese translation of reply_en.
- reply_kana: reply_en as a pronunciation guide for a Japanese text-to-speech voice, written in VOICEVOX kana notation so it sounds as close to English as possible. Rules: (1) Katakana only plus the symbols ' / 、 。 ！ ？ - no spaces, no hiragana, no Latin letters, no digits (7 -> セブン). Write long vowels with vowel kana instead of ー (ユー -> ユウ, アー -> アア, ゲーム -> ゲイム). (2) One English content word per accent phrase; attach unstressed function words (a, the, to, of, and, is, do, you, I...) to the following word; separate phrases with /. Use 、 for commas and end each sentence with 。 ！ or ？. (3) Every accent phrase has exactly one ' right AFTER the mora carrying the English stress (today -> トゥデ'イ, happy -> ハ'ッピイ, beautiful -> ビュ'ウティフル). (4) Spell sounds close to real English (love -> ラ'ヴ, what -> ワ'ット, it's -> イ'ッツ, think -> シ'ンク). Example: "Hello! How are you today? I love cake." -> ハロ'ウ！ハ'ウ/ア'ア/ユウトゥデ'イ？アイラ'ヴ/ケ'イク。
- correction: about the learner's LAST message. ${correction ? "has_issue=true only if there is a real grammar/word-choice mistake or a much more natural way to say it, or they used Japanese." : "Correction feedback is turned OFF: set has_issue=false and leave other fields empty unless they used Japanese (then show the English)."} corrected = the improved natural English sentence. explanation_ja = a short, kind explanation in Japanese (1-2 sentences). If has_issue=false, corrected and explanation_ja are "". For the very first greeting, has_issue=false.
- vocab: 1-3 useful words or phrases that appear in reply_en (or corrected) worth memorizing at this level. term = the word/phrase as used (base form), meaning_ja = concise Japanese meaning, example_en / example_ja = a short everyday example sentence and its translation.
- suggestions: 2 short example answers the learner could say next to your question (level-appropriate), each with a Japanese translation.`;
}

const CHAT_SCHEMA = {
  type: "object",
  properties: {
    reply_en: { type: "string" },
    reply_ja: { type: "string" },
    reply_kana: { type: "string" },
    correction: {
      type: "object",
      properties: {
        has_issue: { type: "boolean" },
        corrected: { type: "string" },
        explanation_ja: { type: "string" },
      },
      required: ["has_issue", "corrected", "explanation_ja"],
      additionalProperties: false,
    },
    vocab: {
      type: "array",
      items: {
        type: "object",
        properties: {
          term: { type: "string" },
          meaning_ja: { type: "string" },
          example_en: { type: "string" },
          example_ja: { type: "string" },
        },
        required: ["term", "meaning_ja", "example_en", "example_ja"],
        additionalProperties: false,
      },
    },
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: { en: { type: "string" }, ja: { type: "string" } },
        required: ["en", "ja"],
        additionalProperties: false,
      },
    },
  },
  required: ["reply_en", "reply_ja", "reply_kana", "correction", "vocab", "suggestions"],
  additionalProperties: false,
};

const WORD_SCHEMA = {
  type: "object",
  properties: {
    term: { type: "string" },
    part_of_speech: { type: "string" },
    meaning_ja: { type: "string" },
    example_en: { type: "string" },
    example_ja: { type: "string" },
  },
  required: ["term", "part_of_speech", "meaning_ja", "example_en", "example_ja"],
  additionalProperties: false,
};

const START_MESSAGE =
  "(The learner just opened the app. Greet them briefly, introduce yourself in one short sentence, and ask one easy question to start a free conversation.)";

// ---------------------------------------------------------------- AI 呼び出し

async function askAI(req) {
  if (BACKEND === "api") return askApi(req);
  if (BACKEND === "claude-code") return askClaudeCode(req);
  if (BACKEND === "ollama") return askOllama(req);
  throw new HttpError(500, `未知の EIKAIWA_BACKEND: ${BACKEND}`);
}

// Claude API（APIキーあり）
async function askApi({ system, messages, schema, maxTokens = 4000 }) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: EFFORT, format: { type: "json_schema", schema } },
    system,
    messages,
  });
  if (response.stop_reason === "refusal") throw new HttpError(422, "AIが応答できない内容でした。別の話題で試してください。");
  if (response.stop_reason === "max_tokens") throw new HttpError(502, "AIの応答が途中で切れました。もう一度試してください。");
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text);
}

// 会話履歴を1つのプロンプト文にまとめる（CLI は1回の入力しか受け取れないため）
function transcriptPrompt(messages) {
  if (messages.length === 1) return messages[0].content;
  const lines = messages.slice(0, -1).map((m) => `${m.role === "assistant" ? "YOU" : "LEARNER"}: ${m.content}`);
  const last = messages[messages.length - 1];
  return `Conversation so far:\n${lines.join("\n")}\n\nLEARNER's new message (reply to this):\n${last.content}`;
}

// Claude Code CLI（APIキー不要。`claude` にログイン済みであること）
function askClaudeCode({ system, messages, schema }) {
  const args = [
    "-p",
    "--output-format", "json",
    "--model", CLI_MODEL,
    "--effort", EFFORT,
    "--no-session-persistence",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--tools", "",
    "--system-prompt", system,
    "--json-schema", JSON.stringify(schema),
    transcriptPrompt(messages),
  ];
  const env = { ...process.env };
  delete env.CLAUDECODE; // Claude Code の中から起動した場合でも独立したセッションとして動かす
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, { cwd: os.tmpdir(), env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) =>
      reject(new HttpError(500, e.code === "ENOENT" ? "Claude Code（claude コマンド）が見つかりません。インストールしてログインしてください。" : e.message)),
    );
    child.on("close", (code) => {
      clearTimeout(timer);
      let data;
      try {
        data = JSON.parse(out);
      } catch {
        console.error("claude -p failed:", code, err || out);
        const hint = /log ?in|auth|credential/i.test(err + out) ? "Claude Code にログインしていません。ターミナルで `claude` を起動してログインしてください。" : "AIの呼び出しに失敗しました。もう一度試してください。";
        return reject(new HttpError(502, hint));
      }
      if (data.is_error || !data.structured_output) {
        console.error("claude -p error:", data.subtype, data.result);
        const msg = /limit|usage/i.test(String(data.result)) ? `Claude の利用上限に達しました: ${data.result}` : "AIの応答を取得できませんでした。もう一度試してください。";
        return reject(new HttpError(502, msg));
      }
      resolve(data.structured_output);
    });
  });
}

// Ollama（ローカルLLM）
async function askOllama({ system, messages, schema }) {
  let r;
  try {
    r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        format: schema,
        options: { temperature: 0.7 },
        messages: [
          { role: "system", content: `${system}\n\nRespond ONLY with JSON matching this schema: ${JSON.stringify(schema)}` },
          ...messages,
        ],
      }),
    });
  } catch {
    throw new HttpError(503, "Ollama に接続できません。Ollama を起動してください。");
  }
  if (!r.ok) throw new HttpError(502, `Ollama エラー (${r.status}): ${await r.text()}`);
  const data = await r.json();
  return JSON.parse(data.message.content);
}

function toMessages(history, userText) {
  // history: [{role: "user"|"assistant", text}]
  const msgs = [{ role: "user", content: START_MESSAGE }];
  for (const h of history.slice(-40)) {
    const role = h.role === "assistant" ? "assistant" : "user";
    const text = String(h.text || "").slice(0, 2000);
    if (!text) continue;
    const last = msgs[msgs.length - 1];
    if (last.role === role) last.content += "\n" + text;
    else msgs.push({ role, content: text });
  }
  if (userText) {
    const last = msgs[msgs.length - 1];
    if (last.role === "user") last.content += "\n" + userText;
    else msgs.push({ role: "user", content: userText });
  }
  return msgs;
}

async function handleChat(body) {
  const history = Array.isArray(body.history) ? body.history : [];
  const userText = String(body.text || "").trim().slice(0, 2000);
  const reviewWords = (Array.isArray(body.reviewWords) ? body.reviewWords : []).slice(0, 5).map((w) => String(w).slice(0, 60));
  const system = systemPrompt({
    level: body.level,
    persona: body.persona,
    correction: body.correction !== false,
    reviewWords,
  });
  const data = await askAI({ system, messages: toMessages(history, userText), schema: CHAT_SCHEMA });
  data.reply_kana = String(data.reply_kana || "").replace(/[A-Za-z0-9]+/g, "");
  return data;
}

async function handleWord(body) {
  const word = String(body.word || "").trim().slice(0, 80);
  if (!word) throw new HttpError(400, "word is required");
  const context = String(body.context || "").slice(0, 500);
  return askAI({
    system:
      "You are a concise English-Japanese dictionary for Japanese learners. Given a word and the sentence it appeared in, explain the meaning used in that context. term = dictionary (base) form. part_of_speech in Japanese (例: 動詞, 名詞, 形容詞, 熟語). Examples should be short and everyday.",
    messages: [{ role: "user", content: `Word: ${word}\nContext: ${context}` }],
    schema: WORD_SCHEMA,
    maxTokens: 1500,
  });
}

// ---------------------------------------------------------------- VOICEVOX

async function handleTts(body) {
  if (body.engine === "kokoro") return kokoroTts(body);
  // VOICEVOX はスペースごとに間（ポーズ）を入れるため、単語区切りのスペースは取り除く
  const text = String(body.text || "").replace(/[\s　]+/g, "").slice(0, 600);
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

async function kokoroStatus() {
  try {
    const r = await fetch(`${KOKORO_URL}/health`, { signal: AbortSignal.timeout(1500) });
    const d = r.ok ? await r.json() : {};
    return { available: !!d.ok, stt: !!d.stt };
  } catch {
    return { available: false, stt: false };
  }
}

// 音声認識（Whisper）: 録音データをそのまま tts/speech_server.py へ中継
async function handleStt(req, url) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 15_000_000) throw new HttpError(413, "録音が長すぎます");
    chunks.push(c);
  }
  const lang = url.searchParams.get("lang") === "ja" ? "ja" : "en";
  const context = (url.searchParams.get("context") || "").slice(0, 300);
  let r;
  try {
    r = await fetch(`${KOKORO_URL}/stt?lang=${lang}&context=${encodeURIComponent(context)}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.concat(chunks),
    });
  } catch {
    throw new HttpError(503, "音声認識エンジン（Whisper）に接続できません。");
  }
  const data = await r.json();
  if (!r.ok) throw new HttpError(502, `音声認識エラー: ${data.error}`);
  return data;
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

async function voicevoxStatus() {
  try {
    const r = await fetch(`${VOICEVOX_URL}/version`, { signal: AbortSignal.timeout(1500) });
    return { available: r.ok, version: r.ok ? await r.json() : null };
  } catch {
    return { available: false, version: null };
  }
}

// ---------------------------------------------------------------- HTTP

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new HttpError(413, "Request too large");
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "Forbidden" });
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file)) return sendJson(res, 404, { error: "Not found" });
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

function errorResponse(err) {
  if (err instanceof HttpError) return [err.status, err.message];
  if (err instanceof Anthropic.AuthenticationError)
    return [500, "Claude APIキーが無効です。.env の ANTHROPIC_API_KEY を確認してください。"];
  if (err instanceof Anthropic.AnthropicError && /authentication method/i.test(err.message))
    return [500, "Claude APIキーが設定されていません。.env に ANTHROPIC_API_KEY を設定してサーバーを再起動してください。"];
  if (err instanceof Anthropic.RateLimitError) return [429, "混み合っています。少し待ってからもう一度話しかけてください。"];
  if (err instanceof Anthropic.BadRequestError) return [400, `リクエストエラー: ${err.message}`];
  if (err instanceof Anthropic.APIConnectionError) return [503, "Claude APIに接続できません。ネットワークを確認してください。"];
  if (err instanceof Anthropic.APIError) return [502, `Claude APIエラー (${err.status})`];
  if (err instanceof SyntaxError) return [502, "AIの応答を解析できませんでした。もう一度試してください。"];
  if (err?.cause?.code === "ECONNREFUSED") return [503, "VOICEVOXに接続できません。"];
  return [500, err?.message || "Internal error"];
}

// ---------------------------------------------------------------- スマホ（LAN）対応
// `npm run mobile` で HTTPS サーバーを LAN に公開する。
// スマホのマイクは HTTPS でないと使えないため、自己署名証明書を自動生成する。
// 同じ Wi-Fi の他人が使えないよう、アクセストークン付きURL（QRコード）で入る。

const MOBILE = process.argv.includes("--mobile") || process.env.EIKAIWA_MOBILE === "1";
let HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443); // 使用中なら起動時に空いている番号へずらす
const CERT_DIR = path.join(here, "certs");

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .map((a) => a.address);
}

function ensureCert() {
  const key = path.join(CERT_DIR, "key.pem");
  const cert = path.join(CERT_DIR, "cert.pem");
  const ips = lanAddresses();
  const sanFile = path.join(CERT_DIR, "san.txt");
  const san = ["DNS:localhost", `DNS:${os.hostname()}`, "IP:127.0.0.1", ...ips.map((ip) => `IP:${ip}`)].join(",");
  // IP が変わったら作り直す
  if (!fs.existsSync(key) || !fs.existsSync(cert) || (fs.existsSync(sanFile) && fs.readFileSync(sanFile, "utf8") !== san)) {
    fs.mkdirSync(CERT_DIR, { recursive: true });
    // -addext は macOS 標準の LibreSSL では使えないことがあるため、設定ファイルで SAN を渡す
    const conf = path.join(CERT_DIR, "openssl.cnf");
    fs.writeFileSync(conf, [
      "[req]", "distinguished_name=dn", "x509_extensions=ext", "prompt=no",
      "[dn]", "CN=Eikaiwa Local",
      "[ext]", `subjectAltName=${san}`, "basicConstraints=CA:FALSE", "keyUsage=digitalSignature,keyEncipherment", "extendedKeyUsage=serverAuth",
    ].join("\n"));
    const r = spawnSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "825",
      "-keyout", key, "-out", cert, "-config", conf,
    ], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`証明書の生成に失敗しました（openssl が必要です）: ${r.stderr}`);
    fs.writeFileSync(sanFile, san);
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function accessToken() {
  const f = path.join(CERT_DIR, "token.txt");
  if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const t = crypto.randomBytes(12).toString("base64url");
  fs.writeFileSync(f, t, { mode: 0o600 });
  return t;
}

const TOKEN = MOBILE ? accessToken() : null;

function mobileUrls() {
  return lanAddresses().map((ip) => `https://${ip}:${HTTPS_PORT}/?t=${TOKEN}`);
}

function isLoopback(req) {
  const a = req.socket.remoteAddress || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function cookieToken(req) {
  const m = /(?:^|;\s*)ek_token=([^;]+)/.exec(req.headers.cookie || "");
  return m ? decodeURIComponent(m[1]) : null;
}

// LAN からのアクセスはトークン必須。?t= で来たら Cookie に保存して URL から消す
function checkAccess(req, res) {
  if (isLoopback(req)) return true;
  const url = new URL(req.url, "https://x");
  const t = url.searchParams.get("t");
  if (t && t === TOKEN) {
    url.searchParams.delete("t");
    res.writeHead(302, {
      "Set-Cookie": `ek_token=${encodeURIComponent(TOKEN)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`,
      Location: url.pathname + url.search,
    });
    res.end();
    return false;
  }
  if (cookieToken(req) === TOKEN) return true;
  res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<meta name="viewport" content="width=device-width"><p style="font:16px sans-serif;padding:20px">アクセスできません。PC の画面の「スマホで使う」に表示される QR コードから開いてください。</p>`);
  return false;
}

async function handleMobileInfo(req) {
  if (!isLoopback(req)) throw new HttpError(403, "Forbidden");
  if (!MOBILE) return { enabled: false };
  const urls = mobileUrls();
  const QRCode = (await import("qrcode")).default;
  const qr = urls[0] ? await QRCode.toString(urls[0], { type: "svg", margin: 1, width: 240 }) : "";
  return { enabled: true, urls, qr };
}

async function handler(req, res) {
  try {
    if (MOBILE && !checkAccess(req, res)) return;
    const pathname = new URL(req.url, "http://x").pathname;
    if (req.method === "POST" && pathname === "/api/chat") return sendJson(res, 200, await handleChat(await readJson(req)));
    if (req.method === "POST" && pathname === "/api/word") return sendJson(res, 200, await handleWord(await readJson(req)));
    if (req.method === "POST" && pathname === "/api/stt") return sendJson(res, 200, await handleStt(req, new URL(req.url, "http://x")));
    if (req.method === "POST" && pathname === "/api/tts") {
      return sendJson(res, 200, await handleTts(await readJson(req)));
    }
    if (req.method === "GET" && pathname === "/api/status")
      return sendJson(res, 200, { backend: BACKEND, model: modelLabel(), voicevox: await voicevoxStatus(), kokoro: await kokoroStatus() });
    if (req.method === "GET" && pathname === "/api/mobile") return sendJson(res, 200, await handleMobileInfo(req));
    if (req.method === "GET") return serveStatic(req, res);
    sendJson(res, 405, { error: "Method not allowed" });
  } catch (err) {
    const [status, message] = errorResponse(err);
    if (status >= 500) console.error(err);
    sendJson(res, status, { error: message });
  }
}

function modelLabel() {
  return { api: MODEL, "claude-code": `Claude Code (${CLI_MODEL})`, ollama: `Ollama (${OLLAMA_MODEL})` }[BACKEND] || BACKEND;
}

// VOICEVOX が起動していなければ、見つかったエンジンを自動で起動する
// 既定の場所: ~/Applications/voicevox_engine/macos-*/run、または VOICEVOX アプリ同梱のエンジン
function findVoicevoxEngine() {
  if (process.env.VOICEVOX_ENGINE_PATH) return process.env.VOICEVOX_ENGINE_PATH;
  const home = os.homedir();
  const candidates = [
    path.join(home, "Applications/voicevox_engine/macos-arm64/run"),
    path.join(home, "Applications/voicevox_engine/macos-x64/run"),
    "/Applications/VOICEVOX.app/Contents/Resources/vv-engine/run",
    path.join(home, "Applications/VOICEVOX.app/Contents/Resources/vv-engine/run"),
  ];
  return candidates.find((c) => fs.existsSync(c)) || null;
}

let engineProcess = null;
async function ensureVoicevox() {
  if ((await voicevoxStatus()).available) return true;
  const bin = findVoicevoxEngine();
  if (!bin || process.env.VOICEVOX_AUTOSTART === "0") return false;
  const port = new URL(VOICEVOX_URL).port || "50021";
  console.log(`  VOICEVOX エンジンを起動中… (${bin})`);
  engineProcess = spawn(bin, ["--host", "127.0.0.1", "--port", port], { cwd: path.dirname(bin), stdio: "ignore" });
  engineProcess.on("error", (e) => console.error("  VOICEVOX の起動に失敗:", e.message));
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if ((await voicevoxStatus()).available) return true;
  }
  return false;
}
// Kokoro（英語ネイティブ音声）を自動起動（Python と kokoro パッケージが必要）
let kokoroProcess = null;
async function ensureKokoro() {
  if ((await kokoroStatus()).available) return true;
  if (process.env.KOKORO_AUTOSTART === "0") return false;
  const check = spawnSync(PYTHON, ["-c", "import kokoro, soundfile"], { encoding: "utf8" });
  if (check.status !== 0) return false;
  console.log("  音声エンジン（Kokoro / Whisper）を起動中…");
  kokoroProcess = spawn(PYTHON, [path.join(here, "tts/speech_server.py"), "--port", String(KOKORO_PORT)], { stdio: "ignore" });
  kokoroProcess.on("error", (e) => console.error("  Kokoro の起動に失敗:", e.message));
  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if ((await kokoroStatus()).available) return true;
  }
  return false;
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    kokoroProcess?.kill();
    engineProcess?.kill();
    process.exit(0);
  });
}

// 指定ポートが使用中なら、空いている番号を順に試す
function listenFree(server, port, host, label) {
  return new Promise((resolve, reject) => {
    const attempt = (p, left) => {
      // 失敗した回の listening ハンドラが残ると、次に成功したとき古い番号で resolve してしまうので必ず外す
      const onListening = () => {
        server.off("error", onError);
        resolve(p);
      };
      const onError = (e) => {
        server.off("listening", onListening);
        if (e.code === "EADDRINUSE" && left > 0) {
          console.log(`  ⚠ ${label}のポート ${p} は使用中です（前に起動したアプリが残っていませんか？）→ ${p + 1} を使います`);
          attempt(p + 1, left - 1);
        } else reject(e);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(p, host);
    };
    attempt(port, 20);
  });
}

async function main() {
  // PC 用（このPCからだけアクセス可）
  const port = await listenFree(http.createServer(handler), PORT, "127.0.0.1", "PC用");
  console.log(`英会話アプリ: http://localhost:${port}`);
  console.log(`  AI: ${modelLabel()}  [EIKAIWA_BACKEND=${BACKEND}]`);

  // スマホ用（LAN に HTTPS で公開）
  let mobileReady = false;
  if (MOBILE) {
    try {
      HTTPS_PORT = await listenFree(https.createServer(ensureCert(), handler), HTTPS_PORT, "0.0.0.0", "スマホ用");
      mobileReady = true;
    } catch (e) {
      console.error(`  ⚠ スマホ用サーバーを起動できませんでした: ${e.message}`);
    }
  }

  await Promise.all([ensureVoicevox(), ensureKokoro()]);
  const vv = await voicevoxStatus();
  console.log(`  VOICEVOX: ${vv.available ? `OK (v${vv.version})` : `未起動 (${VOICEVOX_URL}) → ずんだもんはブラウザ音声で代用`}`);
  const kk = await kokoroStatus();
  console.log(`  Kokoro:   ${kk.available ? "OK（リリー・Emma・Ken の声）" : "未起動 → ブラウザ音声で代用（pip install kokoro soundfile で使えます）"}`);
  console.log(`  Whisper:  ${kk.stt ? "OK（日本人の英語に強い音声認識）" : "なし → ブラウザの音声認識を使用（pip install mlx-whisper で使えます）"}`);

  if (!MOBILE) {
    console.log("\n  スマホで使うには: npm run mobile");
  } else if (mobileReady) {
    const urls = mobileUrls();
    if (!urls.length) {
      console.log("\n📱 Wi-Fi（LAN）に接続されていないため、スマホ用のURLを作れませんでした。");
    } else {
      console.log(`\n📱 スマホ用（同じWi-Fiで、下のQRコードを読み取る。PC画面の「📱 スマホで使う」にも表示されます）:`);
      urls.forEach((u) => console.log(`  ${u}`));
      const QRCode = (await import("qrcode")).default;
      console.log(await QRCode.toString(urls[0], { type: "terminal", small: true }));
      console.log("  ※ 初回は「この接続ではプライバシーが保護されません」等の警告が出ます → 詳細 → アクセスする で進んでください");
    }
  }
  console.log("\n  終了するには Ctrl+C");
}

main().catch((e) => {
  console.error("起動できませんでした:", e.message);
  process.exit(1);
});
