// ローカル保存（localStorage）: 設定・単語帳（間隔反復）・会話履歴・学習記録

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...fallback, ...JSON.parse(v) } : { ...fallback };
  } catch {
    return { ...fallback };
  }
}
function loadArray(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

// ---------------------------------------------------------------- 設定

const DEFAULT_SETTINGS = {
  character: "zundamon",
  zundaSpeaker: 3, // VOICEVOX: ずんだもん（ノーマル）
  // キャラクターごとの Kokoro の声
  kokoroVoices: { lily: "af_heart", female: "af_bella", male: "am_michael" },
  speed: 1,
  level: "intermediate",
  correction: true,
  showEnglish: true,
  showJapanese: false,
  showMine: true,
  handsFree: false,
  silenceSec: 1.5,
  sttEngine: "whisper", // whisper（録音→PCで文字起こし）/ browser
  useReviewWords: true,
};

export const settings = load("ek.settings", DEFAULT_SETTINGS);
export function saveSettings() {
  save("ek.settings", settings);
}

// ---------------------------------------------------------------- 単語帳（ライトナー方式）

// box: 0..5。正解で1つ上へ、不正解で0へ。box ごとの次回復習までの日数
const INTERVAL_DAYS = [0, 1, 2, 4, 7, 15];
const DAY = 24 * 60 * 60 * 1000;

let words = loadArray("ek.words");

export function allWords() {
  return words;
}

export function findWord(term) {
  const t = term.trim().toLowerCase();
  return words.find((w) => w.term.toLowerCase() === t);
}

export function addWord({ term, meaning_ja, example_en = "", example_ja = "", part_of_speech = "" }) {
  if (!term || findWord(term)) return false;
  words.unshift({
    id: crypto.randomUUID(),
    term: term.trim(),
    meaning_ja,
    example_en,
    example_ja,
    part_of_speech,
    box: 0,
    due: Date.now(),
    added: Date.now(),
    seen: 0,
    correct: 0,
  });
  save("ek.words", words);
  return true;
}

export function removeWord(id) {
  words = words.filter((w) => w.id !== id);
  save("ek.words", words);
}

export function dueWords() {
  const now = Date.now();
  return words.filter((w) => w.due <= now).sort((a, b) => a.box - b.box || a.due - b.due);
}

export function gradeWord(id, ok) {
  const w = words.find((w) => w.id === id);
  if (!w) return;
  w.seen++;
  if (ok) {
    w.correct++;
    w.box = Math.min(w.box + 1, INTERVAL_DAYS.length - 1);
  } else {
    w.box = 0;
  }
  // 不正解は10分後にもう一度
  w.due = ok ? Date.now() + INTERVAL_DAYS[w.box] * DAY : Date.now() + 10 * 60 * 1000;
  save("ek.words", words);
}

export function isMastered(w) {
  return w.box >= INTERVAL_DAYS.length - 1;
}

// 会話中に AI にさりげなく使ってもらう単語（覚えかけの単語を優先）
export function wordsForConversation(n = 5) {
  return [...words]
    .filter((w) => !isMastered(w))
    .sort((a, b) => a.box - b.box || a.due - b.due)
    .slice(0, n)
    .map((w) => w.term);
}

// 会話の中で登録済みの単語が出てきたら「会話で遭遇」として記録
export function markEncountered(text) {
  const lower = ` ${text.toLowerCase().replace(/[^a-z' -]/g, " ")} `;
  const hits = words.filter((w) => lower.includes(` ${w.term.toLowerCase()} `));
  hits.forEach((w) => (w.encounters = (w.encounters || 0) + 1));
  if (hits.length) save("ek.words", words);
  return hits;
}

// ---------------------------------------------------------------- 会話履歴

let conv = load("ek.conversation", { items: [] });

export function conversation() {
  return conv.items;
}
export function pushItem(item) {
  conv.items.push(item);
  if (conv.items.length > 200) conv.items = conv.items.slice(-200);
  save("ek.conversation", conv);
}
export function updateItems() {
  save("ek.conversation", conv);
}
export function clearConversation() {
  conv = { items: [] };
  save("ek.conversation", conv);
}

// ---------------------------------------------------------------- 学習記録

const stats = load("ek.stats", { days: [], utterances: 0, englishWords: 0 });

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function recordUtterance(text) {
  stats.utterances++;
  stats.englishWords += (text.match(/[A-Za-z']+/g) || []).length;
  const t = today();
  if (!stats.days.includes(t)) stats.days.push(t);
  if (stats.days.length > 400) stats.days = stats.days.slice(-400);
  save("ek.stats", stats);
}

export function getStats() {
  // 連続日数
  const set = new Set(stats.days);
  let streak = 0;
  const d = new Date();
  if (!set.has(today())) d.setDate(d.getDate() - 1); // 今日まだなら昨日から数える
  for (;;) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!set.has(key)) break;
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return {
    streak,
    days: stats.days.length,
    utterances: stats.utterances,
    englishWords: stats.englishWords,
    words: words.length,
    mastered: words.filter(isMastered).length,
    due: dueWords().length,
  };
}
