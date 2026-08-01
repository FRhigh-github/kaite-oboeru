# 英単語 — 書いて覚える

選択肢式ではなく**入力で答えさせる**英単語アプリ。大学受験レベル 1,883 語。

**公開URL: https://frhigh-github.github.io/kaite-oboeru/**

iPhone の Safari で開き、共有ボタンから「ホーム画面に追加」でインストールできます。
オフラインで動作し、学習記録は端末内（IndexedDB）にのみ保存されます。

## 特徴

- **選択肢を出さない** — ひらがな専用キーボードで意味を書かせる。`<input>` を
  使わないので OS の IME を通らず、漢字変換が構造的に起こりえない
  （フリック入力とトグル入力の両方に対応）
- **順番で覚えられない** — 出題を毎回抽選するので、同じ並びが二度と再現されない
- **忘れかけた頃に戻ってくる** — まちがえた語は25問後、あたった語は50問後
- **判定の最終権限はユーザー** — 「惜しい」は自己申告で決めさせ、
  「合っているのにバツ」を構造的に回避する
- **外部 API も LLM も使わない** — オープンデータのみ。データ生成コストは 0

## クイックスタート

```bash
cd app/pwa
npm install
npm run dev
```

単語データを作り直す場合は [docs/data-pipeline.md](docs/data-pipeline.md) を参照。
`out/` の生成物は `npm run sync-data` でアプリに取り込みます。

## テスト

```bash
cd pipeline && py test_normalizer.py && py test_scheduler.py
cd app/vocab-core && npm run verify
```

判定と出題のロジックは **参照実装が Python**、そこから TypeScript へ移植し、
差分テスト **32,225 件**で一致を担保しています。
**`normalizer` か `scheduler` を触ったら必ず通してください。**

## ドキュメント

| 文書 | 内容 |
|---|---|
| [docs/engine.md](docs/engine.md) | 判定エンジンと出題エンジン。移植を一致させる約束事 |
| [docs/data-pipeline.md](docs/data-pipeline.md) | JMdict からの訳語生成。タグ選別とスコアリング |
| [docs/app.md](docs/app.md) | PWA の画面構成、かなキーボード、配信 |
| [docs/engagement-ideas.md](docs/engagement-ideas.md) | 継続率を上げる施策の検討メモ |

## ファイル構成

```
pipeline/
  config.py                  調整ノブはすべてここ
  step1_fetch.py 〜 step6_scheduler_vectors.py
  normalizer.py              日本語解答の正規化 — 参照実装
  scheduler.py               FSRS + 重み付き抽選 — 参照実装
  test_normalizer.py         判定エンジンのテスト
  test_scheduler.py          スケジューラのテスト
app/vocab-core/              UI 非依存の TypeScript ロジック層
  src/normalizer.ts          判定エンジン
  src/scheduler.ts           FSRS + 重み付き抽選
  src/rng.ts                 決定的乱数 (SplitMix64)
  src/verify.ts              Python 実装との差分テスト
app/pwa/                     アプリ本体 (PWA)
  src/app.ts                 状態の組み立て
  src/study.ts               出題画面
  src/kana-keyboard.ts       ひらがな専用キーボード
  src/storage.ts             IndexedDB 永続化
app/VocabKit/                Swift 版（macOS が無いため未使用）
data/       手で編集する補正データ（git 管理する）
sources/    ダウンロードした元データ（再配布しない）
build/      中間生成物
out/        アプリ同梱用の最終成果物
```

ロジック層は UI に依存しないので、PWA でも React Native でもそのまま使えます。
Node 24 は TypeScript をそのまま実行できるため、ビルド構成は不要です。

## ライセンス ⚠️

**コードと単語データでライセンスが違います。**

| 対象 | ライセンス |
|---|---|
| コード | MIT — [LICENSE](LICENSE) |
| 単語データ (`out/`, `app/pwa/public/data/`) | **CC BY-SA 4.0** — [LICENSE-DATA.md](LICENSE-DATA.md) |

単語データは NGSL / NAWL / JMdict（いずれも CC BY-SA 4.0）から生成しており、
ShareAlike 条項により同ライセンスで公開する必要があります。
アプリの価値は判定エンジンと出題アルゴリズムに置いてください。

**アプリに組み込む場合、出典表示画面が必須です。** EDRDG のライセンスは
起動画面での言及では不十分で、メニューから開ける独立した画面を求めています
（本アプリでは 設定 ＞ 出典・ライセンス）。詳細は
[LICENSE-DATA.md](LICENSE-DATA.md) を参照してください。
