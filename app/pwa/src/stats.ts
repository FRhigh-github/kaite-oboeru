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
      <h3>クリアまで（${CLEAR_STREAK}回連続で正解）</h3>
      ${
        studied.length === 0
          ? '<p class="note">まだ記録がありません</p>'
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
      <h3>苦手な語（${LEECH_THRESHOLD}回以上まちがえた）</h3>
      ${
        leeches.length === 0
          ? '<p class="note">まだありません</p>'
          : `<div class="leech-list">
               ${leeches
                 .slice(0, 30)
                 .map((c) => {
                   const w = app.words.get(c.wordId)!;
                   return `<div><b>${escapeHtml(w.word)}</b> ${escapeHtml(w.meaning)}</div>`;
                 })
                 .join("")}
             </div>`
      }
    </div>
  `;
}
