// 出題画面。
//
// 判定は3値。`unsure`（惜しい）のときはユーザーに自己申告させる。
// これが「合っているのにバツ」を構造的に防ぐ仕組みで、
// ここで集まる食い違いのログが訳語データを改善する材料になる。
//
// 出題中の問題は App が保持している（app.current）。描画のたびに次の語を
// 引くと、学習タブを押し直しただけで問題が変わってしまうため。

import { judge } from "../../vocab-core/src/normalizer.ts";
import { gradeFrom, isNew, retrievabilityOn, review } from "../../vocab-core/src/scheduler.ts";
import { activeCards, POS_LABEL, type App } from "./app.ts";
import { KanaKeyboard } from "./kana-keyboard.ts";
import { speak } from "./speech.ts";
import { appendLog, saveCard, saveMeta } from "./storage.ts";

/** これより速く正解したら「即答」とみなす。 */
const QUICK_ANSWER_MS = 4000;
/** この想起率以上を「覚えた」とみなす（パートの進捗表示用）。 */
const MASTERED_THRESHOLD = 0.9;

export function renderStudy(app: App, root: HTMLElement, rerender: () => void): void {
  const currentPart = app.meta.selectedGroups[0] ?? 1;
  const pool = activeCards(app);

  // --- パート表示バー ---------------------------------------------------
  // 学習画面から直接パートを選び直せるようにする。
  let total = 0;
  let mastered = 0;
  for (const w of app.vocabulary.words) {
    if (w.group !== currentPart) continue;
    total++;
    const card = app.cards.get(w.id);
    if (card && !isNew(card) && retrievabilityOn(card, app.today) >= MASTERED_THRESHOLD) {
      mastered++;
    }
  }
  const partBar = `
    <button class="part-bar" data-part>
      <span class="part-main">
        <span class="part-name">パート ${currentPart}</span>
        <span class="part-progress">${mastered} / ${total} 語 おぼえた</span>
      </span>
      <span class="part-action">パートを<br>えらぶ<span class="part-chevron">›</span></span>
    </button>`;

  const bindPartBar = () => {
    root.querySelector<HTMLButtonElement>("[data-part]")?.addEventListener("click", () => {
      app.partPickerOpen = true;
      rerender();
    });
  };

  // --- 出題中の問題を用意する ---------------------------------------------
  if (app.current === null) {
    const nextId = app.scheduler.nextWord(pool, app.today, app.meta.introducedToday);
    if (nextId === null) {
      root.innerHTML = `
        ${partBar}
        <div class="empty">
          <p>パート ${currentPart} の今日ぶんは終わりです。</p>
          <p>また明日どうぞ。</p>
          <p style="font-size:14px;margin-top:24px">
            先へ進むときは上の「パートをえらぶ」から<br>次のパートを選んでください。
          </p>
        </div>`;
      bindPartBar();
      return;
    }
    app.current = {
      wordId: nextId,
      shownAt: performance.now(),
      draft: "",
      phase: { kind: "asking" },
      spoken: false,
    };
  }

  const question = app.current;
  const word = app.words.get(question.wordId)!;
  const card = app.cards.get(question.wordId)!;
  const firstTime = isNew(card);
  let keyboard: KanaKeyboard | null = null;

  const container = document.createElement("div");
  container.className = "study";
  root.replaceChildren(container);

  function dueCount(): number {
    let n = 0;
    for (const c of pool.values()) {
      if (!isNew(c) && c.dueDay <= app.today) n++;
    }
    return n;
  }

  function submit(value: string): void {
    const trimmed = value.trim();
    if (!trimmed) return;
    keyboard?.destroy();
    keyboard = null;
    question.phase = {
      kind: "judged",
      judgement: judge(trimmed, word.answers),
      input: trimmed,
      elapsedMs: performance.now() - question.shownAt,
    };
    draw();
  }

  function draw(): void {
    if (question.phase.kind === "asking") {
      container.innerHTML = `
        ${partBar}
        <div class="progress">
          <span>今日の解答 ${app.answeredThisSession}</span>
          <span>復習待ち ${dueCount()}</span>
        </div>
        <div class="question">
          ${firstTime ? '<span class="badge">はじめて</span>' : ""}
          <div class="word-row">
            <span class="word">${escapeHtml(word.word)}</span>
            <button class="speak-btn" data-speak aria-label="発音を聞く">🔊</button>
          </div>
          <div class="pos">${POS_LABEL[word.pos] ?? word.pos}</div>
        </div>
        <div class="answer-display" aria-live="polite" aria-label="入力中の解答">
          <span class="answer-text"></span><span class="caret"></span>
        </div>
        <p class="hint">だいたい合っていれば正解です。</p>
        <div class="keyboard-slot"></div>`;

      // OS の IME を通さないので、漢字・カタカナへの変換が起こりえない。
      const display = container.querySelector<HTMLElement>(".answer-text")!;
      keyboard = new KanaKeyboard({
        onChange: (v) => {
          question.draft = v;
          display.textContent = v;
        },
        onSubmit: submit,
      });
      keyboard.mount(container.querySelector<HTMLElement>(".keyboard-slot")!);
      // 入力途中でタブを移動しても消えないよう復元する
      if (question.draft) keyboard.setValue(question.draft);
    } else {
      const { judgement, input } = question.phase;
      const verdict =
        judgement === "correct" ? "正解" : judgement === "unsure" ? "惜しい" : "不正解";
      const others = word.answers.filter((a) => a !== word.reading);

      container.innerHTML = `
        ${partBar}
        <div class="result ${judgement}">
          <div class="verdict">${verdict}</div>
          <div class="word-row">
            <span class="result-word">${escapeHtml(word.word)}</span>
            <button class="speak-btn" data-speak aria-label="発音を聞く">🔊</button>
          </div>
          <div class="meaning">${escapeHtml(word.meaning)}</div>
          <div class="reading">${escapeHtml(word.reading)}</div>
          ${
            others.length > 0
              ? `<div class="answers">ほかの許容解: ${escapeHtml(others.join("、"))}</div>`
              : ""
          }
          <div class="your-input">あなたの解答: ${escapeHtml(input)}</div>
        </div>
        ${
          judgement === "unsure"
            ? `<div class="self-report">
                 <button class="secondary" data-self="no">ちがった</button>
                 <button class="primary" data-self="yes">合ってた</button>
               </div>`
            : `<button class="primary" data-next="1">つぎへ</button>`
        }`;

      if (judgement === "unsure") {
        for (const btn of container.querySelectorAll<HTMLButtonElement>("[data-self]")) {
          btn.addEventListener("click", () => void finish(btn.dataset.self === "yes"));
        }
      } else {
        container
          .querySelector<HTMLButtonElement>("[data-next]")!
          .addEventListener("click", () => void finish(judgement === "correct"));
      }
    }

    container.querySelector<HTMLButtonElement>("[data-speak]")?.addEventListener(
      "click",
      () => speak(word.word),
    );
    bindPartBar();

    // 出題時に一度だけ自動で読み上げる
    if (question.phase.kind === "asking" && !question.spoken && app.meta.speechEnabled) {
      question.spoken = true;
      speak(word.word);
    }
  }

  async function finish(accepted: boolean): Promise<void> {
    if (question.phase.kind !== "judged") return;
    const { judgement, input, elapsedMs } = question.phase;

    const grade = gradeFrom(judgement, {
      selfReportedCorrect: accepted,
      answeredQuickly: elapsedMs < QUICK_ANSWER_MS,
    });

    const updated = review(card, grade, app.today);
    app.cards.set(question.wordId, updated);
    app.answeredThisSession++;

    if (firstTime) {
      app.meta = { ...app.meta, introducedToday: app.meta.introducedToday + 1 };
      await saveMeta(app.meta);
    }

    await saveCard(updated);
    // 判定とユーザーの最終判断が食い違ったケースが、訳語改善の材料になる。
    await appendLog({
      wordId: question.wordId,
      day: app.today,
      at: new Date().toISOString(),
      input,
      judgement,
      accepted,
      grade,
      elapsedMs: Math.round(elapsedMs),
    });

    // 次の語へ進む
    app.current = null;
    rerender();
  }

  draw();
}

/** 単語データは信頼できるが、ユーザー入力を混ぜて描画するので必ず通す。 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
