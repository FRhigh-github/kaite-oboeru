// パート（100語ごとのグループ）の選択。
//
// 「学習」タブの中に出す。パートを選ぶとそのまま学習に入る。
// グループ1がいちばん易しく、番号が上がるほど難しくなる。

import { isNew, retrievabilityOn } from "../../vocab-core/src/scheduler.ts";
import { buildScheduler, type App } from "./app.ts";
import { saveMeta } from "./storage.ts";

/** この想起率以上を「覚えた」とみなす。 */
const MASTERED_THRESHOLD = 0.9;

interface GroupSummary {
  group: number;
  total: number;
  studied: number;
  mastered: number;
  due: number;
}

function summarize(app: App): GroupSummary[] {
  const map = new Map<number, GroupSummary>();
  for (const w of app.vocabulary.words) {
    let s = map.get(w.group);
    if (!s) {
      s = { group: w.group, total: 0, studied: 0, mastered: 0, due: 0 };
      map.set(w.group, s);
    }
    s.total++;
    const card = app.cards.get(w.id);
    if (!card || isNew(card)) continue;
    s.studied++;
    if (card.dueDay <= app.today) s.due++;
    if (retrievabilityOn(card, app.today) >= MASTERED_THRESHOLD) s.mastered++;
  }
  return [...map.values()].sort((a, b) => a.group - b.group);
}

export function renderGroups(app: App, root: HTMLElement, rerender: () => void): void {
  const summaries = summarize(app);
  const current = new Set(app.meta.selectedGroups);

  root.innerHTML = `
    <h2>パートを選ぶ</h2>
    <p style="color:var(--text-dim);font-size:14px;margin:0 0 16px">
      選んだパートの学習が始まります。番号が小さいほど易しい語です。
    </p>

    <div class="group-list">
      ${summaries
        .map((s) => {
          const on = current.has(s.group);
          const pct = s.total > 0 ? Math.round((s.mastered / s.total) * 100) : 0;
          return `
          <button class="group-item${on ? " selected" : ""}" data-group="${s.group}">
            <span class="group-head">
              <span class="group-name">パート ${s.group}${on ? " ・ 学習中" : ""}</span>
              <span class="group-count">${s.mastered} / ${s.total} 語</span>
            </span>
            <span class="bar-track">
              <span class="bar-fill" style="width:${pct}%"></span>
            </span>
            <span class="group-meta">
              ${s.studied === 0 ? "未着手" : `学習済み ${s.studied}`}
              ${s.due > 0 ? ` ・ 復習待ち ${s.due}` : ""}
            </span>
          </button>`;
        })
        .join("")}
    </div>

    <div class="settings-actions" style="margin-top:18px">
      <button class="secondary" data-action="cancel">やめる</button>
    </div>
  `;

  for (const btn of root.querySelectorAll<HTMLButtonElement>("[data-group]")) {
    btn.addEventListener("click", async () => {
      const group = Number(btn.dataset.group);
      app.meta = { ...app.meta, selectedGroups: [group] };
      await saveMeta(app.meta);
      // 出題対象が変わるのでスケジューラを組み直し、出題中の問題も破棄する
      app.scheduler = buildScheduler(app.vocabulary, app.meta);
      app.current = null;
      app.partPickerOpen = false;
      rerender();
    });
  }

  root.querySelector<HTMLButtonElement>('[data-action="cancel"]')!
    .addEventListener("click", () => {
      app.partPickerOpen = false;
      rerender();
    });
}
