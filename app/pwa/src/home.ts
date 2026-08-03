// ホーム画面。起動して最初に出る。
//
// 開いた瞬間に問題が出ていると、いきなり答えさせられている感じになる。
// ここで「いまどこまで来ているか」を見せ、「はじめる」からパートを選んで
// 学習に入る。一度はじめたら、そのあとは学習画面のまま（いつも通り）。
//
// 数字は起動時点の状態から出すので、ここでは保存領域を読みに行かない。
// 開いてすぐ出したい画面なので、読み込み待ちを挟まない。

import { isNew } from "../../vocab-core/src/scheduler.ts";
import { isCleared, type App } from "./app.ts";
import { LEVELS } from "./groups.ts";

export function renderHome(app: App, root: HTMLElement, rerender: () => void): void {
  const currentPart = app.meta.selectedGroups[0] ?? 1;

  let partTotal = 0;
  let partCleared = 0;
  let allCleared = 0;
  let learning = 0;
  // レベル（基礎・標準・上級）ごとの進み具合。全体の数字だけだと、
  // 1,883語のうち何十語という表示になって、進んでいる感じがしない。
  const byTier = new Map<string, { total: number; cleared: number }>();
  for (const w of app.vocabulary.words) {
    const cleared = isCleared(app, w.id);
    if (cleared) allCleared++;
    else if (!isNew(app.cards.get(w.id)!)) learning++;

    let tier = byTier.get(w.tier);
    if (!tier) byTier.set(w.tier, (tier = { total: 0, cleared: 0 }));
    tier.total++;
    if (cleared) tier.cleared++;

    if (w.group !== currentPart) continue;
    partTotal++;
    if (cleared) partCleared++;
  }

  const partPct = partTotal > 0 ? Math.round((partCleared / partTotal) * 100) : 0;
  const all = app.vocabulary.words.length;
  // 学習を始めた日を1日目として数える（app.today は0始まり）
  const day = app.today + 1;
  // 一度も解いていないうちは「つづける」だと嘘になる
  const started = allCleared + learning > 0;

  root.innerHTML = `
    <div class="home">
      <div class="home-head">
        <div class="home-title">書いて覚える</div>
        <div class="home-day">${day}日目</div>
      </div>

      <div class="card home-part">
        <div class="home-part-head">
          <span class="home-label">いま覚えているところ</span>
          <span class="home-part-name">パート ${currentPart}</span>
        </div>
        <div class="bar-row">
          <span class="bar-track">
            <span class="bar-fill" style="width:${partPct}%"></span>
          </span>
          <span class="bar-value">${partCleared}/${partTotal}</span>
        </div>
      </div>

      <div class="stat-grid home-stats">
        <div class="stat">
          <div class="value">${allCleared}<span class="home-of"> / ${all}</span></div>
          <div class="label">クリアした語</div>
        </div>
        <div class="stat">
          <div class="value">${learning}</div>
          <div class="label">覚えかけの語</div>
        </div>
      </div>

      <div class="card home-levels">
        ${LEVELS.map((level) => {
          const t = byTier.get(level.tier) ?? { total: 0, cleared: 0 };
          const pct = t.total > 0 ? Math.round((t.cleared / t.total) * 100) : 0;
          return `
            <div class="bar-row">
              <span class="bar-label">${level.name}</span>
              <span class="bar-track">
                <span class="bar-fill" style="width:${pct}%"></span>
              </span>
              <span class="bar-value">${t.cleared}/${t.total}</span>
            </div>`;
        }).join("")}
        <p class="note">目安は ${LEVELS.map((l) => l.goal.replace("TOEIC ", "")).join(" → ")}（TOEIC）</p>
      </div>

      <button class="primary home-start" data-start>
        ${started ? "つづける" : "はじめる"}
      </button>
    </div>`;

  root.querySelector<HTMLButtonElement>("[data-start]")!.addEventListener("click", () => {
    // まずパートを選ばせる。どこをやるかを決めてから問題に入る。
    app.homeOpen = false;
    app.partPickerOpen = true;
    rerender();
  });
}
