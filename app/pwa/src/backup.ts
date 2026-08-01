// 学習データの持ち出し。
//
// 端末の中だけに置いていると、端末の初期化・アプリの削除・ブラウザの
// データ消去で消える。navigator.storage.persist() はブラウザの容量整理から
// 守ってくれるだけで、これらは防げない。**外に1本置く手段は必要**。
//
// iOS では共有シートを出せるので、「ファイルに保存」から iCloud Drive に
// 置ける。iCloud に入れば端末を変えても残る。共有シートが使えない環境では
// 通常のダウンロードに落とす。

import type { App } from "./app.ts";
import { exportBackup, saveMeta } from "./storage.ts";

/** 初めて促すまでの日数。使い始めてすぐ促しても保存するものが無い。 */
const FIRST_REMIND_DAY = 7;
/** 一度保存したあと、次に促すまでの日数。 */
const REMIND_INTERVAL_DAYS = 30;

function fileName(iso: string): string {
  return `eitango-${iso.slice(0, 10)}.json`;
}

type ShareNavigator = Navigator & { canShare?: (data: ShareData) => boolean };

/** 共有シートにファイルを渡せるか（iOS ならここから iCloud Drive に置ける）。 */
export function canShareFiles(): boolean {
  const nav = navigator as ShareNavigator;
  if (typeof nav.share !== "function" || typeof nav.canShare !== "function") return false;
  try {
    return nav.canShare({ files: [new File([""], "t.json", { type: "application/json" })] });
  } catch {
    return false;
  }
}

/**
 * バックアップを書き出す。保存できたら true。
 *
 * 共有シートを閉じられた場合も false を返す（保存日を進めないため）。
 */
export async function saveBackup(app: App): Promise<boolean> {
  const backup = await exportBackup();
  const json = JSON.stringify(backup);
  const name = fileName(backup.exportedAt);

  let saved = false;

  // iOS はここから「ファイルに保存」→ iCloud Drive に置ける
  if (canShareFiles()) {
    const file = new File([json], name, { type: "application/json" });
    try {
      await (navigator as ShareNavigator).share({ files: [file] });
      saved = true;
    } catch {
      // 共有シートを閉じた（AbortError）。保存されていないので日付は進めない。
      return false;
    }
  } else {
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    saved = true;
  }

  if (saved) {
    app.meta = { ...app.meta, lastBackupDay: app.today };
    await saveMeta(app.meta);
  }
  return saved;
}

/** そろそろ保存を促すべきか。 */
export function backupDue(app: App): boolean {
  const last = app.meta.lastBackupDay;
  if (last < 0) return app.today >= FIRST_REMIND_DAY;
  return app.today - last >= REMIND_INTERVAL_DAYS;
}

/** 最後に保存してからの経過を短い文にする。 */
export function lastBackupText(app: App): string {
  const last = app.meta.lastBackupDay;
  if (last < 0) return "まだ保存していません";
  const days = app.today - last;
  if (days <= 0) return "今日 保存しました";
  return `${days} 日前に保存しました`;
}
