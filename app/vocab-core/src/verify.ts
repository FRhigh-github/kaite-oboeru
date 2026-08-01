// Python 参照実装との差分テスト。
//
// pipeline/normalizer.py と pipeline/scheduler.py の出力をベクタ化したものと
// TypeScript 実装を突き合わせる。
// ずれると「合っているのにバツ」や出題順の破綻に直結するので、
// ロジックを変更したら必ず通すこと。
//
//   npm run verify

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { judge, normalize, variants } from "./normalizer.ts";
import {
  Grade,
  newCard,
  isNew,
  retrievabilityOn,
  review,
  Scheduler,
  type CardState,
  type SchedulerWord,
} from "./scheduler.ts";
import { Rng, roundHalfToEven } from "./rng.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] ?? join(here, "..", "..", "..", "out");

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(outDir, name), "utf8")) as T;
}

let totalFailures = 0;

// =============================================================================
// 判定エンジン
// =============================================================================

interface NormalizeCase {
  input: string;
  normalized: string;
  keys: string[];
}
interface JudgeCase {
  input: string;
  answers: string[];
  expected: string;
}

console.log("Python 参照実装との差分テスト\n");
console.log("--------------------------------------------------");
console.log("判定エンジン");

const normVectors = loadJson<{ normalize: NormalizeCase[]; judge: JudgeCase[] }>(
  "normalization_testcases.json",
);

let normMismatch = 0;
let keysMismatch = 0;
let shown = 0;
for (const c of normVectors.normalize) {
  const actual = normalize(c.input);
  if (actual !== c.normalized) {
    if (shown++ < 10) {
      console.log(`  [FAIL] normalize(${c.input})`);
      console.log(`         期待: ${c.normalized}  実際: ${actual}`);
    }
    normMismatch++;
  }
  const actualKeys = [...variants(c.input)].sort();
  const expectedKeys = [...c.keys].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    if (shown++ < 10) {
      console.log(`  [FAIL] variants(${c.input})`);
      console.log(`         期待: ${expectedKeys}  実際: ${actualKeys}`);
    }
    keysMismatch++;
  }
}

let judgeMismatch = 0;
const byOutcome: Record<string, number> = {};
for (const c of normVectors.judge) {
  byOutcome[c.expected] = (byOutcome[c.expected] ?? 0) + 1;
  const actual = judge(c.input, c.answers);
  if (actual !== c.expected) {
    if (shown++ < 10) {
      console.log(`  [FAIL] judge(${c.input}, [${c.answers}])`);
      console.log(`         期待: ${c.expected}  実際: ${actual}`);
    }
    judgeMismatch++;
  }
}

const n = normVectors.normalize.length;
console.log(`  normalize : ${n - normMismatch}/${n} 一致`);
console.log(`  variants  : ${n - keysMismatch}/${n} 一致`);
console.log(
  `  judge     : ${normVectors.judge.length - judgeMismatch}/${normVectors.judge.length} 一致` +
    `  (内訳 ${Object.entries(byOutcome).sort().map(([k, v]) => `${k}:${v}`).join(" ")})`,
);
totalFailures += normMismatch + keysMismatch + judgeMismatch;

// =============================================================================
// スケジューラ
// =============================================================================

console.log("\n--------------------------------------------------");
console.log("スケジューラ");

interface Step {
  day: number;
  word_id: number;
  grade: number;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  due_day: number;
}
interface SchedVectors {
  config: {
    scheduler_seed: number;
    learner_seed: number;
    days: number;
    reviews_per_day: number;
    prob_scale: number;
  };
  steps: Step[];
}
interface VocabWord {
  id: number;
  word: string;
  reading: string;
  difficulty: number;
}

const vocab = loadJson<{ words: VocabWord[] }>("vocabulary.json");
const sched = loadJson<SchedVectors>("scheduler_testcases.json");
const cfg = sched.config;

// step6_scheduler_vectors.py と同じ値
const BLANK_OUT_PROB = 80_000;

/** step6_scheduler_vectors.py の simulated_answer と同一。 */
function simulatedAnswer(r: number, rng: Rng): Grade {
  if (rng.below(cfg.prob_scale) < BLANK_OUT_PROB) return Grade.again;
  const rq = Math.max(0, Math.min(cfg.prob_scale, roundHalfToEven(r * cfg.prob_scale)));
  if (rng.below(cfg.prob_scale) < rq) {
    return rq > 950_000 ? Grade.easy : Grade.good;
  }
  return rq > 500_000 ? Grade.hard : Grade.again;
}

const schedulerWords: SchedulerWord[] = vocab.words.map((w) => ({
  wordId: w.id,
  word: w.word,
  reading: w.reading,
  difficulty: w.difficulty,
}));

const scheduler = new Scheduler(schedulerWords, cfg.scheduler_seed);
const learner = new Rng(cfg.learner_seed);
const states = new Map<number, CardState>(
  schedulerWords.map((w) => [w.wordId, newCard(w.wordId)]),
);

const produced: Step[] = [];
outer: for (let day = 0; day < cfg.days; day++) {
  let introducedToday = 0;
  for (let i = 0; i < cfg.reviews_per_day; i++) {
    const wordId = scheduler.nextWord(states, day, introducedToday);
    if (wordId === null) break;
    const state = states.get(wordId)!;
    let grade: Grade;
    if (isNew(state)) {
      introducedToday++;
      grade = Grade.good;
    } else {
      grade = simulatedAnswer(retrievabilityOn(state, day), learner);
    }
    const updated = review(state, grade, day);
    states.set(wordId, updated);
    produced.push({
      day,
      word_id: wordId,
      grade,
      stability: updated.stability,
      difficulty: updated.difficulty,
      reps: updated.reps,
      lapses: updated.lapses,
      due_day: updated.dueDay,
    });
    if (produced.length > sched.steps.length + 10) break outer;
  }
}

// 浮動小数は exp/pow の最終桁が処理系でずれうるので相対誤差で比較する。
function closeEnough(a: number, b: number, tolerance = 1e-9): boolean {
  if (a === b) return true;
  return Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
}

let stepMismatch = 0;
let firstMismatch: string | null = null;

if (produced.length !== sched.steps.length) {
  console.log(
    `  [FAIL] ステップ数が違う: 期待 ${sched.steps.length} / 実際 ${produced.length}`,
  );
  stepMismatch++;
}

const pairs = Math.min(sched.steps.length, produced.length);
let maxDiff = 0;
for (let i = 0; i < pairs; i++) {
  const e = sched.steps[i];
  const a = produced[i];
  const problems: string[] = [];
  if (e.word_id !== a.word_id) problems.push(`word_id 期待${e.word_id} 実際${a.word_id}`);
  if (e.grade !== a.grade) problems.push(`grade 期待${e.grade} 実際${a.grade}`);
  if (e.day !== a.day) problems.push(`day 期待${e.day} 実際${a.day}`);
  if (e.reps !== a.reps || e.lapses !== a.lapses) {
    problems.push(`reps/lapses 期待${e.reps}/${e.lapses} 実際${a.reps}/${a.lapses}`);
  }
  if (e.due_day !== a.due_day) problems.push(`due_day 期待${e.due_day} 実際${a.due_day}`);
  if (!closeEnough(e.stability, a.stability)) {
    problems.push(`stability 期待${e.stability} 実際${a.stability}`);
  }
  if (!closeEnough(e.difficulty, a.difficulty)) {
    problems.push(`difficulty 期待${e.difficulty} 実際${a.difficulty}`);
  }
  maxDiff = Math.max(
    maxDiff,
    Math.abs(e.stability - a.stability),
    Math.abs(e.difficulty - a.difficulty),
  );
  if (problems.length > 0) {
    stepMismatch++;
    firstMismatch ??= `ステップ ${i}: ${problems.join(", ")}`;
  }
}

if (firstMismatch) {
  console.log(`  [FAIL] 最初の不一致 — ${firstMismatch}`);
  console.log("         出題順は前段の結果に依存するため、ここ以降は総崩れになります。");
}
console.log(`  一致ステップ: ${Math.max(0, pairs - stepMismatch)}/${sched.steps.length}`);
if (stepMismatch === 0) {
  console.log(`  浮動小数の最大差: ${maxDiff.toExponential(3)}`);
}
totalFailures += stepMismatch;

// =============================================================================

console.log("\n==================================================");
if (totalFailures === 0) {
  const total = n * 2 + normVectors.judge.length + sched.steps.length;
  console.log(`✅ 全 ${total} 件が Python 参照実装と一致しました。`);
  process.exit(0);
}
console.log(`❌ ${totalFailures} 件の不一致があります。`);
process.exit(1);
