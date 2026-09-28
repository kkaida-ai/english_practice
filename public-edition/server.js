// しゃべって英会話（公開版）- サーバー
//   npm start       : このPCだけで使う  http://localhost:3000
//   npm run public  : Cloudflare のトンネルで公開URLを発行（合言葉を知っている人だけ使える）
//
// - 会話AI  : Groq の無料 LLM（キーがなければ PC 内の Ollama）      → lib/llm.js
// - 声      : ずんだもん（VOICEVOX）/ リリー・Emma・Ken（Kokoro）    → lib/speech.js
// - 音声認識: PC の Whisper（なければ Groq の Whisper）              → lib/speech.js
// - 安全対策: 合言葉ログイン・回数制限・セキュリティヘッダー         → lib/security.js
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HttpError } from "./lib/errors.js";
import { handleChat, handleWord, llmConfig } from "./lib/llm.js";
import { handleTts, handleStt, voicevoxStatus, kokoroStatus, VOICEVOX_URL, KOKORO_PORT } from "./lib/speech.js";
import { initSecurity, isLoggedIn, login, logout, rateLimit, securityHeaders } from "./lib/security.js";

const here = path.dirname(fileURLToPath(import.meta.url));
if (fs.existsSync(path.join(here, ".env"))) process.loadEnvFile(path.join(here, ".env"));

const PORT = Number(process.env.PORT || 3000);
const TUNNEL = process.argv.includes("--tunnel");
const PUBLIC_DIR = path.join(here, "public");
const PYTHON = process.env.EIKAIWA_PYTHON || "python3";
const PASSWORD = initSecurity(path.join(here, "data"));

// ---------------------------------------------------------------- HTTP

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

// ログインしなくても見られるもの（ログイン画面に必要な分だけ）
const OPEN_PATHS = new Set(["/login.html", "/login.js", "/style.css", "/icon.svg", "/manifest.json", "/api/login", "/healthz"]);

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 300_000) throw new HttpError(413, "Request too large");
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function serveStatic(pathname, res) {
  if (pathname === "/") pathname = "/index.html";
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: "Bad path" });
  }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile())
    return sendJson(res, 404, { error: "Not found" });
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}

function errorResponse(err) {
  if (err instanceof HttpError) return [err.status, err.message];
  return [500, "サーバーでエラーが起きました。もう一度試してください。"];
}

async function handler(req, res) {
  securityHeaders(res);
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    if (!OPEN_PATHS.has(p) && !isLoggedIn(req)) {
      if (p.startsWith("/api/")) return sendJson(res, 401, { error: "合言葉を入力してください。", login: true });
      res.writeHead(302, { Location: "/login.html" });
      return res.end();
    }
    if (req.method === "GET" && p === "/healthz") return sendJson(res, 200, { ok: true });
    if (req.method === "POST" && p === "/api/login") return sendJson(res, 200, login(req, res, await readJson(req)));
    if (req.method === "POST" && p === "/api/logout") return sendJson(res, 200, logout(res));
    if (req.method === "POST" && p === "/api/chat") {
      rateLimit(req, "chat");
      return sendJson(res, 200, await handleChat(await readJson(req)));
    }
    if (req.method === "POST" && p === "/api/word") {
      rateLimit(req, "chat");
      return sendJson(res, 200, await handleWord(await readJson(req)));
    }
    if (req.method === "POST" && p === "/api/tts") {
      rateLimit(req, "tts");
      return sendJson(res, 200, await handleTts(await readJson(req)));
    }
    if (req.method === "POST" && p === "/api/stt") {
      rateLimit(req, "stt");
      return sendJson(res, 200, await handleStt(req, url));
    }
    if (req.method === "GET" && p === "/api/status") {
      const [vv, kk] = await Promise.all([voicevoxStatus(), kokoroStatus()]);
      return sendJson(res, 200, { model: llmConfig().label, voicevox: vv, kokoro: kk });
    }
    if (req.method === "GET") return serveStatic(p, res);
    sendJson(res, 405, { error: "Method not allowed" });
  } catch (err) {
    const [status, message] = errorResponse(err);
    if (status >= 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: message });
  }
}

// ---------------------------------------------------------------- 音声エンジンの自動起動

const children = [];

function findVoicevoxEngine() {
  if (process.env.VOICEVOX_ENGINE_PATH) return process.env.VOICEVOX_ENGINE_PATH;
  const home = os.homedir();
  return (
    [
      path.join(home, "Applications/voicevox_engine/macos-arm64/run"),
      path.join(home, "Applications/voicevox_engine/macos-x64/run"),
      "/Applications/VOICEVOX.app/Contents/Resources/vv-engine/run",
      path.join(home, "Applications/VOICEVOX.app/Contents/Resources/vv-engine/run"),
    ].find((c) => fs.existsSync(c)) || null
  );
}

async function waitFor(check, seconds) {
  for (let i = 0; i < seconds; i++) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function ensureVoicevox() {
  if ((await voicevoxStatus()).available) return;
  const bin = findVoicevoxEngine();
  if (!bin) return;
  console.log("  VOICEVOX を起動中…");
  const port = new URL(VOICEVOX_URL).port || "50021";
  children.push(spawn(bin, ["--host", "127.0.0.1", "--port", port], { cwd: path.dirname(bin), stdio: "ignore" }));
  await waitFor(async () => (await voicevoxStatus()).available, 60);
}

async function ensureSpeechServer() {
  if ((await kokoroStatus()).available) return;
  if (spawnSync(PYTHON, ["-c", "import kokoro, soundfile"]).status !== 0) return;
  console.log("  音声エンジン（Kokoro / Whisper）を起動中…");
  children.push(spawn(PYTHON, [path.join(here, "tts/speech_server.py"), "--port", String(KOKORO_PORT)], { stdio: "ignore" }));
  await waitFor(async () => (await kokoroStatus()).available, 180);
}

// ---------------------------------------------------------------- 公開トンネル（Cloudflare Quick Tunnel・無料）

function startTunnel(port) {
  return new Promise((resolve) => {
    const bin = process.env.CLOUDFLARED_PATH || "cloudflared";
    const cf = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(cf);
    let done = false;
    const onData = (d) => {
      const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !done) {
        done = true;
        resolve(m[0]);
      }
    };
    cf.stdout.on("data", onData);
    cf.stderr.on("data", onData);
    cf.on("error", () => !done && ((done = true), resolve(null)));
    cf.on("exit", (code) => {
      if (!done) {
        done = true;
        resolve(null);
      } else console.error(`\n⚠ 公開トンネルが終了しました（code ${code}）。npm run public で起動し直してください。`);
    });
    setTimeout(() => !done && ((done = true), resolve(null)), 60_000);
  });
}

function shutdown() {
  for (const c of children) c.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ---------------------------------------------------------------- 起動

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const attempt = (p, left) => {
      const onListening = () => {
        server.off("error", onError);
        resolve(p);
      };
      const onError = (e) => {
        server.off("listening", onListening);
        if (e.code === "EADDRINUSE" && left > 0) {
          console.log(`  ⚠ ポート ${p} は使用中です → ${p + 1} を使います`);
          attempt(p + 1, left - 1);
        } else reject(e);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(p, "127.0.0.1"); // 外からはトンネル経由でしか届かないようにする
    };
    attempt(port, 20);
  });
}

async function main() {
  const port = await listen(http.createServer(handler), PORT);
  console.log(`しゃべって英会話（公開版）: http://localhost:${port}`);
  const llm = llmConfig();
  console.log(`  会話AI:   ${llm.label}${!llm.key && llm.label.startsWith("Ollama") ? "  ← GROQ_API_KEY を .env に設定すると高品質・高速になります" : ""}`);
  await Promise.all([ensureVoicevox(), ensureSpeechServer()]);
  const [vv, kk] = await Promise.all([voicevoxStatus(), kokoroStatus()]);
  console.log(`  ずんだもん: ${vv.available ? `OK（VOICEVOX v${vv.version}）` : "✕ VOICEVOX が見つかりません"}`);
  console.log(`  Kokoro:   ${kk.available ? "OK（リリー・Emma・Ken）" : "✕ 使えません（pip install kokoro soundfile）"}`);
  console.log(`  音声認識: ${kk.stt ? "OK（PC の Whisper）" : llm.isGroq ? "Groq の Whisper" : "✕ 使えません（キーボード入力のみ）"}`);
  console.log(`  合言葉:   ${PASSWORD}   （変えるには .env の APP_PASSWORD）`);

  if (!TUNNEL) {
    console.log("\n  公開URLを発行するには: npm run public");
  } else {
    console.log("\n  公開トンネルを準備中…");
    const publicUrl = await startTunnel(port);
    if (!publicUrl) {
      console.error("  ⚠ 公開URLを発行できませんでした（cloudflared が必要: brew install cloudflared）");
    } else {
      console.log(`\n🌐 公開URL（スマホでも開けます）: ${publicUrl}`);
      console.log(`   合言葉: ${PASSWORD}`);
      const QRCode = (await import("qrcode")).default;
      console.log(await QRCode.toString(publicUrl, { type: "terminal", small: true }));
      console.log("   ※ URL は起動するたびに変わります。このPCとこの画面を起動している間だけ使えます。");
    }
  }
  console.log("\n  終了するには Ctrl+C");
}

main().catch((e) => {
  console.error("起動できませんでした:", e.message);
  shutdown();
});
