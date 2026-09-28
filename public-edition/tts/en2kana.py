"""英語 → VOICEVOX のアクセント記法（カナ）変換

Kokoro に入っている発音辞書（misaki。辞書にない単語は espeak-ng）で英語を発音記号にし、
それを規則でカナにする。英語で強く読む母音の直後に ' を付け、VOICEVOX で高く読ませる。
LLM を使わないので、毎回同じ品質で、トークンも消費しない。

  "Hello! How are you today?" -> ハロ'ウ！ハ'ウ/アア/ユウ/トゥデ'イ？
"""

import re

# 母音（misaki の記号）→ 日本語の母音の並び
VOWELS = {
    "A": "ei", "I": "ai", "W": "au", "Y": "oi", "O": "ou",
    "ɑ": "a", "æ": "a", "ʌ": "a", "ɐ": "a", "ə": "a", "a": "a",
    "ɚ": "aa", "ɜ": "a",
    "ɛ": "e", "e": "e",
    "ɪ": "i", "ᵻ": "i", "i": "ii",
    "u": "uu", "ʊ": "u",
    "ɔ": "oo", "o": "o",
}
# 母音 + r（後ろに母音が続かないとき）
R_COLORED = {"ɑ": "aa", "ɔ": "oo", "ɪ": "ia", "i": "ia", "ɛ": "ea", "e": "ea", "ʊ": "ua", "u": "ua", "ɜ": "aa", "ə": "aa", "ʌ": "aa", "æ": "aa",
             "A": "ea", "I": "aia", "W": "aua", "O": "oa"}
SHORT = set("æɛɪʌɑʊ")  # 促音（ッ）が入りやすい短い母音
V_INDEX = {"a": 0, "i": 1, "u": 2, "e": 3, "o": 4}

ROWS = {
    "": "ア イ ウ エ オ", "k": "カ キ ク ケ コ", "ɡ": "ガ ギ グ ゲ ゴ", "g": "ガ ギ グ ゲ ゴ",
    "s": "サ スィ ス セ ソ", "z": "ザ ズィ ズ ゼ ゾ", "t": "タ ティ トゥ テ ト", "d": "ダ ディ ドゥ デ ド",
    "T": "タ ティ トゥ テ ト", "ɾ": "ダ ディ ドゥ デ ド", "n": "ナ ニ ヌ ネ ノ", "h": "ハ ヒ フ ヘ ホ",
    "f": "ファ フィ フ フェ フォ", "v": "ヴァ ヴィ ヴ ヴェ ヴォ", "b": "バ ビ ブ ベ ボ", "p": "パ ピ プ ペ ポ",
    "m": "マ ミ ム メ モ", "j": "ヤ イ ユ イェ ヨ", "ɹ": "ラ リ ル レ ロ", "l": "ラ リ ル レ ロ",
    "w": "ワ ウィ ウ ウェ ウォ", "ʃ": "シャ シ シュ シェ ショ", "ʒ": "ジャ ジ ジュ ジェ ジョ",
    "ʧ": "チャ チ チュ チェ チョ", "ʤ": "ジャ ジ ジュ ジェ ジョ", "θ": "サ スィ ス セ ソ", "ð": "ザ ズィ ズ ゼ ゾ",
    "ŋ": "ンガ ンギ ング ンゲ ンゴ",
}
KANA = {c: row.split() for c, row in ROWS.items()}
# 子音 + j + 母音（cute → キュ など）
PALATAL = {
    "k": "キャ キ キュ キェ キョ", "ɡ": "ギャ ギ ギュ ギェ ギョ", "g": "ギャ ギ ギュ ギェ ギョ", "p": "ピャ ピ ピュ ピェ ピョ",
    "b": "ビャ ビ ビュ ビェ ビョ", "m": "ミャ ミ ミュ ミェ ミョ", "n": "ニャ ニ ニュ ニェ ニョ", "h": "ヒャ ヒ ヒュ ヒェ ヒョ",
    "f": "フャ フィ フュ フェ フョ", "v": "ヴャ ヴィ ヴュ ヴェ ヴョ", "l": "リャ リ リュ リェ リョ", "ɹ": "リャ リ リュ リェ リョ",
    "t": "テャ ティ テュ テェ テョ", "d": "デャ ディ デュ デェ デョ", "s": "シャ シ シュ シェ ショ", "z": "ジャ ジ ジュ ジェ ジョ",
}
PALATAL = {c: row.split() for c, row in PALATAL.items()}
# 母音が続かない子音
LONE = {"t": "ト", "d": "ド", "T": "ト", "ɾ": "ド", "ʃ": "シュ", "ʒ": "ジュ", "ʧ": "チ", "ʤ": "ジ", "θ": "ス", "ð": "ズ",
        "h": "フ", "j": "イ", "w": "ウ", "n": "ン", "ŋ": "ング", "m": "ム", "l": "ル", "ɹ": "ル", "k": "ク", "ɡ": "グ", "g": "グ",
        "s": "ス", "z": "ズ", "f": "フ", "v": "ヴ", "b": "ブ", "p": "プ"}
VOICELESS_STOPS = set("ptkʧ")
PUNCT = {".": "。", "!": "！", "?": "？", ",": "、", ";": "、", ":": "、", "—": "、", "-": "、", "…": "、"}


def parse(ph):
    """発音記号を (種類, 記号, 強勢) の並びにする"""
    out, stress = [], 0
    for ch in ph:
        if ch == "ˈ":
            stress = 2
        elif ch == "ˌ":
            stress = max(stress, 1)
        elif ch in VOWELS:
            out.append(("V", ch, stress))
            stress = 0
        elif ch in LONE or ch in "Tɾ":
            out.append(("C", ch, 0))
        # ː ʔ などは無視
    return out


def word_to_kana(ph):
    seq = parse(ph)
    moras, accent_at = [], None
    best = max((s for k, _, s in seq if k == "V"), default=0)
    i = 0
    while i < len(seq):
        kind, sym, st = seq[i]
        if kind == "C":
            nxt = seq[i + 1] if i + 1 < len(seq) else None
            nxt2 = seq[i + 2] if i + 2 < len(seq) else None
            # 子音 + j + 母音 → 拗音
            if nxt and nxt[1] == "j" and nxt2 and nxt2[0] == "V" and sym in PALATAL:
                vs = vowel_seq(nxt2[1], seq, i + 2)
                moras.append(PALATAL[sym][V_INDEX[vs[0]]])
                if nxt2[2] == best and best and accent_at is None:
                    accent_at = len(moras)
                moras += [KANA[""][V_INDEX[v]] for v in vs[1:]]
                i += 3
                continue
            if nxt and nxt[0] == "V":
                vs = vowel_seq(nxt[1], seq, i + 1)
                moras.append(KANA.get(sym, KANA[""])[V_INDEX[vs[0]]])
                if nxt[2] == best and best and accent_at is None:
                    accent_at = len(moras)
                moras += [KANA[""][V_INDEX[v]] for v in vs[1:]]
                i += 2 + (1 if vs_has_r(nxt[1], seq, i + 1) else 0)
                i = sokuon(moras, seq, i, nxt)
                continue
            # 母音が続かない子音
            if sym in "tT" and nxt and nxt[1] == "s":  # ts → ツ（it's → イッツ）
                moras.append("ツ")
                i += 2
                continue
            if sym in "dɾ" and nxt and nxt[1] == "z":  # dz → ズ（sounds → サウンズ）
                moras.append("ズ")
                i += 2
                continue
            if sym == "n" and nxt and nxt[1] in "pbm":
                moras.append("ン")
            elif sym == "ŋ" and nxt and nxt[1] in "kɡg":
                moras.append("ン")
            else:
                moras.append(LONE.get(sym, ""))
            i += 1
            continue
        # 語頭などの子音なし母音
        vs = vowel_seq(sym, seq, i)
        moras.append(KANA[""][V_INDEX[vs[0]]])
        if st == best and best and accent_at is None:
            accent_at = len(moras)
        moras += [KANA[""][V_INDEX[v]] for v in vs[1:]]
        i += 1 + (1 if vs_has_r(sym, seq, i) else 0)
        i = sokuon(moras, seq, i, seq[i - 1] if i - 1 < len(seq) else None)
    moras = [m for m in moras if m]
    if accent_at is None:
        return "".join(moras), False
    return "".join(moras[:accent_at]) + "'" + "".join(moras[accent_at:]), True


def vs_has_r(v, seq, idx):
    """母音の直後が r（その後に母音が続かない）なら r を母音に含めて読む"""
    nxt = seq[idx + 1] if idx + 1 < len(seq) else None
    after = seq[idx + 2] if idx + 2 < len(seq) else None
    return bool(nxt and nxt[1] == "ɹ" and not (after and after[0] == "V") and v in R_COLORED)


def vowel_seq(v, seq, idx):
    return R_COLORED[v] if vs_has_r(v, seq, idx) else VOWELS[v]


def sokuon(moras, seq, i, vowel):
    """強く読む短い母音 + 語末（または子音の前）の p t k ch → ッ を入れる（cat → キャット）"""
    if not vowel or vowel[0] != "V" or vowel[1] not in SHORT or vowel[2] < 1:
        return i
    cur = seq[i] if i < len(seq) else None
    nxt = seq[i + 1] if i + 1 < len(seq) else None
    if cur and cur[0] == "C" and cur[1] in VOICELESS_STOPS and (nxt is None or nxt[0] == "C"):
        moras.append("ッ")
    return i


# 日本語の単語は英語読みにせず、日本語の読みのまま（ずんだもん自身の名前が英語訛りにならないように）
JP_WORDS = {
    "zundamon": "ズ'ンダモン", "zunda": "ズ'ンダ", "mochi": "モ'チ", "sushi": "ス'シ", "ramen": "ラ'アメン",
    "tempura": "テ'ンプラ", "udon": "ウ'ドン", "soba": "ソ'バ", "onigiri": "オニギ'リ", "matcha": "マ'ッチャ",
    "sake": "サ'ケ", "miso": "ミ'ソ", "tofu": "トウ'フ", "wasabi": "ワ'サビ", "edamame": "エダマ'メ",
    "onsen": "オ'ンセン", "anime": "ア'ニメ", "manga": "マ'ンガ", "karaoke": "カラ'オケ", "kimono": "キモ'ノ",
    "tokyo": "トウキョ'ウ", "kyoto": "キョ'ウト", "osaka": "オオサ'カ", "hokkaido": "ホッカ'イドウ", "okinawa": "オキナ'ワ",
    "tohoku": "トウ'ホク", "sendai": "セ'ンダイ", "nara": "ナ'ラ", "fuji": "フ'ジ", "japan": "ジャパ'ン",
    "kawaii": "カワイ'イ", "arigato": "アリガ'トウ", "konnichiwa": "コンニチ'ワ", "sensei": "セ'ンセイ", "senpai": "セ'ンパイ",
}

_g2p = None


def g2p():
    global _g2p
    if _g2p is None:
        from misaki import en, espeak
        try:
            fallback = espeak.EspeakFallback(british=False)
        except Exception:  # espeak-ng がなくても辞書の単語は変換できる
            fallback = None
        _g2p = en.G2P(trf=False, british=False, fallback=fallback)
    return _g2p


def english_to_kana(text):
    """英文 → VOICEVOX アクセント記法（単語ごとに / で区切る。文末は 。！？）"""
    _, tokens = g2p()(text)
    out = []
    for t in tokens:
        p = (t.phonemes or "").strip()
        if not p:
            continue
        if all(ch in PUNCT or not ch.strip() for ch in t.text):
            mark_ = "".join(PUNCT.get(ch, "") for ch in t.text)[:1]
            if mark_:
                out.append(mark_)
            continue
        jp = JP_WORDS.get(t.text.lower().strip(".,!?'\""))
        kana = jp if jp else word_to_kana(p)[0]
        if kana:
            out.append(kana)
    # 単語の間は /、句読点の前後には / を付けない
    s = ""
    for piece in out:
        if piece in "。！？、":
            s = s.rstrip("/") + piece
        else:
            s += ("/" if s and s[-1] not in "。！？、" else "") + piece
    return re.sub(r"/+", "/", s)


if __name__ == "__main__":
    import sys
    for line in sys.argv[1:] or ["Hello! How are you today?", "That sounds like a lot of fun. What did you eat?"]:
        print(line, "->", english_to_kana(line))
