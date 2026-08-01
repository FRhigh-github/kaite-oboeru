// 設定画面。
//
// **出典表示はライセンス上の必須要件**（CC BY-SA 4.0 / EDRDG）。
// EDRDG のライセンスは起動画面での言及では不十分で、
// メニューから開ける独立した画面での表示を求めている。削除しないこと。

import type { App } from "./app.ts";
import { speak } from "./speech.ts";
import {
  clearAll,
  exportBackup,
  importBackup,
  persistState,
  requestPersist,
  saveMeta,
  type Backup,
  type PersistState,
} from "./storage.ts";
import { escapeHtml } from "./study.ts";

export async function renderSettings(
  app: App,
  root: HTMLElement,
  baseUrl: string,
  reload: () => void,
): Promise<void> {
  root.innerHTML = `
    <h2>設定</h2>

    <div class="card">
      <h3>学習データの保存</h3>
      <p class="note" data-role="persist">確認中…</p>
      <div class="settings-actions" style="margin-top:12px" data-role="persist-action" hidden>
        <button class="secondary" data-action="persist">消えないようにする</button>
      </div>
      <details class="fold">
        <summary>手動バックアップ</summary>
        <div class="settings-actions" style="margin-top:12px">
          <button class="secondary" data-action="export">書き出す</button>
          <button class="secondary" data-action="import">読み込む</button>
        </div>
      </details>
      <input type="file" accept="application/json,.json" hidden data-role="file" />
    </div>

    <div class="card">
      <h3>発音</h3>
      <label class="toggle-row">
        <span>自動で読み上げる</span>
        <input type="checkbox" data-role="speech"
               ${app.meta.speechEnabled ? "checked" : ""} />
      </label>

      <div class="slider-row">
        <div class="slider-head">
          <span>音量</span>
          <span data-role="volume-value">${Math.round(app.meta.speechVolume * 100)}%</span>
        </div>
        <div class="slider-line">
          <input type="range" min="0" max="100" step="5" data-role="volume"
                 value="${Math.round(app.meta.speechVolume * 100)}" />
          <button class="icon-btn" data-action="test-speech"
                  aria-label="音量を試す">🔊</button>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>このアプリ</h3>
      <p class="note">
        ${app.vocabulary.words.length} 語 ・ ${escapeHtml(app.meta.dayZero)} から ${app.today} 日目
      </p>
    </div>

    <div class="card">
      <h3>出典・ライセンス</h3>
      <div class="attribution" data-role="attribution">読み込み中…</div>
    </div>

    <div class="card">
      <h3>データの消去</h3>
      <p class="warning">取り消せません</p>
      <div class="settings-actions" style="margin-top:14px">
        <button class="secondary danger" data-action="clear">消去する</button>
      </div>
    </div>
  `;

  const fileInput = root.querySelector<HTMLInputElement>('[data-role="file"]')!;

  // 保存領域が保護されているか。要求はユーザー操作の中だと通りやすいので、
  // 保護されていないときだけボタンを出す。
  const persistText = root.querySelector<HTMLElement>('[data-role="persist"]')!;
  const persistAction = root.querySelector<HTMLElement>('[data-role="persist-action"]')!;

  const showPersist = (state: PersistState): void => {
    persistText.textContent = {
      persisted: "この端末に保存されています。勝手に消えません",
      denied: "端末の空きが減ると消えることがあります",
      unsupported: "このブラウザでは保護できません。ときどき書き出してください",
    }[state];
    persistAction.hidden = state !== "denied";
  };

  showPersist(await persistState());

  root.querySelector<HTMLButtonElement>('[data-action="persist"]')!
    .addEventListener("click", async () => {
      showPersist(await requestPersist());
    });

  root.querySelector<HTMLInputElement>('[data-role="speech"]')!
    .addEventListener("change", async (e) => {
      const on = (e.target as HTMLInputElement).checked;
      app.meta = { ...app.meta, speechEnabled: on };
      await saveMeta(app.meta);
    });

  // 音量。つまみを動かしている間は表示だけ更新し、離したときに保存する。
  const volume = root.querySelector<HTMLInputElement>('[data-role="volume"]')!;
  const volumeValue = root.querySelector<HTMLElement>('[data-role="volume-value"]')!;
  volume.addEventListener("input", () => {
    volumeValue.textContent = `${volume.value}%`;
  });
  volume.addEventListener("change", async () => {
    app.meta = { ...app.meta, speechVolume: Number(volume.value) / 100 };
    await saveMeta(app.meta);
    // その場で聞いて決められるようにする
    speak("volume", app.meta.speechVolume);
  });

  root.querySelector<HTMLButtonElement>('[data-action="test-speech"]')!
    .addEventListener("click", () => {
      speak("example", Number(volume.value) / 100);
    });

  root.querySelector<HTMLButtonElement>('[data-action="export"]')!
    .addEventListener("click", async () => {
      const backup = await exportBackup();
      const blob = new Blob([JSON.stringify(backup, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `eitango-backup-${backup.exportedAt.slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

  root.querySelector<HTMLButtonElement>('[data-action="import"]')!
    .addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text()) as Backup;
      if (!confirm("現在の学習データを、読み込むバックアップで置き換えます。よろしいですか？")) {
        return;
      }
      await importBackup(backup);
      alert("読み込みました。");
      reload();
    } catch (e) {
      alert(`読み込めませんでした: ${e instanceof Error ? e.message : e}`);
    } finally {
      fileInput.value = "";
    }
  });

  root.querySelector<HTMLButtonElement>('[data-action="clear"]')!
    .addEventListener("click", async () => {
      if (!confirm("学習データをすべて消去します。取り消せません。よろしいですか？")) return;
      if (!confirm("本当によろしいですか？")) return;
      await clearAll();
      reload();
    });

  // 出典表示（ライセンス必須項目）
  const target = root.querySelector<HTMLElement>('[data-role="attribution"]')!;
  try {
    const res = await fetch(`${baseUrl}data/ATTRIBUTION.md`);
    target.innerHTML = renderMarkdownLite(await res.text());
  } catch {
    target.textContent =
      "出典情報を読み込めませんでした。ネットワークに接続して再度お試しください。";
  }
}

/**
 * 出典表示のためだけの最小限の Markdown 描画。
 * 見出し・リンク・箇条書きだけを扱う。汎用の Markdown 処理ではない。
 */
function renderMarkdownLite(md: string): string {
  return md
    .split("\n")
    .map((line) => {
      const escaped = escapeHtml(line)
        .replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      if (line.startsWith("### ")) return `<div style="font-weight:600;margin-top:12px">${escaped.slice(4)}</div>`;
      if (line.startsWith("## ")) return `<div style="font-weight:600;margin-top:14px">${escaped.slice(3)}</div>`;
      if (line.startsWith("# ")) return `<div style="font-weight:600;font-size:15px">${escaped.slice(2)}</div>`;
      if (line.startsWith("- ")) return `<div style="margin-left:1em">・${escaped.slice(2)}</div>`;
      return escaped;
    })
    .join("\n");
}
