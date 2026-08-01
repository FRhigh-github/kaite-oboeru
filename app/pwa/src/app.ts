// アプリ全体の状態。
//
// ロジック（判定・出題順）は app/vocab-core に切り出してあり、
// Python 参照実装との差分テストで検証済み。ここでは状態の保持と
// 永続化だけを行う。

import type { Judgement } from "../../vocab-core/src/normalizer.ts";
import {
  DEFAULT_SCHEDULER_CONFIG,
  Scheduler,
  newCard,
  type CardState,
  type SchedulerWord,
} from "../../vocab-core/src/scheduler.ts";
import {
  dayIndex,
  loadCards,
  loadMeta,
  loadProgress,
  localDateString,
  saveMeta,
  type AppMeta,
  type WordProgress,
} from "./storage.ts";

export interface Word {
  id: number;
  word: string;
  meaning: string;
  reading: string;
  answers: string[];
  pos: string;
  difficulty: number;
  tier: string;
  /** 100語ごとの学習グループ。1が最も易しい。 */
  group: number;
}

export interface VocabularyFile {
  meta: {
    version: number;
    word_count: number;
    license: string;
    sources: string[];
    words_per_group: number;
    group_count: number;
  };
  words: Word[];
}

export const POS_LABEL: Record<string, string> = {
  noun: "名詞",
  verb: "動詞",
  adjective: "形容詞",
  adverb: "副詞",
  conjunction: "接続詞",
  particle: "助詞",
  interjection: "感動詞",
  expression: "表現",
  affix: "接辞",
};

/**
 * この回数だけ連続で正解したらクリア。
 *
 * 日付や想起率ではなく「連続正解」を達成条件にしている。
 * 経過日数で判定すると、解答直後は必ず想起率 1.0 になるので
 * 間違えた語まで「覚えた」に数えられてしまううえ、
 * 何をすれば進むのかがユーザーから見えない。
 */
export const CLEAR_STREAK = 3;

/**
 * 出題の重み（連続正解数ごと）。
 * 間違えた直後（0回）がいちばん出やすく、正解を重ねるほど出にくくなる。
 */
export const STREAK_WEIGHT = [4, 1.5, 0.6];

/**
 * 一度出た語を、次に出すまで空ける問題数。
 *
 * 直前に出たばかりの語が続けて出ると、覚えていなくても答えられてしまう。
 */
export const COOLDOWN = 25;

/**
 * 同時に抱える未クリアの語数の上限。
 *
 * COOLDOWN より十分多く持つ必要がある。抱えている語が COOLDOWN 以下だと
 * 出せる語が無くなり、間隔を空ける決まりのほうが破られてしまう。
 */
export const WORKING_SET = COOLDOWN + 8;

/**
 * 学習を始めたとき、最初に続けて出す初見の語の数。
 *
 * 出題間隔を空けるには、回す語をある程度そろえる必要がある。
 * かといって最初から30語を初見で並べると全滅するので、
 * まずこの数だけ入れ、そのあとは初見と復習を交互にして増やしていく。
 */
export const FIRST_BATCH = 8;

/** その語の連続正解数。 */
export function streakOf(app: App, wordId: number): number {
  return app.progress.get(wordId)?.streak ?? 0;
}

/** クリア済み（CLEAR_STREAK 回連続で正解した）か。 */
export function isCleared(app: App, wordId: number): boolean {
  return streakOf(app, wordId) >= CLEAR_STREAK;
}

export type StudyPhase =
  | { kind: "asking" }
  | { kind: "judged"; judgement: Judgement; input: string; elapsedMs: number };

/**
 * 出題中の問題。
 *
 * これを App が保持しているのが重要。描画のたびに次の語を引いていると、
 * 学習タブを押し直しただけで問題が変わってしまう。
 * 解答し終えたときだけ null に戻して次の語へ進む。
 */
export interface CurrentQuestion {
  wordId: number;
  shownAt: number;
  /** 入力途中の文字列。再描画をまたいで保持する。 */
  draft: string;
  phase: StudyPhase;
  /** この問題の読み上げを済ませたか */
  spoken: boolean;
}

export interface App {
  vocabulary: VocabularyFile;
  words: Map<number, Word>;
  cards: Map<number, CardState>;
  /** 語ごとの連続正解数。クリア判定に使う。 */
  progress: Map<number, WordProgress>;
  scheduler: Scheduler;
  meta: AppMeta;
  today: number;
  /** 出題中の問題。null なら次を引く。 */
  current: CurrentQuestion | null;
  /** この起動で解答した回数（統計表示用） */
  answeredThisSession: number;
  /** 初見の語を出してから何問たったか。初見が固まって出るのを防ぐ。 */
  questionsSinceNew: number;
  /** バックアップの呼びかけを「あとで」で閉じたか（この起動のあいだだけ） */
  backupNoticeClosed: boolean;
  /**
   * 学習画面でパート選択を出しているか。
   * パート選択と学習を別タブに分けると行き来がややこしいので、
   * 同じ「学習」タブの中で切り替える。
   */
  partPickerOpen: boolean;
}

function randomSeed(): number {
  // 出題順がユーザーごとに変わるようにする。
  // 端末をまたぐ同期はしないので、暗号強度は不要。
  return Math.floor(Math.random() * 2 ** 31);
}

export async function boot(baseUrl: string): Promise<App> {
  const res = await fetch(`${baseUrl}data/vocabulary.json`);
  if (!res.ok) throw new Error(`単語データを読み込めません (${res.status})`);
  const vocabulary = (await res.json()) as VocabularyFile;

  const words = new Map(vocabulary.words.map((w) => [w.id, w]));

  let meta = await loadMeta();
  if (!meta) {
    const todayStr = localDateString();
    meta = {
      dayZero: todayStr,
      seed: randomSeed(),
      lastIntroDay: -1,
      introducedToday: 0,
      createdAt: new Date().toISOString(),
      // 最初はパート1だけ。学習画面から切り替えられる。
      selectedGroups: [1],
      speechEnabled: true,
      speechVolume: 1,
      lastBackupDay: -1,
    };
    await saveMeta(meta);
  }
  // 旧バージョンのバックアップを読み込んだ場合の補完
  if (
    !Array.isArray(meta.selectedGroups) ||
    typeof meta.speechEnabled !== "boolean" ||
    typeof meta.speechVolume !== "number" ||
    typeof meta.lastBackupDay !== "number"
  ) {
    meta = {
      ...meta,
      selectedGroups: Array.isArray(meta.selectedGroups) ? meta.selectedGroups : [1],
      speechEnabled: typeof meta.speechEnabled === "boolean" ? meta.speechEnabled : true,
      speechVolume: typeof meta.speechVolume === "number" ? meta.speechVolume : 1,
      lastBackupDay: typeof meta.lastBackupDay === "number" ? meta.lastBackupDay : -1,
    };
    await saveMeta(meta);
  }

  const today = dayIndex(meta.dayZero);

  // 日付が変わったら新規投入のカウンタをリセットする
  if (meta.lastIntroDay !== today) {
    meta = { ...meta, lastIntroDay: today, introducedToday: 0 };
    await saveMeta(meta);
  }

  const stored = await loadCards();
  const cards = new Map<number, CardState>();
  for (const w of vocabulary.words) cards.set(w.id, newCard(w.id));
  for (const c of stored) {
    // 単語データが差し替わって存在しなくなった語は捨てる
    if (cards.has(c.wordId)) cards.set(c.wordId, c);
  }

  const progress = new Map<number, WordProgress>();
  for (const p of await loadProgress()) {
    if (words.has(p.wordId)) progress.set(p.wordId, p);
  }

  const app: App = {
    vocabulary,
    words,
    cards,
    progress,
    scheduler: buildScheduler(vocabulary, meta),
    meta,
    today,
    answeredThisSession: 0,
    questionsSinceNew: 99,
    backupNoticeClosed: false,
    partPickerOpen: false,
    current: null,
  };
  return app;
}

/**
 * 選択中のグループの語だけでスケジューラを組み直す。
 *
 * 出題対象を絞ることで「1パートずつ覚える」使い方ができる。
 * グループを切り替えたら必ず呼ぶこと。
 */
export function buildScheduler(
  vocabulary: VocabularyFile,
  meta: AppMeta,
): Scheduler {
  const selected = new Set(meta.selectedGroups);
  const target =
    selected.size > 0
      ? vocabulary.words.filter((w) => selected.has(w.group))
      : vocabulary.words;

  // 新規語を投入する順は SchedulerWord.difficulty で決まる。
  // vocabulary.json の difficulty は 1..5 の5段階しかなく、100語のパートでは
  // 全語が同じ値になるため、パート内の並びが完全にシャッフルされてしまう。
  // （易しい語と難しい語が入り混じって出てくる原因はこれ。）
  // データは易しい順に並んでいるので、その並び順を細かい段階として渡し直す。
  // ORDER_BUCKET 語ごとに1段階なので、易しい順を保ちつつ
  // 「毎回まったく同じ順序にはならない」揺らぎも残る。
  const ORDER_BUCKET = 10;
  const schedulerWords: SchedulerWord[] = target.map((w, i) => ({
    wordId: w.id,
    word: w.word,
    reading: w.reading,
    difficulty: Math.floor(i / ORDER_BUCKET),
  }));
  // 同じ語がすぐ出てこないよう、既定より長く間隔を空ける。
  // （既定値は Python 参照実装と揃える必要があるので、ここで上書きする）
  return new Scheduler(schedulerWords, meta.seed, {
    ...DEFAULT_SCHEDULER_CONFIG,
    cooldownWindow: COOLDOWN,
  });
}

/** 選択中のグループに属するカードだけを返す。 */
export function activeCards(app: App): Map<number, CardState> {
  const selected = new Set(app.meta.selectedGroups);
  if (selected.size === 0) return app.cards;
  const out = new Map<number, CardState>();
  for (const [id, card] of app.cards) {
    const w = app.words.get(id);
    if (w && selected.has(w.group)) out.set(id, card);
  }
  return out;
}
