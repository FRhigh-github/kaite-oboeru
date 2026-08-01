// 統計画面。

import { isNew } from "../../vocab-core/src/scheduler.ts";
import { isCleared, streakOf, CLEAR_STREAK, type App } from "./app.ts";
import { loadLogs } from "./storage.ts";
import { escapeHtml } from "./study.ts";

const LEECH_THRESHOLD = 8;

export async function renderStats(app: App, root: HTMLElement): Promise<void> {
  const cards = [...app.cards.values()];
  const studied = cards.filter((c) => !isNew(c));
  const clearedCards = studied.filter((c) => isCleared(app, c.wordId));
  const leeches = studied.filter(
    (c) => (app.progress.get(c.wordId)?.misses ?? 0) >= LEECH_THRESHOLD,
  );

  // 進み具合は連続正解数そのままで見せる。何回続ければクリアかが分かる。
  const buckets = [
    { label: "クリア", count: 0 },
    // クリアに近い順（あと1回 → あと3回）
    ...Array.from({ length: CLEAR_STREAK }, (_, i) => ({
      label: `あと ${i + 1} 回`,
      count: 0,
    })),
  ];
  for (const c of studied) {
    const s = Math.min(streakOf(app, c.wordId), CLEAR_STREAK);
    buckets[s === CLEAR_STREAK ? 0 : CLEAR_STREAK - s].count++;
  }

  const logs = await loadLogs();
  const todayLogs = logs.filter((l) => l.day === app.today);
  const accepted = todayLogs.filter((l) => l.accepted).length;
  const accuracy =
    todayLogs.length > 0 ? Math.round((accepted / todayLogs.length) * 100) : null;

  // ローカル判定と自己申告が食い違った件数。訳語データの改善余地を示す。
  const disagreements = logs.filter((l) => l.judgement !== "correct" && l.accepted);

  const total = app.vocabulary.words.length;
  const maxBucket = Math.max(1, ...buckets.map((b) => b.count));

  root.innerHTML = `
    <h2>統計</h2>

    <div class="stat-grid">
      <div class="stat">
        <div class="value">${todayLogs.length}</div>
        <div class="label">今日の解答</div>
      </div>
      <div class="stat">
        <div class="value">${accuracy === null ? "—" : accuracy + "%"}</div>
        <div class="label">今日の正答率</div>
      </div>
      <div class="stat">
        <div class="value">${clearedCards.length}<span style="font-size:15px;color:var(--text-dim)"> / ${total}</span></div>
        <div class="label">クリアした語</div>
      </div>
      <div class="stat">
        <div class="value">${studied.length - clearedCards.length}</div>
        <div class="label">学習中の語</div>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <h3 style="margin:0 0 4px;font-size:15px">クリアまでの進み具合</h3>
      <p style="color:var(--text-dim);font-size:12px;margin:0 0 12px">
        ${CLEAR_STREAK}回連続で正解するとクリアです。まちがえると振り出しに戻ります。
      </p>
      ${
        studied.length === 0
          ? '<p style="color:var(--text-dim);font-size:14px;margin:0">まだ学習記録がありません。</p>'
          : buckets
              .map(
                (b) => `
        <div class="bar-row">
          <span class="bar-label">${b.label}</span>
          <span class="bar-track">
            <span class="bar-fill" style="width:${(b.count / maxBucket) * 100}%"></span>
          </span>
          <span class="bar-value">${b.count}</span>
        </div>`,
              )
              .join("")
      }
    </div>

    <div class="card">
      <h3 style="margin:0 0 8px;font-size:15px">苦手な語</h3>
      ${
        leeches.length === 0
          ? `<p style="color:var(--text-dim);font-size:14px;margin:0">まだありません。${LEECH_THRESHOLD}回以上まちがえた語がここに出ます。</p>`
          : `<p style="color:var(--text-dim);font-size:13px;margin:0 0 8px">
               ${LEECH_THRESHOLD}回以上まちがえた語です。
             </p>
             <div style="font-size:14px;line-height:1.9">
               ${leeches
                 .slice(0, 30)
                 .map((c) => {
                   const w = app.words.get(c.wordId)!;
                   return `${escapeHtml(w.word)} <span style="color:var(--text-dim)">${escapeHtml(w.meaning)}</span>`;
                 })
                 .join("<br>")}
             </div>`
      }
    </div>

    ${
      disagreements.length > 0
        ? `<div class="card">
             <h3 style="margin:0 0 8px;font-size:15px">判定のずれ</h3>
             <p style="color:var(--text-dim);font-size:13px;margin:0">
               自動判定が「不正解／惜しい」としたが、あなたが正解と判断した回数:
               <strong style="color:var(--text)">${disagreements.length}</strong> 件。<br>
               この記録は訳語データを改善するための材料になります。
               設定画面からエクスポートできます。
             </p>
           </div>`
        : ""
    }
  `;
}
