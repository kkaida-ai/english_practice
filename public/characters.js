// キャラクター（SVG）: 口パク・まばたき・状態表示
// ずんだもんはオリジナルの簡易イラスト（ずんだもん公式ガイドラインに沿った二次創作の範囲で使用）

export const CHARACTERS = {
  zundamon: {
    name: "ずんだもん",
    nameEn: "Zundamon",
    engine: "voicevox",
    hair: "#8fd16a",
    hairDark: "#5ea83d",
    eye: "#e8862f",
    skin: "#fff1e4",
    outfit: "#ffffff",
    outfitAccent: "#7cc35a",
    style: "zunda",
  },
  lily: {
    name: "リリー",
    nameEn: "Lily",
    engine: "kokoro",
    gender: "female",
    hair: "#f6a8c8",
    hairDark: "#d9749f",
    eye: "#4aa3df",
    skin: "#fff1e8",
    outfit: "#ffe27a",
    outfitAccent: "#4aa3df",
    style: "twin",
  },
  female: {
    name: "Emma",
    nameEn: "Emma",
    engine: "kokoro",
    gender: "female",
    hair: "#a5693b",
    hairDark: "#7a4a26",
    eye: "#3f7fc4",
    skin: "#ffe8d6",
    outfit: "#f28fa6",
    outfitAccent: "#ffffff",
    style: "long",
  },
  male: {
    name: "Ken",
    nameEn: "Ken",
    engine: "kokoro",
    gender: "male",
    hair: "#3b3530",
    hairDark: "#221e1b",
    eye: "#4a3a2c",
    skin: "#fbe0c8",
    outfit: "#4d7fc2",
    outfitAccent: "#ffffff",
    style: "short",
  },
};

function edamame(x, y, rot, c) {
  // 枝豆のさや（ずんだもんの髪飾りイメージ）
  return `<g transform="translate(${x} ${y}) rotate(${rot})">
    <path d="M-22 0 C-22 -12 22 -12 22 0 C22 12 -22 12 -22 0Z" fill="${c.hair}" stroke="${c.hairDark}" stroke-width="2.5"/>
    <circle cx="-11" cy="0" r="5.5" fill="#b6e68f"/>
    <circle cx="0" cy="0" r="5.5" fill="#b6e68f"/>
    <circle cx="11" cy="0" r="5.5" fill="#b6e68f"/>
  </g>`;
}

function star(x, y, r, fill) {
  const pts = [...Array(10)].map((_, i) => {
    const a = (Math.PI / 5) * i - Math.PI / 2, rr = i % 2 ? r * 0.45 : r;
    return `${(x + rr * Math.cos(a)).toFixed(1)},${(y + rr * Math.sin(a)).toFixed(1)}`;
  });
  return `<polygon points="${pts.join(" ")}" fill="${fill}" stroke="#e0a800" stroke-width="1.2"/>`;
}

function backHair(c) {
  if (c.style === "twin")
    // ツインテール
    return `<path d="M48 96 C42 42 158 42 152 96 L150 140 L50 140Z" fill="${c.hair}"/>
      <path d="M44 78 C14 90 10 150 30 186 C36 168 40 150 50 134 C52 118 50 96 44 78Z" fill="${c.hair}" stroke="${c.hairDark}" stroke-width="1.5"/>
      <path d="M156 78 C186 90 190 150 170 186 C164 168 160 150 150 134 C148 118 150 96 156 78Z" fill="${c.hair}" stroke="${c.hairDark}" stroke-width="1.5"/>
      <circle cx="46" cy="80" r="6" fill="${c.outfitAccent}"/><circle cx="154" cy="80" r="6" fill="${c.outfitAccent}"/>`;
  if (c.style === "long")
    return `<path d="M44 92 C40 40 160 40 156 92 L164 176 C150 184 136 170 132 150 L68 150 C64 170 50 184 36 176Z" fill="${c.hair}"/>`;
  if (c.style === "zunda")
    return `<path d="M46 96 C42 40 158 40 154 96 L150 146 C140 150 132 140 130 130 L70 130 C68 140 60 150 50 146Z" fill="${c.hair}"/>`;
  return `<path d="M50 96 C46 44 154 44 150 96 L146 110 L54 110Z" fill="${c.hair}"/>`;
}

function frontHair(c) {
  if (c.style === "short")
    return `<path d="M50 96 C46 46 154 42 152 94 C140 76 126 68 104 70 C92 80 70 82 50 96Z" fill="${c.hair}"/>
      <path d="M104 70 C112 60 132 60 140 72" stroke="${c.hairDark}" stroke-width="2" fill="none"/>`;
  if (c.style === "twin")
    return `<path d="M48 100 C42 38 158 38 152 100 C148 86 140 76 128 70 C124 82 114 88 104 90 C108 80 106 72 102 68 C92 80 76 88 60 90 C54 92 50 96 48 100Z" fill="${c.hair}"/>
      ${star(132, 62, 9, "#ffd84d")}`;
  if (c.style === "long")
    return `<path d="M48 100 C42 40 158 40 152 100 C144 84 130 70 112 66 C112 78 104 84 96 86 C98 76 94 70 90 68 C76 74 60 84 48 100Z" fill="${c.hair}"/>`;
  // zunda: ぱっつん気味の前髪＋アホ毛
  return `<path d="M48 100 C42 38 158 38 152 100 C146 88 140 80 132 76 L126 90 L116 74 L104 90 L96 72 L84 90 L76 74 L68 90 L62 80 C56 86 52 92 48 100Z" fill="${c.hair}"/>
    <path d="M100 42 C96 26 108 18 114 22 C106 26 104 34 104 42Z" fill="${c.hair}" stroke="${c.hairDark}" stroke-width="1.5"/>
    ${edamame(40, 70, -60, c)}${edamame(160, 70, 60, c)}`;
}

function body(c) {
  const collar =
    c.style === "twin"
      ? `<path d="M80 166 L100 180 L120 166" fill="none" stroke="${c.outfitAccent}" stroke-width="4"/>
         <path d="M92 182 L100 190 L108 182 L100 176Z" fill="#ff7aa8"/>`
      : c.style === "zunda"
      ? `<path d="M76 168 L100 186 L124 168" fill="none" stroke="${c.outfitAccent}" stroke-width="5"/>
         <circle cx="100" cy="194" r="6" fill="${c.outfitAccent}"/>`
      : `<path d="M82 166 L100 182 L118 166" fill="none" stroke="${c.outfitAccent}" stroke-width="4"/>`;
  return `<path d="M52 220 C52 180 72 162 100 162 C128 162 148 180 148 220Z" fill="${c.outfit}" stroke="#00000018" stroke-width="2"/>
    <rect x="90" y="146" width="20" height="20" rx="6" fill="${c.skin}"/>
    ${collar}`;
}

export function characterSVG(key) {
  const c = CHARACTERS[key] || CHARACTERS.zundamon;
  return `<svg viewBox="0 0 200 220" class="char-svg" role="img" aria-label="${c.name}">
    <g class="char-body">
      ${backHair(c)}
      ${body(c)}
      <ellipse cx="100" cy="106" rx="50" ry="48" fill="${c.skin}"/>
      <g class="char-eyes">
        <g class="eye" transform="translate(80 108)">
<g class="eye-in">
          <ellipse rx="8.5" ry="11" fill="#fff"/>
          <ellipse rx="6.5" ry="9" cy="1" fill="${c.eye}"/>
          <ellipse rx="3.4" ry="4.6" cy="2" fill="#2a1a10"/>
          <circle cx="-2.4" cy="-3" r="2.4" fill="#fff"/>
        </g></g>
        <g class="eye" transform="translate(120 108)">
<g class="eye-in">
          <ellipse rx="8.5" ry="11" fill="#fff"/>
          <ellipse rx="6.5" ry="9" cy="1" fill="${c.eye}"/>
          <ellipse rx="3.4" ry="4.6" cy="2" fill="#2a1a10"/>
          <circle cx="-2.4" cy="-3" r="2.4" fill="#fff"/>
        </g></g>
      </g>
      <path class="brow" d="M70 92 Q80 88 88 92" stroke="${c.hairDark}" stroke-width="2.4" fill="none" stroke-linecap="round"/>
      <path class="brow" d="M112 92 Q120 88 130 92" stroke="${c.hairDark}" stroke-width="2.4" fill="none" stroke-linecap="round"/>
      <ellipse cx="70" cy="126" rx="8" ry="4.5" fill="#ff9aa2" opacity=".55"/>
      <ellipse cx="130" cy="126" rx="8" ry="4.5" fill="#ff9aa2" opacity=".55"/>
      <g class="mouth" transform="translate(100 132)">
        <path class="mouth-closed" d="M-7 -1 Q0 5 7 -1" stroke="#8a3b2b" stroke-width="2.4" fill="none" stroke-linecap="round"/>
        <g class="mouth-open" style="display:none">
          <ellipse class="mouth-shape" rx="8" ry="6" fill="#8a2f2f"/>
          <ellipse class="mouth-tongue" cy="3" rx="5" ry="2.5" fill="#ff7b86"/>
        </g>
      </g>
      ${frontHair(c)}
    </g>
  </svg>`;
}

// 1体のキャラクターの見た目を制御するクラス
export class CharacterView {
  constructor(container) {
    this.container = container;
    this.open = 0; // 0..1 口の開き
    this.target = 0;
    this.width = 1;
    this.w = 1;
    this._blinkTimer = null;
    this._raf = null;
  }

  mount(key) {
    this.key = key;
    this.container.innerHTML = characterSVG(key);
    this.svg = this.container.querySelector("svg");
    this.closed = this.svg.querySelector(".mouth-closed");
    this.openG = this.svg.querySelector(".mouth-open");
    this.shape = this.svg.querySelector(".mouth-shape");
    this.tongue = this.svg.querySelector(".mouth-tongue");
    this.eyes = this.svg.querySelectorAll(".eye");
    this._startBlink();
    this._startLoop();
  }

  // 外部（音量解析など）から口の開き具合を指定: 0..1
  setMouth(v, width = 1) {
    this.target = Math.max(0, Math.min(1, v));
    this.width = width;
  }

  setState(state) {
    this.container.dataset.state = state; // idle | listening | thinking | speaking
  }

  _startLoop() {
    cancelAnimationFrame(this._raf);
    const tick = () => {
      // なめらかに追従
      this.open += (this.target - this.open) * 0.45;
      const o = this.open;
      if (o < 0.07) {
        this.closed.style.display = "";
        this.openG.style.display = "none";
      } else {
        this.closed.style.display = "none";
        this.openG.style.display = "";
        this.w += (this.width - this.w) * 0.4;
        this.shape.setAttribute("ry", (1.5 + o * 8.5).toFixed(2));
        this.shape.setAttribute("rx", ((4.5 + o * 3.5) * this.w).toFixed(2));
        this.tongue.setAttribute("cy", (1 + o * 4).toFixed(2));
        this.tongue.setAttribute("rx", (3.5 * this.w).toFixed(2));
      }
      this._raf = requestAnimationFrame(tick);
    };
    tick();
  }

  _startBlink() {
    clearTimeout(this._blinkTimer);
    const blink = () => {
      this.eyes.forEach((e) => e.classList.add("blink"));
      setTimeout(() => this.eyes.forEach((e) => e.classList.remove("blink")), 130);
      this._blinkTimer = setTimeout(blink, 2200 + Math.random() * 3000);
    };
    this._blinkTimer = setTimeout(blink, 1500);
  }
}
