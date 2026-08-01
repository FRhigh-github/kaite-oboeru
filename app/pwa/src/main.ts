import "./style.css";
import { registerSW } from "virtual:pwa-register";

import { boot, type App } from "./app.ts";
import { renderStudy } from "./study.ts";
import { renderGroups } from "./groups.ts";
import { renderStats } from "./stats.ts";
import { renderSettings } from "./settings.ts";
import { initSpeech } from "./speech.ts";

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

void start();
