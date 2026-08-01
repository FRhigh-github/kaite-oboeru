// out/ の生成物を PWA の public/ へ取り込む。
// パイプラインを再実行したらこれも実行すること。

import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "..", "out");
const publicDir = join(here, "..", "public");
const dataDir = join(publicDir, "data");

mkdirSync(dataDir, { recursive: true });

const vocabSrc = join(outDir, "vocabulary.json");
if (!existsSync(vocabSrc)) {
  console.error(`[!] ${vocabSrc} がありません。先に pipeline/step5_export.py を実行してください。`);
  process.exit(1);
}

copyFileSync(vocabSrc, join(dataDir, "vocabulary.json"));
const vocab = JSON.parse(readFileSync(vocabSrc, "utf8"));
console.log(`vocabulary.json  ${vocab.words.length} 語`);

// 出典表示はライセンス上アプリ内に必須なので、必ず一緒に取り込む。
const attribution = join(outDir, "ATTRIBUTION.md");
if (existsSync(attribution)) {
  copyFileSync(attribution, join(dataDir, "ATTRIBUTION.md"));
  console.log("ATTRIBUTION.md   取り込み完了");
} else {
  console.error("[!] ATTRIBUTION.md がありません。ライセンス上、出典表示は必須です。");
  process.exit(1);
}

// 語数などをビルド時に埋め込めるよう、軽量なメタ情報も書き出す
writeFileSync(
  join(dataDir, "meta.json"),
  JSON.stringify({ ...vocab.meta, synced_at: new Date().toISOString() }, null, 2),
  "utf8",
);
console.log("meta.json        書き出し完了");
