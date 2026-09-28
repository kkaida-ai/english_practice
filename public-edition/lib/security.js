// 公開用の安全対策: 合言葉ログイン・回数制限・セキュリティヘッダー

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HttpError } from "./errors.js";

// ---------------------------------------------------------------- 合言葉とセッション

let DATA_DIR = "data";
let SECRET = "";
let PASSWORD = "";

const WORDS = ["zunda", "mochi", "matcha", "sakura", "panda", "sushi", "tempura", "kitten", "cookie", "rainbow", "ocean", "maple", "melon", "peach", "lemon", "tiger"];

function readOrCreate(file, make) {
  const p = path.join(DATA_DIR, file);
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  const v = make();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(p, v, { mode: 0o600 });
  return v;
}

export function initSecurity(dataDir) {
  DATA_DIR = dataDir;
  SECRET = readOrCreate("session-secret.txt", () => crypto.randomBytes(32).toString("hex"));
  // APP_PASSWORD 未設定なら覚えやすい合言葉を作って保存（例: mochi-tiger-4821）
  PASSWORD =
    process.env.APP_PASSWORD ||
    readOrCreate("password.txt", () => {
      const pick = () => WORDS[crypto.randomInt(WORDS.length)];
      return `${pick()}-${pick()}-${crypto.randomInt(1000, 10000)}`;
    });
  return PASSWORD;
}

// 合言葉を変えると、以前のログインは全部無効になる
const passwordTag = () => crypto.createHash("sha256").update(PASSWORD).digest("hex").slice(0, 16);
const sign = (issued) => crypto.createHmac("sha256", SECRET).update(`${issued}:${passwordTag()}`).digest("base64url");
const SESSION_DAYS = 30;

function makeSession() {
  const issued = Date.now().toString(36);
  return `${issued}.${sign(issued)}`;
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isLoggedIn(req) {
  const v = cookies(req).ek_session;
  if (!v) return false;
  const [issued, sig] = v.split(".");
  if (!issued || !sig) return false;
  const expected = sign(issued);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return Date.now() - parseInt(issued, 36) < SESSION_DAYS * 86400_000;
}

function sameText(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// 総当たり対策: 1人（IP）15分に10回まで、全体で1時間に200回まで失敗できる
const loginFails = new Map();
let globalFails = [];

export function login(req, res, body) {
  const ip = clientIp(req);
  const now = Date.now();
  const mine = (loginFails.get(ip) || []).filter((t) => now - t < 15 * 60_000);
  globalFails = globalFails.filter((t) => now - t < 3600_000);
  if (mine.length >= 10 || globalFails.length >= 200)
    throw new HttpError(429, "合言葉の入力が多すぎます。しばらく待ってから試してください。");
  if (!sameText(String(body.password || "").trim().toLowerCase(), PASSWORD.toLowerCase())) {
    mine.push(now);
    loginFails.set(ip, mine);
    globalFails.push(now);
    throw new HttpError(401, "合言葉が違います。");
  }
  loginFails.delete(ip);
  const secure = isHttps(req) ? "; Secure" : "";
  res.setHeader("Set-Cookie", `ek_session=${makeSession()}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${secure}`);
  return { ok: true };
}

export function logout(res) {
  res.setHeader("Set-Cookie", "ek_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
  return { ok: true };
}

// ---------------------------------------------------------------- 利用者の識別

// トンネル（cloudflared）経由のアクセスは、この PC 内（127.0.0.1）から届く。
// 本当の相手は Cloudflare が付ける CF-Connecting-IP で判断する（この PC 内から来た場合だけ信用する）
function fromLocalProxy(req) {
  const a = req.socket.remoteAddress || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

export function clientIp(req) {
  if (fromLocalProxy(req)) {
    const cf = req.headers["cf-connecting-ip"];
    if (cf) return String(cf).trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function isHttps(req) {
  return fromLocalProxy(req) && (req.headers["x-forwarded-proto"] === "https" || !!req.headers["cf-connecting-ip"]);
}

// ---------------------------------------------------------------- 回数制限

// Groq の無料枠（会話 1日1,000回・1分30回）を全員で使い切らないよう、1人あたりと全体に上限を設ける
const LIMITS = {
  chat: { perMin: 12, perDay: 300 }, // 会話と単語調べ
  tts: { perMin: 60, perDay: 3000 },
  stt: { perMin: 15, perDay: 500 },
};
const GLOBAL_CHAT_PER_DAY = Number(process.env.DAILY_CHAT_LIMIT || 900);
const GLOBAL_CHAT_PER_MIN = 25;
const hits = new Map(); // `${kind}:${ip}` -> timestamps
let globalChat = [];

export function rateLimit(req, kind) {
  const now = Date.now();
  const key = `${kind}:${clientIp(req)}`;
  const list = (hits.get(key) || []).filter((t) => now - t < 86400_000);
  const lim = LIMITS[kind];
  if (list.filter((t) => now - t < 60_000).length >= lim.perMin) throw new HttpError(429, "少し速すぎます。ひと呼吸おいてから話しかけてください。");
  if (list.length >= lim.perDay) throw new HttpError(429, "今日の利用回数の上限に達しました。また明日どうぞ。");
  if (kind === "chat") {
    globalChat = globalChat.filter((t) => now - t < 86400_000);
    if (globalChat.filter((t) => now - t < 60_000).length >= GLOBAL_CHAT_PER_MIN) throw new HttpError(429, "混み合っています。少し待ってから話しかけてください。");
    if (globalChat.length >= GLOBAL_CHAT_PER_DAY) throw new HttpError(429, "今日の全体の利用上限に達しました。また明日どうぞ。");
    globalChat.push(now);
  }
  list.push(now);
  hits.set(key, list);
}

// 古い記録を定期的に掃除（メモリを増やし続けない）
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) {
    const kept = v.filter((t) => now - t < 86400_000);
    kept.length ? hits.set(k, kept) : hits.delete(k);
  }
  for (const [k, v] of loginFails) {
    const kept = v.filter((t) => now - t < 15 * 60_000);
    kept.length ? loginFails.set(k, kept) : loginFails.delete(k);
  }
}, 10 * 60_000).unref();

// ---------------------------------------------------------------- セキュリティヘッダー

export function securityHeaders(res) {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "microphone=(self), camera=(), geolocation=()");
}
