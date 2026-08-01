import "./style.css";
import { registerSW } from "virtual:pwa-register";

import { boot, type App } from "./app.ts";
import { renderStudy } from "./study.ts";
import { renderGroups } from "./groups.ts";
import { renderStats } from "./stats.ts";
import { renderSettings } from "./settings.ts";
import { initSpeech } from "./speech.ts";
import { requestPersist } from "./storage.ts";

const BASE = import.meta.env.BASE_URL;

type ViewName = "study" | "stats" | "settings";

// パート選択は「学習」タブの中に入れてある。
// 別タブに分けると、どちらを開けばよいか分かりにくいため。
const TABS: { name: ViewName; icon: string; label: string }[] = [
  { name: "study", icon: "✏️", label: "学習" },
  { name: "stats", icon: "📊", label: "統計" },
  { name: "settings", icon: "⚙️", label: "設定" },
];

let app: App | null = null;
let currentView: ViewName = "study";

const root = document.getElementById("app")!;

function shell(): { view: HTMLElement } {
  root.innerHTML = `
    <main id="view"></main>
    <nav class="tabbar">
      ${TABS.map(
        (t) => `
        <button data-view="${t.name}">
          <span class="tab-icon">${t.icon}</span>${t.label}
        </button>`,
      ).join("")}
    </nav>`;

  for (const btn of root.querySelectorAll<HTMLButtonElement>("[data-view]")) {
    btn.addEventListener("click", () => {
      currentView = btn.dataset.view as ViewName;
      render();
    });
  }
  return { view: root.querySelector<HTMLElement>("#view")! };
}

let view: HTMLElement;

function render(): void {
  if (!app) return;
  for (const btn of root.querySelectorAll<HTMLButtonElement>("[data-view]")) {
    if (btn.dataset.view === currentView) {
      btn.setAttribute("aria-current", "page");
    } else {
      btn.removeAttribute("aria-current");
    }
  }
  view.scrollTop = 0;

  // 出題画面だけは1画面に収める。指の位置を変えずに答え続けられるよう、
  // スクロールで問題やキーボードが動かないようにする。
  const fixedHeight = currentView === "study" && !app.partPickerOpen;
  view.classList.toggle("fixed", fixedHeight);

  switch (currentView) {
    case "study":
      if (app.partPickerOpen) renderGroups(app, view, render);
      else renderStudy(app, view, render);
      break;
    case "stats":
      void renderStats(app, view);
      break;
    case "settings":
      void renderSettings(app, view, BASE, reload);
      break;
  }
}

async function reload(): Promise<void> {
  root.innerHTML = '<div class="loading">読み込み中…</div>';
  await start();
}

async function start(): Promise<void> {
  try {
    app = await boot(BASE);
  } catch (e) {
    root.innerHTML = `
      <div class="empty">
        <p>起動できませんでした。</p>
        <p style="font-size:14px">${e instanceof Error ? e.message : String(e)}</p>
      </div>`;
    return;
  }
  ({ view } = shell());
  render();
}

// オフライン動作のための Service Worker。
// 更新があれば次回起動時に自動で適用される。
registerSW({ immediate: true });

// 読み上げ音声は非同期に揃うので先に用意しておく
initSpeech();

// 学習データがブラウザに消されないよう、起動のたびに永続モードを要求する。
// 断られてもアプリは動くので結果は見ない（状態は設定画面で確認できる）。
void requestPersist();

void start();
