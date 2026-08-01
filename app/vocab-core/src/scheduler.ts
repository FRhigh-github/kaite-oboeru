// 出題スケジューラ。
//
// **これは pipeline/scheduler.py の移植です。挙動を一致させること。**
// out/scheduler_testcases.json で照合できます（npm run verify）。
//
// Python と同一の出力を得るための約束事:
//   - 言語標準の乱数は実装が違うので使わず、SplitMix64 を自前で持つ
//   - exp/pow は処理系で最終桁がずれうるため、抽選の重みは整数に量子化する
//   - Python の round() は偶数丸めなので roundHalfToEven を使う
//     （JavaScript の Math.round() は 0.5 を切り上げるので結果がずれる）
//   - オブジェクトのキー順に依存しないよう、候補は必ず wordId 順に並べる

import { Rng, roundHalfToEven } from "./rng.ts";
import { editDistance, type Judgement } from "./normalizer.ts";

// =============================================================================
// FSRS
// =============================================================================

/** 3値判定 + 自己申告から導かれる評点。 */
export const Grade = {
  again: 1, // 不正解
  hard: 2,  // 「惜しい」を自己申告で正解にした
  good: 3,  // 正解
  easy: 4,  // 即答で正解
} as const;

export type Grade = (typeof Grade)[keyof typeof Grade];

/** 判定結果と自己申告から評点を決める。 */
export function gradeFrom(
  judgement: Judgement,
  options: { selfReportedCorrect?: boolean; answeredQuickly?: boolean } = {},
): Grade {
  switch (judgement) {
    case "correct":
      return options.answeredQuickly ? Grade.easy : Grade.good;
    case "unsure":
      return options.selfReportedCorrect ? Grade.hard : Grade.again;
    case "wrong":
      return Grade.again;
  }
}

/**
 * FSRS-4.5 の既定パラメータ。
 * 将来ユーザーの学習ログから最適化する余地があるが、既定値でも十分機能する。
 */
export const W: readonly number[] = [
  0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031,
  1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755,
];

const DECAY = -0.5;
const FACTOR = 19.0 / 81.0;
const MIN_DIFFICULTY = 1.0;
const MAX_DIFFICULTY = 10.0;
const MIN_STABILITY = 0.01;

/** 目標とする想起率。次回出題間隔の算出に使う。 */
export const REQUEST_RETENTION = 0.9;

function clampDifficulty(d: number): number {
  return Math.min(Math.max(d, MIN_DIFFICULTY), MAX_DIFFICULTY);
}

export function initialStability(grade: Grade): number {
  return Math.max(W[grade - 1], MIN_STABILITY);
}

export function initialDifficulty(grade: Grade): number {
  return clampDifficulty(W[4] - Math.exp(W[5] * (grade - 1)) + 1.0);
}

/** 経過日数後にまだ思い出せる確率 (0..1)。 */
export function retrievability(stability: number, elapsedDays: number): number {
  if (stability <= 0) return 0.0;
  if (elapsedDays <= 0) return 1.0;
  return Math.pow(1.0 + (FACTOR * elapsedDays) / stability, DECAY);
}

/** 想起率が requestRetention まで下がるまでの日数。 */
export function nextInterval(
  stability: number,
  requestRetention: number = REQUEST_RETENTION,
): number {
  if (stability <= 0) return 1;
  const days = (stability / FACTOR) * (Math.pow(requestRetention, 1.0 / DECAY) - 1.0);
  return Math.max(1, roundHalfToEven(days));
}

function nextDifficulty(difficulty: number, grade: Grade): number {
  // 評点に応じて増減させたあと、初期難易度へ向けて平均回帰させる。
  // 回帰を入れないと難易度が際限なく振り切れる。
  const d = difficulty - W[6] * (grade - 3);
  return clampDifficulty(W[7] * initialDifficulty(Grade.easy) + (1.0 - W[7]) * d);
}

function stabilityAfterSuccess(
  stability: number, difficulty: number, r: number, grade: Grade,
): number {
  const hardPenalty = grade === Grade.hard ? W[15] : 1.0;
  const easyBonus = grade === Grade.easy ? W[16] : 1.0;
  const growth =
    Math.exp(W[8]) *
    (11.0 - difficulty) *
    Math.pow(stability, -W[9]) *
    (Math.exp(W[10] * (1.0 - r)) - 1.0) *
    hardPenalty *
    easyBonus;
  return Math.max(stability * (1.0 + growth), MIN_STABILITY);
}

function stabilityAfterLapse(stability: number, difficulty: number, r: number): number {
  const s =
    W[11] *
    Math.pow(difficulty, -W[12]) *
    (Math.pow(stability + 1.0, W[13]) - 1.0) *
    Math.exp(W[14] * (1.0 - r));
  // 失敗で安定度が上がることはない
  return Math.max(Math.min(s, stability), MIN_STABILITY);
}

// =============================================================================
// カードの状態
// =============================================================================

/** 1語ぶんの学習状態。アプリではこれをローカル DB に永続化する。 */
export interface CardState {
  readonly wordId: number;
  readonly stability: number;
  readonly difficulty: number;
  readonly reps: number;
  readonly lapses: number;
  readonly lastReviewDay: number; // -1 = 未学習
  readonly dueDay: number;
}

export function newCard(wordId: number): CardState {
  return {
    wordId, stability: 0, difficulty: 0, reps: 0, lapses: 0,
    lastReviewDay: -1, dueDay: 0,
  };
}

export function isNew(state: CardState): boolean {
  return state.reps === 0;
}

export function retrievabilityOn(state: CardState, day: number): number {
  if (isNew(state)) return 0.0;
  return retrievability(state.stability, day - state.lastReviewDay);
}

/** 1回の解答を反映した新しい状態を返す（元の状態は変更しない）。 */
export function review(state: CardState, grade: Grade, day: number): CardState {
  let stability: number;
  let difficulty: number;
  let lapses: number;

  if (isNew(state)) {
    stability = initialStability(grade);
    difficulty = initialDifficulty(grade);
    lapses = grade === Grade.again ? 1 : 0;
  } else {
    const r = retrievabilityOn(state, day);
    difficulty = nextDifficulty(state.difficulty, grade);
    if (grade === Grade.again) {
      stability = stabilityAfterLapse(state.stability, difficulty, r);
      lapses = state.lapses + 1;
    } else {
      stability = stabilityAfterSuccess(state.stability, difficulty, r, grade);
      lapses = state.lapses;
    }
  }

  return {
    wordId: state.wordId,
    stability,
    difficulty,
    reps: state.reps + 1,
    lapses,
    lastReviewDay: day,
    dueDay: day + nextInterval(stability),
  };
}

// =============================================================================
// 出題スケジューラ
// =============================================================================

export interface SchedulerConfig {
  /** 忘れかけの語をどれだけ優先するか。大きいほど「覚えていない語」に集中する。 */
  urgencyExponent: number;
  /** 直近この件数に出た語は候補から外す（連続出題の防止） */
  cooldownWindow: number;
  /** 直近この件数の語と綴りが似ていたら外す（干渉の防止） */
  interferenceWindow: number;
  interferenceDistance: number;
  /** この回数以上間違えた語は「リーチ」とみなす */
  leechThreshold: number;
  /** リーチ語の重み倍率。1未満にして出題過多による消耗を防ぐ */
  leechWeight: number;
  /** 1日に新規投入する語数の上限 */
  newPerDay: number;
  /** 復習待ちがこの数を下回ったら新規語を投入する */
  dueTarget: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  urgencyExponent: 2.0,
  cooldownWindow: 12,
  interferenceWindow: 6,
  interferenceDistance: 2,
  leechThreshold: 8,
  leechWeight: 0.5,
  newPerDay: 20,
  dueTarget: 10,
};

/** スケジューラが必要とする最小限の語情報。 */
export interface SchedulerWord {
  readonly wordId: number;
  readonly word: string;      // 英単語（干渉判定に使う）
  readonly reading: string;   // 代表の読み（干渉判定に使う）
  readonly difficulty: number; // 1..5。初回投入順の決定に使う
}

/**
 * 重みを整数に量子化する分解能。
 * 浮動小数の最終桁のずれで抽選結果が変わるのを防ぐため。
 */
const WEIGHT_SCALE = 1_000_000;

/**
 * nextWord の挙動を差し替えるオプション。
 *
 * **すべて省略時は Python 参照実装とまったく同じ挙動になる。**
 * 差分テスト（verify.ts）はオプションなしで呼ぶので、
 * ここに追加するものは必ず「省略時は従来どおり」であること。
 *
 * アプリ側は「3回連続正解でクリア」という別の進み方を採るため、
 * 復習日ではなく連続正解数で出題を決めたい。その差し替え口。
 */
export interface NextWordOptions {
  /** 復習日を無視し、未クリアの語すべてを候補にする */
  ignoreDue?: boolean;
  /** 出題対象から外す語（クリア済みなど） */
  exclude?: ReadonlySet<number>;
  /** 出題の重み。省略時は FSRS の想起率から決める */
  weightOf?: (state: CardState, day: number) => number;
  /** 新規語を投入するか。省略時は復習待ち数と1日の上限から判断する */
  introduceNew?: boolean;
  /**
   * 出題の順番。小さい語ほど先に出す。
   *
   * 抽選より優先され、この値が最小の語だけが抽選に残る。
   * アプリ側で「まちがえた語は20問後、あたった語は40問後」という
   * 決まった間隔を守るために使う。省略時は全候補が抽選に残る。
   */
  preferOrder?: (state: CardState) => number;
}

/**
 * 出題順を決める。
 *
 * 設計の要点は「スコア順に並べて上から出さない」こと。
 * 並べてしまうと順番が固定され、ユーザーは意味ではなく順番を覚えてしまう。
 * 毎回重み付き抽選を行うことで、同じ並びが二度と再現されないようにしている。
 */
export class Scheduler {
  readonly config: SchedulerConfig;
  private readonly words: Map<number, SchedulerWord>;
  private readonly rng: Rng;
  private newQueue: number[];
  private recent: number[] = [];

  constructor(
    words: readonly SchedulerWord[],
    seed: bigint | number,
    config: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG,
  ) {
    this.config = config;
    this.words = new Map(words.map((w) => [w.wordId, w]));
    this.rng = new Rng(seed);

    // 新規語の投入順。辞書順や頻度順のままだと全ユーザーが同じ順序に
    // なるので、易しい順を保ちつつシード付きで揺らす。
    const sorted = [...words].sort(
      (a, b) => a.difficulty - b.difficulty || a.wordId - b.wordId,
    );
    this.newQueue = this.jitter(sorted).map((w) => w.wordId);
  }

  /** 難易度の並びは保ちつつ、同難易度のなかだけシャッフルする。 */
  private jitter(words: readonly SchedulerWord[]): SchedulerWord[] {
    const out: SchedulerWord[] = [];
    let bucket: SchedulerWord[] = [];
    let current: number | null = null;
    for (const w of words) {
      if (w.difficulty !== current) {
        out.push(...this.rng.shuffled(bucket));
        bucket = [];
        current = w.difficulty;
      }
      bucket.push(w);
    }
    out.push(...this.rng.shuffled(bucket));
    return out;
  }

  /** 忘れかけているほど大きい重みを返す。 */
  weight(state: CardState, day: number): number {
    const r = retrievabilityOn(state, day);
    let w = Math.pow(Math.max(1.0 - r, 0.0), this.config.urgencyExponent);
    if (state.lapses >= this.config.leechThreshold) w *= this.config.leechWeight;
    return w;
  }

  /** 浮動小数の誤差で抽選結果がぶれないよう整数化する。 */
  private quantized(weights: readonly number[]): number[] {
    return weights.map((w) => Math.max(1, roundHalfToEven(w * WEIGHT_SCALE)));
  }

  /** 直近 windowSize 件に出た語と紛らわしいか。 */
  private interferes(wordId: number, windowSize: number): boolean {
    if (windowSize <= 0) return false;
    const cand = this.words.get(wordId);
    if (!cand) return false;
    const candWord = Array.from(cand.word);
    for (const prevId of this.recent.slice(-windowSize)) {
      const prev = this.words.get(prevId);
      if (!prev) continue;
      if (prev.reading === cand.reading) return true;
      if (editDistance(Array.from(prev.word), candWord) <= this.config.interferenceDistance) {
        return true;
      }
    }
    return false;
  }

  /**
   * 出題対象になりうる語。段階的に条件を緩める。
   *
   * 候補は必ず wordId 順に並べる。抽選は候補の並び順に依存するため、
   * オブジェクトのキー順に任せると Python 版と結果がずれてしまう。
   */
  private candidates(
    states: ReadonlyMap<number, CardState>,
    day: number,
    options: NextWordOptions = {},
  ): number[] {
    const usable = (s: CardState) => !isNew(s) && !options.exclude?.has(s.wordId);
    let due = [...states.values()]
      .filter((s) => usable(s) && (options.ignoreDue || s.dueDay <= day))
      .map((s) => s.wordId)
      .sort((a, b) => a - b);
    if (due.length === 0) {
      // 期限前でも、最も忘れかけているものから出す
      due = [...states.values()]
        .filter(usable)
        .map((s) => s.wordId)
        .sort((a, b) => a - b);
    }
    if (due.length === 0) return [];

    const cooldown = new Set(this.recent.slice(-this.config.cooldownWindow));

    // 候補が尽きたら段階的に緩める。干渉判定は一気に捨てず
    // ウィンドウを狭めていき、「直前の語と紛らわしい」だけは最後まで守る。
    for (const window of [this.config.interferenceWindow, 2, 1, 0]) {
      const pool = due.filter((w) => !cooldown.has(w) && !this.interferes(w, window));
      if (pool.length > 0) return pool;
    }
    // クールダウンも捨てる（プールが極端に小さい場合）
    for (const window of [1, 0]) {
      const pool = due.filter((w) => !this.interferes(w, window));
      if (pool.length > 0) return pool;
    }
    return due;
  }

  /**
   * 未学習の語をキューから1つ取り出す。
   *
   * キューはアプリ側で永続化されないので、再起動後は学習済みの語も
   * 先頭に残っている。それらは読み飛ばす。
   */
  private popNew(
    states: ReadonlyMap<number, CardState>,
    exclude?: ReadonlySet<number>,
  ): number | null {
    while (this.newQueue.length > 0) {
      const wordId = this.newQueue.shift()!;
      if (exclude?.has(wordId)) continue;
      const state = states.get(wordId);
      if (state !== undefined && !isNew(state)) continue;
      return wordId;
    }
    return null;
  }

  /** 次に出題する語の id を返す。出せるものが無ければ null。 */
  nextWord(
    states: ReadonlyMap<number, CardState>,
    day: number,
    introducedToday: number,
    options: NextWordOptions = {},
  ): number | null {
    let dueCount = 0;
    for (const s of states.values()) {
      if (!isNew(s) && s.dueDay <= day) dueCount++;
    }

    // 復習待ちが少なければ新規語を投入する
    const wantsNew =
      options.introduceNew ??
      (dueCount < this.config.dueTarget && introducedToday < this.config.newPerDay);
    if (wantsNew) {
      const wordId = this.popNew(states, options.exclude);
      if (wordId !== null) {
        this.remember(wordId);
        return wordId;
      }
    }

    let pool = this.candidates(states, day, options);
    if (pool.length > 0 && options.preferOrder) {
      // 「出す順番」が指定されているときは、いちばん順番の早い語だけを残す。
      // 同着が複数あればそのなかで抽選する。
      const order = options.preferOrder;
      const keys = pool.map((id) => order(states.get(id)!));
      const min = Math.min(...keys);
      pool = pool.filter((_, i) => keys[i] === min);
    }
    if (pool.length === 0) {
      if (options.introduceNew ?? introducedToday < this.config.newPerDay) {
        const wordId = this.popNew(states, options.exclude);
        if (wordId !== null) {
          this.remember(wordId);
          return wordId;
        }
      }
      return null;
    }

    const weightOf = options.weightOf ?? ((s: CardState, d: number) => this.weight(s, d));
    const weights = this.quantized(pool.map((id) => weightOf(states.get(id)!, day)));
    const total = weights.reduce((a, b) => a + b, 0);
    const r = this.rng.below(total);
    let acc = 0;
    for (let i = 0; i < pool.length; i++) {
      acc += weights[i];
      if (r < acc) {
        this.remember(pool[i]);
        return pool[i];
      }
    }
    // 到達しないはずだが安全のため
    const last = pool[pool.length - 1];
    this.remember(last);
    return last;
  }

  private remember(wordId: number): void {
    this.recent.push(wordId);
    const keep = Math.max(this.config.cooldownWindow, this.config.interferenceWindow);
    if (this.recent.length > keep * 2) {
      this.recent = this.recent.slice(-keep);
    }
  }

  isLeech(state: CardState): boolean {
    return state.lapses >= this.config.leechThreshold;
  }
}
