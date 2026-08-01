// 学習データの永続化 (IndexedDB)。
//
// iOS の PWA はストレージが退避される可能性があるため、
// **エクスポート機能は必須**。settings 画面から JSON を書き出せるようにしてある。

import type { CardState } from "../../vocab-core/src/scheduler.ts";

const DB_NAME = "eitango";
const DB_VERSION = 2;

const STORE_CARDS = "cards";
const STORE_META = "meta";
const STORE_LOG = "log";
const STORE_PROGRESS = "progress";

/**
 * 解答1回の記録。
 *
 * `judgement` はローカル判定の結果、`accepted` はユーザーの最終判断。
 * この2つが食い違ったケース（判定は wrong だがユーザーは正解と申告）が、
 * 訳語データを改善するための評価データになる。必ず残すこと。
 */
export interface ReviewLog {
  id?: number;
  wordId: number;
  day: number;
  at: string;          // ISO8601
  input: string;       // ユーザーが入力した文字列
  judgement: string;   // correct / unsure / wrong
  accepted: boolean;   // 最終的に正解として扱ったか
  grade: number;
  elapsedMs: number;   // 解答までの時間
}

export interface AppMeta {
  /** 学習開始日 (YYYY-MM-DD, ローカル時刻)。FSRS の day 番号の基準。 */
  dayZero: string;
  /** 出題順を決める乱数シード。ユーザーごとに違う順序になる。 */
  seed: number;
  /** 新規語を投入した日と件数 */
  lastIntroDay: number;
  introducedToday: number;
  createdAt: string;
  /**
   * 出題対象のグループ番号。
   * 「1パートずつ覚える」ための絞り込み。空なら全グループ。
   */
  selectedGroups: number[];
  /** 問題が出たときに自動で読み上げるか */
  speechEnabled: boolean;
  /** 読み上げの音量 (0..1)。端末の音量とは別に下げられるようにする。 */
  speechVolume: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CARDS)) {
        db.createObjectStore(STORE_CARDS, { keyPath: "wordId" });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META);
      }
      if (!db.objectStoreNames.contains(STORE_LOG)) {
        db.createObjectStore(STORE_LOG, { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_PROGRESS)) {
        db.createObjectStore(STORE_PROGRESS, { keyPath: "wordId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

// --- カード ---

export async function loadCards(): Promise<CardState[]> {
  return tx<CardState[]>(STORE_CARDS, "readonly", (s) => s.getAll());
}

export async function saveCard(card: CardState): Promise<void> {
  await tx(STORE_CARDS, "readwrite", (s) => s.put(card));
}

export async function saveCards(cards: readonly CardState[]): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE_CARDS, "readwrite");
    const store = t.objectStore(STORE_CARDS);
    for (const c of cards) store.put(c);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// --- 連続正解数 ---

/**
 * 1語ぶんの「クリアまでの進み具合」。
 *
 * FSRS のカード状態（出題間隔）とは別に持つ。
 * ユーザーから見える達成条件は日付ではなく「3回連続で正解」なので、
 * 経過日数に左右されない素のカウンタが要る。
 */
export interface WordProgress {
  wordId: number;
  /** 連続正解数。まちがえたら 0 に戻る。 */
  streak: number;
  /** まちがえた回数の累計（苦手な語の表示に使う） */
  misses: number;
}

export async function loadProgress(): Promise<WordProgress[]> {
  return tx<WordProgress[]>(STORE_PROGRESS, "readonly", (s) => s.getAll());
}

export async function saveProgress(p: WordProgress): Promise<void> {
  await tx(STORE_PROGRESS, "readwrite", (s) => s.put(p));
}

// --- メタ情報 ---

export async function loadMeta(): Promise<AppMeta | null> {
  const value = await tx<AppMeta | undefined>(STORE_META, "readonly", (s) =>
    s.get("app"),
  );
  return value ?? null;
}

export async function saveMeta(meta: AppMeta): Promise<void> {
  await tx(STORE_META, "readwrite", (s) => s.put(meta, "app"));
}

// --- 解答ログ ---

export async function appendLog(entry: ReviewLog): Promise<void> {
  await tx(STORE_LOG, "readwrite", (s) => s.add(entry));
}

export async function loadLogs(): Promise<ReviewLog[]> {
  return tx<ReviewLog[]>(STORE_LOG, "readonly", (s) => s.getAll());
}

// --- 日付 ---

/** ローカル時刻の YYYY-MM-DD。 */
export function localDateString(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * dayZero からの経過日数。FSRS の day 番号。
 *
 * タイムゾーンやサマータイムで1日ずれないよう、UTC 正午どうしの差で数える。
 */
export function dayIndex(dayZero: string, today: string = localDateString()): number {
  const toNoonUTC = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d, 12);
  };
  const diff = toNoonUTC(today) - toNoonUTC(dayZero);
  return Math.max(0, Math.round(diff / 86_400_000));
}

// --- エクスポート / インポート ---

export interface Backup {
  format: "eitango-backup";
  version: 1;
  exportedAt: string;
  meta: AppMeta | null;
  cards: CardState[];
  logs: ReviewLog[];
  /** version 1 のバックアップには無い */
  progress?: WordProgress[];
}

export async function exportBackup(): Promise<Backup> {
  const [meta, cards, logs, progress] = await Promise.all([
    loadMeta(),
    loadCards(),
    loadLogs(),
    loadProgress(),
  ]);
  return {
    format: "eitango-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    meta,
    cards,
    logs,
    progress,
  };
}

export async function importBackup(backup: Backup): Promise<void> {
  if (backup?.format !== "eitango-backup") {
    throw new Error("このファイルはこのアプリのバックアップではありません。");
  }
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(
      [STORE_CARDS, STORE_META, STORE_LOG, STORE_PROGRESS], "readwrite");
    t.objectStore(STORE_CARDS).clear();
    t.objectStore(STORE_LOG).clear();
    t.objectStore(STORE_PROGRESS).clear();
    for (const c of backup.cards ?? []) t.objectStore(STORE_CARDS).put(c);
    for (const p of backup.progress ?? []) t.objectStore(STORE_PROGRESS).put(p);
    for (const l of backup.logs ?? []) {
      const { id, ...rest } = l;
      t.objectStore(STORE_LOG).add(rest as ReviewLog);
    }
    if (backup.meta) t.objectStore(STORE_META).put(backup.meta, "app");
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/** 学習データを全消去する（設定画面から明示的に呼ぶ）。 */
export async function clearAll(): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(
      [STORE_CARDS, STORE_META, STORE_LOG, STORE_PROGRESS], "readwrite");
    t.objectStore(STORE_CARDS).clear();
    t.objectStore(STORE_META).clear();
    t.objectStore(STORE_LOG).clear();
    t.objectStore(STORE_PROGRESS).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
