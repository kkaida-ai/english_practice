import { CHARACTERS, CharacterView, characterSVG } from "./characters.js";
import { Listener, Recorder, Speaker, recognitionSupported, recordingSupported, unlockAudio, pronounce, setPronounceOptions } from "./voice.js";
import * as store from "./store.js";

const S = store.settings;

// 合言葉の期限切れなどでログインが必要になったら、ログイン画面へ
const rawFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await rawFetch(...args);
  if (res.status === 401) {
    location.href = "/login.html";
    throw new Error("ログインが必要です");
  }
  return res;
};
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const character = new CharacterView($("#character"));
const speaker = new Speaker(character);
let voicevoxOK = false;
let kokoroOK = false;
const KOKORO_VOICES = {
  female: { af_heart: "Heart（あたたかい）", af_bella: "Bella（明るい）", af_sarah: "Sarah（落ち着いた）", af_nicole: "Nicole（やさしい・ささやき）", af_sky: "Sky（さわやか）" },
  male: { am_michael: "Michael（落ち着いた）", am_echo: "Echo（やわらかい）", am_puck: "Puck（明るい）", am_fenrir: "Fenrir（力強い）" },
};
const kokoroVoice = (key = S.character) => S.kokoroVoices?.[key] || { lily: "af_heart", female: "af_bella", male: "am_michael" }[key] || "af_heart";
let busy = false; // AI 応答待ち
let speakLang = "en-US";

// ================================================================ 音声認識

// 認識結果の受け取り先（会話 or 単語テスト）を切り替えられるようにする
let recHandler = null;
let whisperOK = false; // PC で Whisper（日本人の英語に強い音声認識）が使えるか
const recCallbacks = {
  onInterim: (t) => recHandler?.interim?.(t),
  onFinal: (t) => recHandler?.final?.(t),
  onStateChange: (on) => recHandler?.state?.(on),
  onTranscribing: (on) => recHandler?.transcribing?.(on),
  onError: (err) => {
    const msg = { "not-allowed": S.handsFree ? "マイクを自動でONにできませんでした。マイクボタンをタップしてください（スマホでは自動ONが制限されることがあります）。" : "マイクの使用が許可されていません。ブラウザの設定を確認してください。", network: "音声認識サービスに接続できません。", "audio-capture": "マイクが見つかりません。" }[err];
    toast(msg || `音声認識エラー: ${err}`);
  },
};
const browserRec = new Listener(recCallbacks);
const whisperRec = new Recorder(recCallbacks);
// 設定と環境に応じて、Whisper（録音→PCで文字起こし）かブラウザの音声認識を使う
const useWhisper = () => whisperOK && recordingSupported && S.sttEngine !== "browser";
const activeRec = () => (useWhisper() ? whisperRec : browserRec);
const listener = {
  get active() { return browserRec.active || whisperRec.active; },
  set silenceMs(ms) { browserRec.silenceMs = whisperRec.silenceMs = ms; },
  set context(t) { whisperRec.context = t; },
  start: (lang) => activeRec().start(lang),
  stop: () => { browserRec.stop(); whisperRec.stop(); },
  cancel: () => { browserRec.cancel(); whisperRec.cancel(); },
};

const chatRec = {
  interim(t) {
    const el = $("#interim");
    el.hidden = !t;
    el.textContent = t;
  },
  final(t) {
    $("#interim").hidden = true;
    if (!t) {
      setStatus("聞き取れませんでした。もう一度どうぞ");
      character.setState("idle");
      return;
    }
    const lang = speakLang;
    if (speakLang === "ja-JP") setLang("en-US"); // 日本語は1回ごと
    sendUser(t, lang);
  },
  transcribing(on) {
    if (on) {
      character.setState("thinking");
      setStatus("聞き取っています…");
    }
  },
  state(on) {
    $("#micBtn").classList.toggle("on", on);
    if (on) {
      character.setState("listening");
      setStatus(speakLang === "ja-JP" ? "日本語でどうぞ（英語での言い方を教えます）" : "聞いています… 話し終わると自動で送信します");
    } else if (!busy && !speaker.speaking) {
      character.setState("idle");
    }
  },
};

function startListening() {
  if (!useWhisper() && !recognitionSupported)
    return toast("このブラウザは音声認識に対応していません。Chrome か Edge をお使いください（キーボード入力は使えます）。");
  recHandler = chatRec;
  listener.silenceMs = S.silenceSec * 1000;
  // 直前の AI の質問を認識のヒントにする（答えの単語を聞き取りやすくなる）
  listener.context = [...store.conversation()].reverse().find((it) => it.role === "assistant")?.text || "";
  listener.start(speakLang);
}

function setLang(lang) {
  speakLang = lang;
  const b = $("#langBtn");
  b.textContent = lang === "ja-JP" ? "JA" : "EN";
  b.classList.toggle("ja", lang === "ja-JP");
}

// ================================================================ 会話

function history() {
  return store.conversation().map((it) => ({ role: it.role, text: it.text }));
}

async function requestReply(text) {
  busy = true;
  character.setState("thinking");
  setStatus(`${CHARACTERS[S.character].name}が考え中…`);
  $("#micBtn").disabled = true;
  try {
    const prior = history();
    if (text) prior.pop(); // 今回の発言は text として別送
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        history: prior,
        text,
        level: S.level,
        persona: S.character,
        correction: S.correction,
        reviewWords: S.useReviewWords ? store.wordsForConversation() : [],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "エラーが発生しました");
    return data;
  } finally {
    busy = false;
    $("#micBtn").disabled = false;
  }
}

async function sendUser(text, lang = "en-US") {
  unlockAudio();
  speaker.stop();
  const item = { role: "user", text, lang, id: crypto.randomUUID() };
  store.pushItem(item);
  if (lang !== "ja-JP") store.recordUtterance(text);
  renderLog();
  hideSuggestions();
  try {
    const data = await requestReply(text);
    if (data.correction?.has_issue) {
      item.correction = data.correction;
      store.updateItems();
    }
    addAi(data);
  } catch (e) {
    character.setState("idle");
    setStatus("うまく届きませんでした");
    toast(e.message);
    item.failed = true;
    store.updateItems();
    renderLog();
  }
}

async function startConversation() {
  unlockAudio();
  try {
    addAi(await requestReply(""));
  } catch (e) {
    character.setState("idle");
    setStatus("うまく始められませんでした");
    toast(e.message);
  }
}

function addAi(data) {
  const item = {
    role: "assistant",
    id: crypto.randomUUID(),
    character: S.character,
    text: data.reply_en,
    ja: data.reply_ja,
    kana: data.reply_kana,
    vocab: data.vocab || [],
    suggestions: data.suggestions || [],
  };
  store.markEncountered(item.text);
  store.pushItem(item);
  renderLog();
  renderStats();
  showSuggestions(item.suggestions);
  speakItem(item).then(() => {
    if (S.handsFree && !busy && !listener.active) startListening();
  });
}

async function speakItem(item) {
  character.setState("speaking");
  setStatus(`${CHARACTERS[S.character].name}が話しています（マイクをタップで中断）`);
  try {
    const c = CHARACTERS[S.character];
    if (c.engine === "voicevox" && voicevoxOK && item.kana) {
      await speaker.speakTts(item.kana, { engine: "voicevox", speaker: Number(S.zundaSpeaker), speed: S.speed });
    } else if (c.engine === "kokoro" && kokoroOK) {
      await speaker.speakTts(item.text, { engine: "kokoro", voice: kokoroVoice(), speed: S.speed });
    } else {
      toast(`${c.name}の声のエンジンが今は使えません（英文と訳は画面で読めます）`);
    }
  } catch (e) {
    toast(`音声の再生に失敗しました: ${e.message}`);
  } finally {
    if (!listener.active && !busy) {
      character.setState("idle");
      setStatus("マイクをタップして答えてね");
    }
  }
}

// ================================================================ 表示

function tokenizeEnglish(text) {
  // 単語をクリック可能な span に分割
  const saved = new Set(store.allWords().map((w) => w.term.toLowerCase()));
  return esc(text).replace(/[A-Za-z][A-Za-z'’-]*/g, (w) => {
    const cls = saved.has(w.toLowerCase()) ? "w saved" : "w";
    return `<span class="${cls}" data-w="${w}">${w}</span>`;
  });
}

function renderLog() {
  const log = $("#log");
  const items = store.conversation();
  if (!items.length) {
    log.innerHTML = `<div class="empty">
      <p>レッスンはありません。好きなことを自由に話そう！<br>
      英語が出てこないときは <b>EN→JA</b> ボタンで日本語でもOK。<br>
      知らない単語はタップすると意味がわかります。</p>
      <button class="btn primary" id="startBtn">会話をはじめる</button>
    </div>`;
    $("#startBtn").onclick = startConversation;
    return;
  }
  log.innerHTML = items.map(renderItem).join("");
  log.scrollTop = log.scrollHeight;
}

function renderItem(it) {
  if (it.role === "user") {
    const hide = !S.showMine && it.lang !== "ja-JP";
    const corr = it.correction
      ? `<div class="correction">
          <b>${it.lang === "ja-JP" ? "英語ではこう言えます" : "より自然な言い方"}</b>
          <div class="fix">${tokenizeWrap(it.correction.corrected)}</div>
          <div>${esc(it.correction.explanation_ja)}</div>
          <button class="icon-btn" data-act="say" data-text="${esc(it.correction.corrected)}">🔊 発音を聞く</button>
        </div>`
      : "";
    return `<div class="msg user" data-id="${it.id}">
      <div class="who">あなた${it.lang === "ja-JP" ? "（日本語）" : ""}${it.failed ? " ・送信失敗" : ""}</div>
      <div class="bubble ${hide ? "hidden-text" : ""}" data-reveal>${esc(it.text)}</div>
      ${corr}
    </div>`;
  }
  const c = CHARACTERS[it.character] || CHARACTERS.zundamon;
  const vocab = (it.vocab || [])
    .map((v, i) => {
      const added = store.findWord(v.term);
      return `<button class="chip ${added ? "added" : ""}" data-act="add-vocab" data-i="${i}">${added ? "✓" : "＋"} ${esc(v.term)}：${esc(v.meaning_ja)}</button>`;
    })
    .join("");
  return `<div class="msg ai" data-id="${it.id}">
    <div class="who">${esc(c.name)}</div>
    <div class="bubble">
      <div class="en ${S.showEnglish ? "" : "hidden-text"}" data-reveal>${tokenizeEnglish(it.text)}</div>
      ${S.showJapanese ? `<div class="ja">${esc(it.ja)}</div>` : ""}
    </div>
    <div class="msg-tools">
      <button class="icon-btn" data-act="replay">🔁 もう一度</button>
      <button class="icon-btn" data-act="slow">🐢 ゆっくり</button>
      ${S.showJapanese ? "" : `<button class="icon-btn" data-act="show-ja">訳</button>`}
      ${!S.showEnglish ? `<span class="reveal-hint">英文をタップで表示</span>` : ""}
    </div>
    ${vocab ? `<div class="vocab">${vocab}</div>` : ""}
  </div>`;
}

function tokenizeWrap(text) {
  return `<span class="en">${tokenizeEnglish(text)}</span>`;
}

function showSuggestions(list) {
  if (!list?.length) return hideSuggestions();
  $("#suggest").hidden = false;
  $("#suggestList").hidden = true;
  $("#hintBtn").textContent = "💡 返答のヒントを見る";
  $("#suggestList").innerHTML = list
    .map((s) => `<button class="suggest-item" data-text="${esc(s.en)}">${esc(s.en)}<small>${esc(s.ja)}</small></button>`)
    .join("");
}
function hideSuggestions() {
  $("#suggest").hidden = true;
}

function setStatus(t) {
  $("#status").textContent = t;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

function renderStats() {
  const s = store.getStats();
  $("#stats").innerHTML = `<span>🔥 連続 ${s.streak}日</span><span>🗣 発話 ${s.utterances}回</span><span>📚 単語 ${s.words}語（習得 ${s.mastered}）</span>`;
  const b = $("#dueBadge");
  b.hidden = !s.due;
  b.textContent = s.due;
}

function applyToggles() {
  document.querySelectorAll(".toggle").forEach((b) => b.setAttribute("aria-pressed", String(!!S[b.dataset.key])));
}

function mountCharacter() {
  const c = CHARACTERS[S.character];
  // 発音ボタンは Kokoro で（キャラクターが Kokoro ならその声、それ以外は Heart）
  setPronounceOptions({ kokoro: kokoroOK, voice: c.engine === "kokoro" ? kokoroVoice() : "af_heart" });
  character.mount(S.character);
  $("#charName").textContent = c.name;
  $("#creditText").textContent = c.engine === "voicevox" ? "VOICEVOX:ずんだもん" : `Kokoro TTS（${kokoroVoice()}）`;
}

// ================================================================ 単語ポップアップ

const lookupCache = new Map();

async function openWordPopup(el) {
  const word = el.dataset.w.replace(/[’]/g, "'");
  const pop = $("#wordPop");
  const rect = el.getBoundingClientRect();
  pop.style.left = `${Math.min(Math.max(rect.left, 16), window.innerWidth - Math.min(320, window.innerWidth - 32) - 16)}px`;
  const below = rect.bottom + 8;
  pop.style.top = below + 200 > window.innerHeight ? `${Math.max(rect.top - 208, 8)}px` : `${below}px`;
  pop.hidden = false;

  const saved = store.findWord(word);
  let info = saved;
  if (!info) {
    pop.innerHTML = `<div class="term">${esc(word)}</div><div class="ex">調べています…</div>`;
    const key = word.toLowerCase();
    try {
      info = lookupCache.get(key);
      if (!info) {
        const context = el.closest(".en")?.textContent || "";
        const res = await fetch("/api/word", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ word, context }),
        });
        info = await res.json();
        if (!res.ok) throw new Error(info.error);
        lookupCache.set(key, info);
      }
    } catch (e) {
      pop.innerHTML = `<div class="term">${esc(word)}</div><div class="ex">意味を取得できませんでした: ${esc(e.message)}</div>`;
      return;
    }
    if (pop.hidden) return;
  }
  const isSaved = !!store.findWord(info.term) || !!saved;
  pop.innerHTML = `
    <div><span class="term">${esc(info.term)}</span><span class="pos">${esc(info.part_of_speech || "")}</span></div>
    <div>${esc(info.meaning_ja)}</div>
    ${info.example_en ? `<div class="ex">${esc(info.example_en)}<br>${esc(info.example_ja)}</div>` : ""}
    <div class="actions">
      <button class="btn small" data-pop="say">🔊 発音</button>
      <button class="btn small ${isSaved ? "" : "primary"}" data-pop="add" ${isSaved ? "disabled" : ""}>${isSaved ? "✓ 単語帳に登録済み" : "＋ 単語帳に追加"}</button>
    </div>`;
  pop.querySelector('[data-pop="say"]').onclick = () => pronounce(info.term);
  pop.querySelector('[data-pop="add"]').onclick = (ev) => {
    if (store.addWord(info)) {
      toast(`「${info.term}」を単語帳に追加しました`);
      ev.target.textContent = "✓ 単語帳に登録済み";
      ev.target.disabled = true;
      ev.target.classList.remove("primary");
      renderStats();
      renderLog();
    }
  };
}

document.addEventListener("click", (e) => {
  const pop = $("#wordPop");
  if (!pop.hidden && !pop.contains(e.target) && !e.target.closest(".w")) pop.hidden = true;
});

// ================================================================ 会話ログのクリック

$("#log").addEventListener("click", (e) => {
  const reveal = e.target.closest("[data-reveal].hidden-text");
  if (reveal) {
    reveal.classList.remove("hidden-text");
    return;
  }
  const w = e.target.closest(".w");
  if (w) return openWordPopup(w);

  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const msgEl = btn.closest(".msg");
  const item = store.conversation().find((it) => it.id === msgEl?.dataset.id);
  switch (btn.dataset.act) {
    case "replay":
      unlockAudio();
      speakItem(item);
      break;
    case "slow": {
      unlockAudio();
      const prev = S.speed;
      S.speed = Math.max(0.6, prev * 0.75);
      speakItem(item).finally(() => (S.speed = prev));
      break;
    }
    case "show-ja": {
      const bubble = msgEl.querySelector(".bubble");
      if (!bubble.querySelector(".ja")) bubble.insertAdjacentHTML("beforeend", `<div class="ja">${esc(item.ja)}</div>`);
      btn.remove();
      break;
    }
    case "add-vocab": {
      const v = item.vocab[Number(btn.dataset.i)];
      if (store.addWord(v)) {
        toast(`「${v.term}」を単語帳に追加しました`);
        btn.classList.add("added");
        btn.textContent = `✓ ${v.term}：${v.meaning_ja}`;
        renderStats();
      }
      break;
    }
    case "say":
      pronounce(btn.dataset.text);
      break;
  }
});

// ================================================================ 操作

$("#micBtn").onclick = () => {
  unlockAudio();
  if (listener.active) return listener.stop();
  if (speaker.speaking) {
    speaker.stop();
  }
  if (busy) return;
  if (!store.conversation().length) return startConversation();
  startListening();
};

$("#langBtn").onclick = () => setLang(speakLang === "en-US" ? "ja-JP" : "en-US");

$("#textForm").onsubmit = (e) => {
  e.preventDefault();
  const input = $("#textInput");
  const t = input.value.trim();
  if (!t || busy) return;
  input.value = "";
  const isJa = /[぀-ヿ一-龯]/.test(t);
  if (!store.conversation().length) {
    // 最初の発話がユーザーからでもOK
  }
  sendUser(t, isJa ? "ja-JP" : "en-US");
};

$("#hintBtn").onclick = () => {
  const list = $("#suggestList");
  list.hidden = !list.hidden;
  $("#hintBtn").textContent = list.hidden ? "💡 返答のヒントを見る" : "💡 ヒントを閉じる";
};
$("#suggestList").addEventListener("click", (e) => {
  const b = e.target.closest(".suggest-item");
  if (b) pronounce(b.dataset.text); // ヒントは聞いてマネして言う
});

document.querySelectorAll(".toggle").forEach((b) => {
  b.onclick = () => {
    S[b.dataset.key] = !S[b.dataset.key];
    store.saveSettings();
    applyToggles();
    renderLog();
  };
});

$("#newBtn").onclick = () => {
  speaker.stop();
  listener.cancel();
  store.clearConversation();
  hideSuggestions();
  renderLog();
  setStatus("マイクをタップして話しかけてね");
  character.setState("idle");
};

// スペースキーでマイク（入力欄にフォーカスがないとき）
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !e.repeat && !["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(document.activeElement.tagName) && !document.querySelector("dialog[open]")) {
    e.preventDefault();
    $("#micBtn").click();
  }
});

// ================================================================ 設定ダイアログ

function renderVoiceSelect() {
  const c = CHARACTERS[S.character];
  const isZunda = c.engine === "voicevox";
  $("#zundaRow").hidden = !isZunda;
  $("#voiceRow").hidden = isZunda;
  const note = $("#voicevoxNote");
  if (isZunda) {
    note.className = voicevoxOK ? "note" : "note warn";
    note.textContent = voicevoxOK
      ? "ずんだもんは英語の強勢を付けたカナ読みで話します（ネイティブの発音は 🔊 やリリーたちで確認できます）。"
      : "ずんだもんの声（VOICEVOX）が今は使えません。";
    return;
  }
  const list = KOKORO_VOICES[c.gender === "male" ? "male" : "female"];
  $("#voiceSelect").innerHTML = Object.entries(list).map(([k, v]) => `<option value="${k}" ${kokoroVoice() === k ? "selected" : ""}>${esc(v)}</option>`).join("");
  note.className = kokoroOK ? "note" : "note warn";
  note.textContent = kokoroOK ? `${c.name}は英語ネイティブの声（Kokoro）で話します。` : "英語の声（Kokoro）が今は使えません。";
}

function renderCharChoices() {
  $("#charChoices").innerHTML = Object.entries(CHARACTERS)
    .map(
      ([k, c]) => `<button type="button" class="char-choice" data-char="${k}" aria-pressed="${S.character === k}">
        <div class="mini">${characterSVG(k)}</div>${esc(c.name)}
        <small>${{ zundamon: "VOICEVOX", lily: "英語ネイティブ", female: "女性・英語ネイティブ", male: "男性・英語ネイティブ" }[k]}</small></button>`,
    )
    .join("");
}

$("#charChoices").addEventListener("click", (e) => {
  const b = e.target.closest("[data-char]");
  if (!b) return;
  S.character = b.dataset.char;
  store.saveSettings();
  renderCharChoices();
  renderVoiceSelect();
  mountCharacter();
});

$("#settingsBtn").onclick = () => {
  renderCharChoices();
  renderVoiceSelect();
  $("#zundaSpeaker").value = String(S.zundaSpeaker);
  $("#speed").value = S.speed;
  $("#speedOut").textContent = `${Number(S.speed).toFixed(2)}x`;
  $("#level").value = S.level;
  $("#correction").checked = S.correction;
  $("#useReviewWords").checked = S.useReviewWords;
  $("#handsFree").checked = S.handsFree;
  $("#silenceSec").value = S.silenceSec;
  $("#sttEngine").value = S.sttEngine || "whisper";
  $("#sttNote").textContent = whisperOK
    ? "Whisper: 日本人の英語（カタカナ発音）でも聞き取りやすく、文法の間違いもそのまま書き取るので添削が正確になります。"
    : "Whisper が使えないため、ブラウザの音声認識を使います。";
  $("#silenceOut").textContent = `${S.silenceSec}秒`;
  $("#settingsDlg").showModal();
};

$("#settingsDlg").addEventListener("input", (e) => {
  const t = e.target;
  switch (t.id) {
    case "zundaSpeaker": S.zundaSpeaker = Number(t.value); break;
    case "voiceSelect":
      S.kokoroVoices = { ...S.kokoroVoices, [S.character]: t.value };
      mountCharacter();
      break;
    case "speed": S.speed = Number(t.value); $("#speedOut").textContent = `${S.speed.toFixed(2)}x`; break;
    case "level": S.level = t.value; break;
    case "correction": S.correction = t.checked; break;
    case "useReviewWords": S.useReviewWords = t.checked; break;
    case "handsFree": S.handsFree = t.checked; break;
    case "sttEngine": S.sttEngine = t.value; break;
    case "silenceSec": S.silenceSec = Number(t.value); $("#silenceOut").textContent = `${S.silenceSec}秒`; break;
  }
  store.saveSettings();
});

$("#testVoice").onclick = () => {
  unlockAudio();
  const samples = {
    zundamon: { text: "Hi! I'm Zundamon. Let's talk in English!", kana: "ハ'イ！アイム/ズ'ンダモン。レ'ッツ/ト'オク/インイ'ングリッシュ！" },
    lily: { text: "Hi there! I'm Lily, Zundamon's best friend. Let's have fun talking in English!" },
    female: { text: "Hi! I'm Emma. Let's have a fun chat in English!" },
    male: { text: "Hey! I'm Ken. Let's have a fun chat in English!" },
  };
  speakItem(samples[S.character]);
};

// ================================================================ 単語帳ダイアログ

let wordsTab = "review";
let review = null; // { queue, index, mode, flipped, said }

$("#wordsBtn").onclick = () => {
  wordsTab = store.dueWords().length || !store.allWords().length ? "review" : "list";
  review = null;
  renderWords();
  $("#wordsDlg").showModal();
};
$("#wordsClose").onclick = () => {
  listener.cancel();
  $("#wordsDlg").close();
};
$("#wordsDlg").addEventListener("close", () => {
  listener.cancel();
  renderStats();
  renderLog();
});
document.querySelectorAll(".tab").forEach((t) => {
  t.onclick = () => {
    wordsTab = t.dataset.tab;
    review = null;
    renderWords();
  };
});

function levelBar(w) {
  return `<span class="level-bar" title="覚え度 ${w.box}/5">${[1, 2, 3, 4, 5].map((i) => `<i class="${w.box >= i ? "on" : ""}"></i>`).join("")}</span>`;
}

function renderWords() {
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === wordsTab)));
  if (wordsTab === "list") renderWordList();
  else renderReview();
}

function renderWordList(filter = "") {
  const body = $("#wordsBody");
  const all = store.allWords();
  if (!all.length) {
    body.innerHTML = `<div class="done">まだ単語がありません。<br>会話中の単語をタップするか、「＋」チップで追加しよう。</div>`;
    return;
  }
  const f = filter.toLowerCase();
  const list = all.filter((w) => !f || w.term.toLowerCase().includes(f) || w.meaning_ja.includes(filter));
  body.innerHTML = `
    <div class="word-tools"><input id="wordSearch" placeholder="検索（英語・日本語）" value="${esc(filter)}" /></div>
    <div class="word-list">${list
      .map(
        (w) => `<div class="word-row" data-id="${w.id}">
          <div><span class="t">${esc(w.term)}</span>${levelBar(w)}${w.encounters ? `<small class="note"> 会話で${w.encounters}回</small>` : ""}<div class="m">${esc(w.meaning_ja)}</div></div>
          <div class="ops"><button class="icon-btn" data-wact="say">🔊</button><button class="icon-btn" data-wact="del">削除</button></div>
          ${w.example_en ? `<div class="e">${esc(w.example_en)} / ${esc(w.example_ja)}</div>` : ""}
        </div>`,
      )
      .join("")}</div>`;
  const input = $("#wordSearch");
  input.oninput = () => {
    renderWordList(input.value);
    const again = $("#wordSearch");
    again.focus();
    again.setSelectionRange(again.value.length, again.value.length);
  };
  body.querySelector(".word-list").onclick = (e) => {
    const b = e.target.closest("[data-wact]");
    if (!b) return;
    const id = b.closest(".word-row").dataset.id;
    const w = all.find((x) => x.id === id);
    if (b.dataset.wact === "say") pronounce(w.term);
    if (b.dataset.wact === "del") {
      store.removeWord(id);
      renderWordList(input.value);
    }
  };
}

function renderReview() {
  const body = $("#wordsBody");
  if (!review) {
    const due = store.dueWords();
    const all = store.allWords();
    if (!all.length) {
      body.innerHTML = `<div class="done">まだ単語がありません。<br>会話中の単語をタップするか、「＋」チップで追加しよう。</div>`;
      return;
    }
    body.innerHTML = `<div class="review">
      <div class="done" style="padding:10px 0">${due.length ? `今日の復習: <b>${due.length}語</b>` : "今日の復習は完了！🎉<br>自由に練習することもできます。"}</div>
      <div class="review-mode">
        <button class="btn primary" data-mode="flash">英 → 日 カード</button>
        ${recognitionSupported || useWhisper() ? `<button class="btn primary" data-mode="speak">日 → 英 声で答える</button>` : ""}
      </div>
      ${due.length ? "" : `<small class="note">※ 復習予定前の練習も記録されます</small>`}
    </div>`;
    body.querySelectorAll("[data-mode]").forEach((b) => {
      b.onclick = () => {
        const queue = (due.length ? due : [...all].sort(() => Math.random() - 0.5)).slice(0, 20);
        review = { queue, index: 0, mode: b.dataset.mode, flipped: false, said: null, ok: 0 };
        renderReview();
      };
    });
    return;
  }

  const { queue, index, mode } = review;
  if (index >= queue.length) {
    body.innerHTML = `<div class="done">おつかれさま！ ${queue.length}語中 ${review.ok}語 正解<br><br><button class="btn primary" id="reviewAgain">戻る</button></div>`;
    $("#reviewAgain").onclick = () => { review = null; renderReview(); };
    renderStats();
    return;
  }
  const w = queue[index];
  let face;
  if (mode === "flash") {
    face = review.flipped
      ? `<div class="big">${esc(w.term)}</div><div>${esc(w.meaning_ja)}</div>${w.example_en ? `<div class="ex">${esc(w.example_en)}<br><span class="sub">${esc(w.example_ja)}</span></div>` : ""}`
      : `<div class="big">${esc(w.term)}</div><div class="sub">タップして意味を表示</div>`;
  } else {
    const said = review.said;
    const judged = said !== null;
    face = `<div class="sub">英語で言うと？</div><div class="big" style="font-size:22px">${esc(w.meaning_ja)}</div>
      ${w.example_ja ? `<div class="ex sub">例: ${esc(w.example_ja)}</div>` : ""}
      ${judged ? `<div class="said">あなた: ${esc(said || "（聞き取れず）")}</div>
        <div class="${review.autoOk ? "result-ok" : "result-ng"}">${review.autoOk ? "正解！" : "答え"}: ${esc(w.term)}</div>
        ${w.example_en ? `<div class="ex">${esc(w.example_en)}</div>` : ""}` : `<div class="sub">${review.listening ? "🎤 聞いています…" : "下のマイクを押して答えよう"}</div>`}`;
  }
  const showGrade = mode === "flash" ? review.flipped : review.said !== null;
  body.innerHTML = `<div class="review">
    <div class="progress">${index + 1} / ${queue.length}</div>
    <div class="card" id="card">${face}</div>
    ${
      showGrade
        ? `<div class="grade"><button class="btn" data-g="0">もう一回 😣</button><button class="btn primary" data-g="1">覚えた 😊</button></div>`
        : mode === "speak"
          ? `<div class="grade"><button class="btn primary" id="reviewMic">🎤 答える</button><button class="btn" id="reviewSkip">わからない</button></div>`
          : ""
    }
  </div>`;
  if (mode === "flash") {
    $("#card").onclick = () => {
      if (!review.flipped) {
        review.flipped = true;
        pronounce(w.term);
        renderReview();
      } else pronounce(w.term);
    };
  } else if (!showGrade) {
    $("#reviewMic").onclick = () => {
      recHandler = {
        interim: () => {},
        state: (on) => { review.listening = on; if (on) renderReview(); },
        final: (t) => {
          review.said = t;
          review.autoOk = matchesTerm(t, w.term);
          review.listening = false;
          pronounce(w.term);
          renderReview();
        },
      };
      listener.silenceMs = 1500;
      listener.context = ""; // 答えのヒントになるので渡さない
      listener.start("en-US");
    };
    $("#reviewSkip").onclick = () => { review.said = ""; review.autoOk = false; pronounce(w.term); renderReview(); };
  } else {
    $("#card").onclick = () => pronounce(w.term);
  }
  body.querySelectorAll("[data-g]").forEach((b) => {
    b.onclick = () => {
      const ok = b.dataset.g === "1";
      store.gradeWord(w.id, ok);
      if (ok) review.ok++;
      review.index++;
      review.flipped = false;
      review.said = null;
      renderReview();
    };
  });
}

function matchesTerm(said, term) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z' ]/g, " ").replace(/\s+/g, " ").trim();
  const s = ` ${norm(said)} `;
  const t = norm(term);
  if (s.includes(` ${t} `)) return true;
  // 語形変化をゆるく許容（語幹一致）
  const words = t.split(" ");
  return words.every((x) => s.split(" ").some((y) => y && (y.startsWith(x.slice(0, Math.max(3, x.length - 2))) )));
}

// ================================================================ ログアウト

$("#logoutBtn").onclick = async () => {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  location.href = "/login.html";
};

// ================================================================ 起動

async function init() {
  applyToggles();
  setLang("en-US");
  renderStats();
  renderLog();
  try {
    const st = await fetch("/api/status").then((r) => r.json());
    voicevoxOK = !!st.voicevox?.available;
    kokoroOK = !!st.kokoro?.available;
    whisperOK = !!st.kokoro?.stt;
    $("#aiLabel").textContent = st.model;
  } catch {}
  mountCharacter();
  if (!voicevoxOK && S.character === "zundamon") setStatus("VOICEVOX 未起動のためブラウザ音声で話します");
  if (!useWhisper() && !recognitionSupported) setStatus("このブラウザは音声認識非対応です（Chrome推奨）。キーボードで入力できます");
  const last = store.conversation().at(-1);
  if (last?.role === "assistant") showSuggestions(last.suggestions);
}

init();
