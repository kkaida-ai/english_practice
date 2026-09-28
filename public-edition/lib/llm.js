// 会話AI。.env の LLM_PROVIDER で選ぶ
//   groq        : Groq の無料 LLM（既定・速い）。混雑時は予備モデルに自動で切り替え
//   claude-code : この PC にログイン済みの Claude Code（`claude -p`）。質が最も高い。明示したときだけ使う
//   ollama      : この PC の Ollama（完全無料・質は低め）
//   その他 OpenAI 互換サービスは LLM_BASE_URL / LLM_API_KEY / LLM_MODEL で

import os from "node:os";
import { spawn } from "node:child_process";
import { HttpError } from "./errors.js";
import { g2pKana } from "./speech.js";

const GROQ_URL = "https://api.groq.com/openai/v1";
const OLLAMA_URL = "http://127.0.0.1:11434/v1";

export function llmConfig() {
  const key = process.env.LLM_API_KEY || process.env.GROQ_API_KEY || "";
  let provider = (process.env.LLM_PROVIDER || "").toLowerCase();
  if (!provider) provider = process.env.LLM_BASE_URL ? "openai" : key ? "groq" : "ollama";
  if (provider === "claude-code") {
    const model = process.env.CLAUDE_CODE_MODEL || "sonnet";
    return { provider, model, models: [model], label: `Claude Code (${model})` };
  }
  const baseUrl = (process.env.LLM_BASE_URL || (provider === "groq" ? GROQ_URL : OLLAMA_URL)).replace(/\/$/, "");
  const isGroq = baseUrl.startsWith(GROQ_URL);
  const model = process.env.LLM_MODEL || (isGroq ? "openai/gpt-oss-120b" : "llama3.1:8b");
  // Groq の無料枠はモデルごとに別枠（gpt-oss-120b / 20b とも 1分8,000トークン）なので、混んだら予備モデルへ
  const fallbacks = (process.env.LLM_FALLBACK_MODELS ?? (isGroq ? "openai/gpt-oss-20b" : "")).split(",").map((m) => m.trim()).filter(Boolean);
  const name = isGroq ? "Groq" : baseUrl.includes("11434") ? "Ollama" : baseUrl;
  return { provider: isGroq ? "groq" : provider, key, baseUrl, isGroq, model, models: [model, ...fallbacks], label: `${name} (${model})` };
}

// ずんだもんの英語のカナ読みを誰が作るか
//   llm: 会話AIに書かせる（Claude なら最も自然）/ g2p: 発音辞書から規則で作る（トークンを使わない）
// 測定（英語音声認識 Whisper に聞かせて比較）: Claude > 規則 > gpt-oss 相当。既定は Claude のときだけ llm
export function kanaSource() {
  return process.env.ZUNDA_KANA || (llmConfig().provider === "claude-code" ? "llm" : "g2p");
}

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

export function systemPrompt({ level, persona, correction, reviewWords, withKana = true }) {
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
${withKana ? `- reply_kana: reply_en as a pronunciation guide for a Japanese text-to-speech voice, written in VOICEVOX kana notation so it sounds as close to English as possible. Rules: (1) Katakana only plus the symbols ' / 、 。 ！ ？ - no spaces, no hiragana, no Latin letters, no digits (7 -> セブン). Write long vowels with vowel kana instead of ー (ユー -> ユウ, アー -> アア, ゲーム -> ゲイム). (2) One English content word per accent phrase; attach unstressed function words (a, the, to, of, and, is, do, you, I...) to the following word; separate phrases with /. Use 、 for commas and end each sentence with 。 ！ or ？. (3) Every accent phrase has exactly one ' right AFTER the mora carrying the English stress (today -> トゥデ'イ, happy -> ハ'ッピイ, beautiful -> ビュ'ウティフル). (4) Spell sounds close to real English (love -> ラ'ヴ, what -> ワ'ット, it's -> イ'ッツ, think -> シ'ンク). Example: "Hello! How are you today? I love cake." -> ハロ'ウ！ハ'ウ/ア'ア/ユウトゥデ'イ？アイラ'ヴ/ケ'イク。\n` : ""}- correction: about the learner's LAST message. ${correction ? "has_issue=true only if there is a real grammar/word-choice mistake or a much more natural way to say it, or they used Japanese." : "Correction feedback is turned OFF: set has_issue=false and leave other fields empty unless they used Japanese (then show the English)."} corrected = the improved natural English sentence. explanation_ja = a short, kind explanation in Japanese (1-2 sentences). If has_issue=false, corrected and explanation_ja are "". For the very first greeting, has_issue=false.
- vocab: 1-3 useful words or phrases that appear in reply_en (or corrected) worth memorizing at this level. term = the word/phrase as used (base form), meaning_ja = concise Japanese meaning, example_en / example_ja = a short everyday example sentence and its translation.
- suggestions: 2 short example answers the learner could say next to your question (level-appropriate), each with a Japanese translation.`;
}

const CHAT_SCHEMA_FULL = {
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

// カナを LLM に書かせないときは reply_kana を出力させない（トークン節約）
export function chatSchema(withKana) {
  if (withKana) return CHAT_SCHEMA_FULL;
  const { reply_kana, ...properties } = CHAT_SCHEMA_FULL.properties;
  return { ...CHAT_SCHEMA_FULL, properties, required: CHAT_SCHEMA_FULL.required.filter((r) => r !== "reply_kana") };
}
export const CHAT_SCHEMA = CHAT_SCHEMA_FULL;

export const WORD_SCHEMA = {
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

export const START_MESSAGE =
  "(The learner just opened the app. Greet them briefly, introduce yourself in one short sentence, and ask one easy question to start a free conversation.)";

// ---------------------------------------------------------------- 呼び出し

async function complete(req) {
  const cfg = llmConfig();
  const out = cfg.provider === "claude-code" ? await completeClaudeCode(req, cfg) : await completeOpenAI(req, cfg);
  return typeof out === "string" ? parseJson(out) : out;
}

function parseJson(text) {
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    console.error("LLM returned non-JSON:", text.slice(0, 300));
    throw new HttpError(502, "AIの応答を読み取れませんでした。もう一度試してください。");
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 429 のとき何秒待てばよいか（retry-after ヘッダー / "try again in 3.3s" の文面）
function retryAfterSec(r, data) {
  const h = Number(r.headers.get("retry-after"));
  if (h > 0) return h;
  const m = /try again in ([\d.]+)\s*(ms|s)/i.exec(data?.error?.message || "");
  return m ? Number(m[1]) / (m[2] === "ms" ? 1000 : 1) : 10;
}

// OpenAI 互換 API（Groq / Ollama など）
async function completeOpenAI({ system, messages, schema, name, maxTokens = 2500 }, cfg) {
  let waitedOnce = false;
  for (let i = 0; i < cfg.models.length; i++) {
    const model = cfg.models[i];
    const body = {
      model,
      messages: [{ role: "system", content: system }, ...messages],
      max_tokens: maxTokens,
      temperature: 0.7,
      // gpt-oss は strict な JSON Schema に対応（必ずスキーマ通りの JSON が返る）
      response_format: { type: "json_schema", json_schema: { name, strict: true, schema } },
    };
    if (cfg.isGroq && model.startsWith("openai/gpt-oss")) body.reasoning_effort = "low"; // 会話はテンポ重視
    let r;
    try {
      r = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new HttpError(503, "会話AIに接続できません。少し待ってからもう一度試してください。");
    }
    const data = await r.json().catch(() => ({}));
    if (r.status === 429) {
      const wait = retryAfterSec(r, data);
      console.warn(`LLM 429 (${model}): retry after ${wait}s`);
      if (wait <= 5 && !waitedOnce) {
        // 少し待てば空くなら同じモデルでやり直す
        waitedOnce = true;
        await sleep(wait * 1000 + 200);
        i--;
        continue;
      }
      continue; // 予備モデルへ
    }
    if (r.status === 401 || r.status === 403) throw new HttpError(500, "会話AIのAPIキーが無効です（管理者向け: .env の GROQ_API_KEY を確認）。");
    if (!r.ok) {
      console.error("LLM error:", r.status, JSON.stringify(data).slice(0, 500));
      throw new HttpError(502, "会話AIの呼び出しに失敗しました。もう一度試してください。");
    }
    return data.choices?.[0]?.message?.content || "";
  }
  throw new HttpError(429, "混み合っています（無料枠の上限）。20秒ほど待ってから話しかけてください。");
}

// 会話履歴を1つのプロンプト文にまとめる（CLI は1回の入力しか受け取れないため）
function transcriptPrompt(messages) {
  if (messages.length === 1) return messages[0].content;
  const lines = messages.slice(0, -1).map((m) => `${m.role === "assistant" ? "YOU" : "LEARNER"}: ${m.content}`);
  return `Conversation so far:\n${lines.join("\n")}\n\nLEARNER's new message (reply to this):\n${messages.at(-1).content}`;
}

// Claude Code CLI（この PC にログイン済みのアカウントで動く。APIキー不要）
function completeClaudeCode({ system, messages, schema }, cfg) {
  const args = [
    "-p", "--output-format", "json", "--model", cfg.model, "--effort", "low",
    "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "", "--tools", "",
    "--system-prompt", system, "--json-schema", JSON.stringify(schema), transcriptPrompt(messages),
  ];
  const env = { ...process.env };
  delete env.CLAUDECODE; // Claude Code の中から起動した場合でも独立したセッションとして動かす
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CLAUDE_BIN || "claude", args, { cwd: os.tmpdir(), env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new HttpError(500, e.code === "ENOENT" ? "Claude Code（claude コマンド）が見つかりません。" : e.message)));
    child.on("close", () => {
      clearTimeout(timer);
      let data;
      try {
        data = JSON.parse(out);
      } catch {
        console.error("claude -p failed:", err || out);
        return reject(new HttpError(502, /log ?in|auth/i.test(err + out) ? "Claude Code にログインしていません（管理者向け）。" : "AIの呼び出しに失敗しました。もう一度試してください。"));
      }
      if (data.is_error || !data.structured_output) {
        console.error("claude -p error:", data.subtype, String(data.result).slice(0, 300));
        return reject(new HttpError(/limit|usage/i.test(String(data.result)) ? 429 : 502, /limit|usage/i.test(String(data.result)) ? "Claude の利用上限に達しました。しばらく待ってください。" : "AIの応答を取得できませんでした。もう一度試してください。"));
      }
      resolve(data.structured_output);
    });
  });
}

// 無料モデルは項目が欠けたり型が違ったりすることがあるので、画面が壊れないよう整える
const str = (v, max = 2000) => (typeof v === "string" ? v : v == null ? "" : String(v)).slice(0, max);
function normalizeChat(d) {
  const c = d?.correction || {};
  return {
    reply_en: str(d?.reply_en, 1500),
    reply_ja: str(d?.reply_ja, 1500),
    reply_kana: str(d?.reply_kana, 1500).replace(/[A-Za-z0-9Ａ-Ｚａ-ｚ０-９]+/g, ""),
    correction: { has_issue: !!c.has_issue && !!str(c.corrected), corrected: str(c.corrected, 800), explanation_ja: str(c.explanation_ja, 800) },
    vocab: (Array.isArray(d?.vocab) ? d.vocab : []).slice(0, 3).map((v) => ({
      term: str(v?.term, 80), meaning_ja: str(v?.meaning_ja, 200), example_en: str(v?.example_en, 300), example_ja: str(v?.example_ja, 300),
    })).filter((v) => v.term && v.meaning_ja),
    suggestions: (Array.isArray(d?.suggestions) ? d.suggestions : []).slice(0, 3).map((s) => ({ en: str(s?.en, 300), ja: str(s?.ja, 300) })).filter((s) => s.en),
  };
}

function toMessages(history, userText) {
  // history: [{role: "user"|"assistant", text}]
  const msgs = [{ role: "user", content: START_MESSAGE }];
  for (const h of history.slice(-30)) {
    const role = h.role === "assistant" ? "assistant" : "user";
    const text = String(h.text || "").slice(0, 1000);
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

export async function handleChat(body) {
  const history = Array.isArray(body.history) ? body.history.slice(-16) : []; // 直近8往復（トークン節約）
  const userText = String(body.text || "").trim().slice(0, 1000);
  const reviewWords = (Array.isArray(body.reviewWords) ? body.reviewWords : []).slice(0, 5).map((w) => String(w).slice(0, 60));
  const zunda = (body.persona || "zundamon") === "zundamon";
  const withKana = zunda && kanaSource() === "llm";
  const system = systemPrompt({ level: body.level, persona: body.persona, correction: body.correction !== false, reviewWords, withKana });
  const messages = toMessages(history, userText);
  const schema = chatSchema(withKana);
  let data = normalizeChat(await complete({ system, messages, schema, name: "reply" }));
  if (!data.reply_en) data = normalizeChat(await complete({ system, messages, schema, name: "reply" })); // 空なら1回だけやり直す
  if (!data.reply_en) throw new HttpError(502, "AIの応答が空でした。もう一度話しかけてください。");
  // ずんだもんのカナ: LLM が書かなかった（または書けなかった）ときは発音辞書から作る
  if (zunda && !data.reply_kana) data.reply_kana = await g2pKana(data.reply_en).catch(() => "");
  return data;
}

export async function handleWord(body) {
  const word = String(body.word || "").trim().slice(0, 80);
  if (!word) throw new HttpError(400, "word is required");
  const context = String(body.context || "").slice(0, 500);
  const d = await complete({
    system:
      "You are a concise English-Japanese dictionary for Japanese learners. Given a word and the sentence it appeared in, explain the meaning used in that context. term = dictionary (base) form. part_of_speech in Japanese (例: 動詞, 名詞, 形容詞, 熟語). Examples should be short and everyday. Answer in JSON.",
    messages: [{ role: "user", content: `Word: ${word}\nContext: ${context}` }],
    schema: WORD_SCHEMA,
    name: "word",
    maxTokens: 800,
  });
  return { term: str(d.term, 80) || word, part_of_speech: str(d.part_of_speech, 40), meaning_ja: str(d.meaning_ja, 300), example_en: str(d.example_en, 300), example_ja: str(d.example_ja, 300) };
}
