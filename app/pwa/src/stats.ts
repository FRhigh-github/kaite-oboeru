// 統計画面。

import { isNew } from "../../vocab-core/src/scheduler.ts";
import { isMastered, retention, MASTERED_HORIZON_DAYS, type App } from "./app.ts";
import { loadLogs } from "./storage.ts";
import { escapeHtml } from "./study.ts";

const LEECH_THRESHOLD = 8;

export async function renderStats(app: App, root: HTMLElement): Promise<void> {
  const cards = [...app.cards.values()];
  const studied = cards.filter((c) => !isNew(c));
  const due = studied.filter((c) => c.dueDay <= app.today);
  const leeches = studied.filter((c) => c.lapses >= LEECH_THRESHOLD);

  // 定着度は「解答から1週間後の想起率」で見る。
  // 今日時点の想起率で見ると、今日答えた語は正解も不正解も想起率 1.0 に
  // なってしまい、間違えた語まで「しっかり」に入ってしまう。
  const buckets = [
    { label: "しっかり", min: 0.9, count: 0 },
    { label: "だいたい", min: 0.7, count: 0 },
    { label: "あやふや", min: 0.4, count: 0 },
    { label: "忘れかけ", min: 0.0, count: 0 },
  ];
  for (const c of studied) {
    const r = retention(c);
    for (const b of buckets) {
      if (r >= b.min) {
        b.count++;
        break;
      }
    }
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
        <div class="value">${studied.filter(isMastered).length}<span style="font-size:15px;color:var(--text-dim)"> / ${total}</span></div>
        <div class="label">覚えた語</div>
      </div>
      <div class="stat">
        <div class="value">${due.length}</div>
        <div class="label">復習待ち</div>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <h3 style="margin:0 0 4px;font-size:15px">定着度</h3>
      <p style="color:var(--text-dim);font-size:12px;margin:0 0 12px">
        ${MASTERED_HORIZON_DAYS}日後にどれだけ思い出せそうかで分けています。
        「しっかり」が覚えた語です。
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
               ${LEECH_THRESHOLD}回以上まちがえた語です。出題頻度は抑えてあります。
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
