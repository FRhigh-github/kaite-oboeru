// パート（100語ごとのグループ）の選択。
//
// 「学習」タブの中に出す。パートを選ぶとそのまま学習に入る。
// グループ1がいちばん易しく、番号が上がるほど難しくなる。

import { isNew } from "../../vocab-core/src/scheduler.ts";
import { buildScheduler, isMastered, type App } from "./app.ts";
import { saveMeta } from "./storage.ts";

/**
 * レベルの目安。
 *
 * 単語データの tier（part1/part2/part3）に対応する。
 * 収録語は NGSL/NAWL の頻度順なので、外部試験のスコアと厳密に対応する
 * わけではない。あくまで「どこまで覚えたか」の見当をつけるための目安として、
 * 断定を避けた表現にしてある。
 */
const LEVELS: { tier: string; name: string; goal: string; note: string }[] = [
  {
    tier: "part1",
    name: "基礎",
    goal: "高校基礎 ・ 英検準2級 ・ TOEIC 500点",
    note: "教科書と共通テストの土台になる語です。",
  },
  {
    tier: "part2",
    name: "標準",
    goal: "高校卒業 ・ 英検2級 ・ TOEIC 600〜700点",
    note: "ここまで覚えると共通テストの長文で困る語がかなり減ります。",
  },
  {
    tier: "part3",
    name: "上級",
    goal: "難関大二次 ・ 英検準1級 ・ TOEIC 800点",
    note: "難関大の長文や学術的な文章に出る語です。",
  },
];

interface GroupSummary {
  group: number;
  tier: string;
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
      s = { group: w.group, tier: w.tier, total: 0, studied: 0, mastered: 0, due: 0 };
      map.set(w.group, s);
    }
    s.total++;
    const card = app.cards.get(w.id);
    if (!card || isNew(card)) continue;
    s.studied++;
    if (card.dueDay <= app.today) s.due++;
    // 「覚えた」は今日の想起率では測らない（app.ts の isMastered を参照）。
    // 今日の想起率で測ると、間違えた語まで覚えたことになってしまう。
    if (isMastered(card)) s.mastered++;
  }
  return [...map.values()].sort((a, b) => a.group - b.group);
}

/** レベルの区切りと、そのレベル全体の進捗。 */
function levelHeader(tier: string, summaries: readonly GroupSummary[]): string {
  const level = LEVELS.find((l) => l.tier === tier);
  if (!level) return "";
  const inLevel = summaries.filter((s) => s.tier === tier);
  const total = inLevel.reduce((n, s) => n + s.total, 0);
  const mastered = inLevel.reduce((n, s) => n + s.mastered, 0);
  const pct = total > 0 ? Math.round((mastered / total) * 100) : 0;
  const first = inLevel[0]?.group;
  const last = inLevel[inLevel.length - 1]?.group;

  return `
    <div class="level-head">
      <div class="level-title">
        <span class="level-name">${level.name}</span>
        <span class="level-range">パート ${first}〜${last}</span>
      </div>
      <div class="level-goal">ここまで覚えたら目安: ${level.goal}</div>
      <div class="level-note">${level.note}</div>
      <div class="level-bar">
        <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
        <span class="level-count">${mastered} / ${total} 語</span>
      </div>
    </div>`;
}

export function renderGroups(app: App, root: HTMLElement, rerender: () => void): void {
  const summaries = summarize(app);
  const current = new Set(app.meta.selectedGroups);

  // レベルが変わるところで区切りを挟む。どこまで覚えたら何レベルかを示す。
  let seenTier: string | null = null;
  const items = summaries
    .map((s) => {
      const header = s.tier === seenTier ? "" : levelHeader(s.tier, summaries);
      seenTier = s.tier;
      const on = current.has(s.group);
      const pct = s.total > 0 ? Math.round((s.mastered / s.total) * 100) : 0;
      return `
        ${header}
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
    .join("");

  root.innerHTML = `
    <h2>パートを選ぶ</h2>
    <p style="color:var(--text-dim);font-size:14px;margin:0 0 16px">
      選んだパートの学習が始まります。番号が小さいほど易しい語です。
      「◯ / 100 語」は、1週間後でも思い出せる見込みの語数です。
    </p>

    <div class="group-list">${items}</div>

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
