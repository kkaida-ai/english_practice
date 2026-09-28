// 口パク計算。DOM に依存しない純粋な関数
// - 母音のタイミング（VOICEVOX のモーラ / Kokoro の発音記号）で「口の形」を決め
// - 音声波形の音量で「開き具合」を決める

// 母音ごとの口の形 [開き 0..1, 横幅]
export const MOUTH = {
  a: [1.0, 1.1],
  i: [0.35, 1.5],
  u: [0.4, 0.65],
  e: [0.6, 1.35],
  o: [0.75, 0.8],
  N: [0.05, 1],
  cl: [0, 1],
  pau: [0, 1],
};

// WAV（PCM16）から 10ms ごとの音量（0..1、最大値で正規化）を求める
export function envelope(wavBytes, frameSec = 0.01) {
  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
  let p = 12, rate = 24000, dataAt = -1, dataLen = 0;
  while (p + 8 <= view.byteLength) {
    const id = String.fromCharCode(view.getUint8(p), view.getUint8(p + 1), view.getUint8(p + 2), view.getUint8(p + 3));
    const size = view.getUint32(p + 4, true);
    if (id === "fmt ") rate = view.getUint32(p + 12, true);
    if (id === "data") { dataAt = p + 8; dataLen = Math.min(size, view.byteLength - dataAt); break; }
    p += 8 + size + (size % 2);
  }
  if (dataAt < 0) return { values: [], frameSec };
  const n = dataLen >> 1, step = Math.max(1, Math.round(rate * frameSec));
  const values = [];
  let max = 1;
  for (let i = 0; i < n; i += step) {
    let peak = 0;
    for (let j = i; j < Math.min(n, i + step); j++) peak = Math.max(peak, Math.abs(view.getInt16(dataAt + j * 2, true)));
    values.push(peak);
    max = Math.max(max, peak);
  }
  return { values: values.map((v) => v / max), frameSec };
}

// timeline: [[開始秒, 終了秒, 母音], ...]（開始順）  t: 再生位置（秒）
// hint: 前回のインデックス  env: envelope() の結果（省略可）
// 戻り値: { open, width, index }
export function mouthAt(timeline, t, hint = 0, env = null) {
  let idx = Math.min(hint, timeline.length);
  if (idx > 0 && timeline[idx - 1] && timeline[idx - 1][0] > t) idx = 0; // 巻き戻し
  while (idx < timeline.length && timeline[idx][1] < t) idx++;
  const m = timeline[idx];
  const inVowel = m && t >= m[0] - 0.02;
  const level = env ? env.values[Math.floor(t / env.frameSec)] ?? 0 : null;

  let open, width;
  if (inVowel) {
    const devoiced = /^[AIUEO]$/.test(m[2]); // 無声化した母音（大文字）は小さく
    [open, width] = MOUTH[m[2]] || MOUTH[m[2].toLowerCase()] || [0.5, 1];
    if (devoiced) open *= 0.4;
    if (level === null) {
      const p = Math.min(1, Math.max(0, (t - m[0]) / Math.max(0.03, m[1] - m[0])));
      open *= 0.75 + 0.25 * Math.sin(Math.PI * p); // 母音の中で少し開閉させて自然に
    }
  } else {
    // 子音・ポーズ中: 音量があれば少しだけ開く（前後の母音の形を借りる）
    [open, width] = [0.3, (timeline[idx] ? MOUTH[timeline[idx][2]]?.[1] : 1) || 1];
    if (level === null) open = 0.08;
  }
  if (level !== null) {
    // 音量で開き具合を決める（小さな音は閉じる）
    const gain = Math.min(1, Math.max(0, (level - 0.08) / 0.4));
    open *= gain;
  }
  return { open, width, index: idx };
}
