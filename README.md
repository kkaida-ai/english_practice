# しゃべって英会話（Free Talk）

日本人向けの**フリートーク英会話**Webアプリ。英語で話しかけると、キャラクターが「返答＋質問」で返してくれて会話が続きます。レッスンはなく、話題は自由です。

## 2つのバージョン

このリポジトリには、使い方の違う2つのバージョンがあります。

> **友達に使ってもらう・自分以外の人が使う場合は [公開版（`public-edition/`）](public-edition/README.md) を使ってください。** Claude Pro などの有料プランがなくても、無料の会話AI（Groq）で動きます。

| | 通常版（このディレクトリ） | [公開版（`public-edition/`）](public-edition/README.md) |
|---|---|---|
| 使う人 | 自分（PC、同じ Wi-Fi のスマホ） | 合言葉を知っている人（公開URLでどこからでも） |
| 起動 | `npm start` / `npm run mobile` | `cd public-edition && npm run public` |
| 会話AI | Claude Code（APIキー不要）/ Claude API / Ollama | **Groq の無料 LLM**（既定）/ Claude Code / Ollama から選択 |
| 声 | ずんだもん・リリー・Emma・Ken（＋ブラウザ読み上げ） | ずんだもん（VOICEVOX）と Kokoro（リリー・Emma・Ken）のみ |
| 公開方法 | LAN 内のみ（自己署名証明書） | Cloudflare の無料トンネルで公開URL（正式な証明書） |
| 安全対策 | なし（自分用） | 合言葉ログイン・回数制限・総当たり対策・セキュリティヘッダー |

画面と機能（下記）はどちらも同じです。以下は通常版の説明です。公開版は [public-edition/README.md](public-edition/README.md) を見てください。

## 機能

- 🎤 **音声入力で会話**：マイクをタップ → 英語で話す → 無音になると自動送信（スペースキーでもマイクON）。PCの **Whisper** で文字起こしするので、日本人の英語（カタカナ発音）でも聞き取りやすく、**文法の間違いもそのまま書き取る**ため添削が正確
- 🗣 **キャラクターが話す**：ずんだもん（VOICEVOX）／ **リリー・Emma・Ken（英語ネイティブ・Kokoro）**。母音に合わせた口パク（ア・イ・ウ・エ・オの口の形）、まばたき、「聞いてる／考え中／話してる」の動き
- 👀 **表示切り替え**：AIの英文の表示・非表示（リスニング練習向け。非表示にしてもタップで個別に表示）、日本語訳の表示、自分の発言の表示・非表示
- ✍️ **添削**：自分の英語を「より自然な言い方」に直して、日本語で短く説明（設定でOFFにできる）
- 🇯🇵 **詰まったら日本語OK**：`EN` ボタンを `JA` にして日本語で話すと、英語での言い方を教えてくれる（1回ごとにENに戻る）
- 💡 **返答のヒント**：次に言えそうな返答例（タップでネイティブ発音）
- 📚 **単語帳**
  - AIの英文の単語をタップ → 文脈に合った意味・例文 → 単語帳に追加
  - 各返答に出てくる重要表現のチップ（＋）から追加
  - 復習：間隔反復（ライトナー方式：0→1→2→4→7→15日）
    - 英→日のフラッシュカード
    - 日→英の**声で答える**クイズ（音声認識で自動判定）
  - 覚えかけの単語を、AIが**会話の中でさりげなく使って**くれる（実際の会話で再会すると定着しやすい）
- 🔥 学習記録：連続日数、発話回数、単語数、今日の復習数
- ⚙️ 設定：レベル（初級/中級/上級）、話す速さ、ずんだもんの声のスタイル、声の種類の選択、音声認識の切り替え、ハンズフリー（AIが話し終わったら自動でマイクON）、自動送信までの無音時間
- 🔁 もう一度／🐢ゆっくり 再生

データ（単語帳・会話・設定）はブラウザの localStorage に保存されます。

## セットアップ

必要なもの：Node.js 20.12 以上、Chrome または Edge（音声認識のため）、会話AI（下のどれか1つ）

```bash
npm install
npm start              # → http://localhost:3000
```

### 会話AI（APIキーなしでOK）

起動時に自動で選びます（`.env` の `EIKAIWA_BACKEND` で固定も可）。

| 方式 | 必要なもの | 応答速度の目安 |
|---|---|---|
| **claude-code**（APIキーがなければこれ） | [Claude Code](https://claude.com/claude-code) をインストールしてログイン済み（Pro/Max など） | 5〜8秒 |
| api | `ANTHROPIC_API_KEY` | 3〜5秒 |
| ollama | [Ollama](https://ollama.com/) と `llama3.1:8b` など | PC性能次第。日本語訳やカナ読みの品質は落ちる |

claude-code 方式は、裏で `claude -p` を1回ずつ呼び出します（ツールなし・セッション保存なし）。会話1往復ごとにサブスクリプションの利用枠を少し使います。

### スマホで使う

```bash
npm run mobile
```

1. スマホをPCと**同じWi-Fi**につなぐ
2. PCの画面右上「📱 スマホで使う」（またはターミナル）に出る **QRコード** をスマホのカメラで読み取る
3. 証明書の警告が出たら進む（自分のPCで作った証明書のため。iPhone: 詳細を表示 → このWebサイトを閲覧 ／ Android: 詳細設定 → アクセスする）
4. マイクを許可。ホーム画面に追加するとアプリのように使えます

- スマホのマイクは HTTPS でないと使えないため、`certs/` に自己署名証明書を自動生成し `https://<PCのIP>:3443` で公開します（macOS 標準の openssl でも作れます）
- ポート（3000 / 3443）が使用中なら、空いている番号へ自動でずらして起動します（QRコードも合わせて変わります）
- 同じWi-Fiの他の人が使えないよう、QRコードのURLに合言葉（トークン）が入っています。一度開けばスマホに記憶されます（`certs/token.txt` を消すと再発行）
- AI（Claude Code）と VOICEVOX はPCで動くので、PCでサーバーを起動したままにしてください
- 単語帳・会話・設定は端末ごとに保存されます（PCとスマホで共有はされません）
- 音声認識は iPhone（Safari）・Android（Chrome）どちらも対応。ただし iPhone では「ハンズフリー」の自動マイクONが効かないことがあります（その場合はマイクボタンをタップ）

### ずんだもんの声（VOICEVOX）

VOICEVOX エンジンが次のどこかにあれば、`npm start` の時に**自動で起動**します（なければブラウザ音声で代用）。

- `~/Applications/voicevox_engine/macos-arm64/run`（[エンジン単体](https://github.com/VOICEVOX/voicevox_engine/releases)を展開した場所）
- `/Applications/VOICEVOX.app`（[VOICEVOX アプリ](https://voicevox.hiroshiba.jp/)）
- `.env` の `VOICEVOX_ENGINE_PATH` で指定した場所

しくみ：
- VOICEVOX は日本語の音声合成なので、英語をそのまま渡すと「How」を「エイチオーダブリュー」と読んでしまいます。そこでAIが英文と一緒に**英語の強勢（ストレス）付きのカナ読み**（VOICEVOX のアクセント記法。例: `ハロ'ウ！ハ'ウ/ア'ア/ユウトゥデ'イ？`）も作り、英語で強く読む音節を高く発音させています。AIの書き間違いはサーバーが自動で直し、それでも通らなければ普通のカナ読みで話します
- 改善の効果（英語音声認識 Whisper に聞かせて測定、10文）：聞き間違い 4.8% → **1.2%**、英語としての自然さのスコアも約13%改善。同じ文の長さも短くなりテンポが良くなりました（例: 7.7秒 → 2.4秒）
- 読み上げは1文ずつ合成して、1文目を話している間に次の文を用意します（話し始めまで約0.3秒）
- 口パクは VOICEVOX が返す**モーラごとの母音とタイミング**を使い、「ア・イ・ウ・エ・オ」の口の形で動かしています
- ずんだもんの声は8種類（ノーマル／あまあま／ツンツン／セクシー／ささやき／ヒソヒソ／ヘロヘロ／なみだめ）から選べます

### リリー・Emma・Ken の声（Kokoro・英語ネイティブ）と音声認識（Whisper）

リリーはずんだもんの親友という設定の、英語ネイティブのオリジナルキャラクターです。リリー・Emma・Ken の声は [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)（Apache 2.0・無料・商用可）をPC内で動かしています。

```bash
pip install kokoro soundfile      # 声（初回起動時にモデル約330MBを自動ダウンロード）
pip install mlx-whisper           # 音声認識（Apple シリコンの Mac。モデル約1.6GBを自動ダウンロード）
brew install espeak-ng            # 任意：辞書にない単語の発音を補う
```

- `npm start` で自動起動します（`tts/speech_server.py`、ポート 50032）。使えない場合はブラウザの読み上げ・音声認識で代用
- 声：リリー＝Heart、Emma＝Bella、Ken＝Michael（設定で変更可）。1文の合成は約0.5秒
- 単語やヒントの 🔊 もこの声で鳴ります（ブラウザの読み上げは環境によって鳴らないことがあるため）
- 音声認識は Whisper large-v3-turbo。話し終わりを自動で検出して、約0.7秒で文字にします
  - 日本人風のカタカナ発音の英語 30 件で測定：ブラウザ任せの素の Whisper 誤り 5.2% → 工夫後 **1.7%**
  - 「I go to cafe yesterday」「She don't like dog」のような**間違いを直さずにそのまま**書き取ります（添削のため）
  - 設定の「音声認識」でブラウザ（Google）に切り替えも可能

## 設定（.env）

| 変数 | 既定値 | 説明 |
|---|---|---|
| `EIKAIWA_BACKEND` | `auto` | `claude-code` / `api` / `ollama` |
| `EIKAIWA_CLI_MODEL` | `sonnet` | claude-code で使うモデル（`haiku` にすると速くなる） |
| `EIKAIWA_OLLAMA_MODEL` | `llama3.1:8b` | ollama で使うモデル |
| `ANTHROPIC_API_KEY` | - | Claude API キー（api 方式のみ） |
| `PORT` | 3000 | ポート（PC用 http） |
| `HTTPS_PORT` | 3443 | スマホ用 https のポート |
| `EIKAIWA_MODEL` | `claude-opus-5` | api 方式で使うモデル |
| `EIKAIWA_EFFORT` | `low` | 考える深さ（low/medium/high）。会話のテンポ重視で low |
| `VOICEVOX_URL` | `http://127.0.0.1:50021` | VOICEVOX エンジンのURL |
| `VOICEVOX_ENGINE_PATH` | 自動検出 | 自動起動するエンジンの `run` のパス |
| `VOICEVOX_AUTOSTART` | 1 | `0` にすると自動起動しない |
| `EIKAIWA_PYTHON` | `python3` | Kokoro を動かす Python |
| `KOKORO_PORT` | 50032 | Kokoro TTS サーバーのポート |
| `KOKORO_AUTOSTART` | 1 | `0` にすると自動起動しない |

## 構成

```
server.js            Node サーバー（AI 呼び出し・VOICEVOX プロキシ・静的配信）
public/index.html    画面
public/app.js        会話・表示・単語帳UI
public/voice.js      音声認識／読み上げ
public/lipsync.js    口パク計算（母音→口の形、音量）
tts/speech_server.py 音声サーバー（Kokoro の読み上げ / Whisper の音声認識）
public/characters.js キャラクター（SVG）
public/store.js      localStorage（設定・単語帳の間隔反復・学習記録）
public-edition/      公開版（詳しくは public-edition/README.md）
```
