// 出題画面。
//
// 判定は3値。`unsure`（惜しい）のときはユーザーに自己申告させる。
// これが「合っているのにバツ」を構造的に防ぐ仕組みで、
// ここで集まる食い違いのログが訳語データを改善する材料になる。
//
// 出題中の問題は App が保持している（app.current）。描画のたびに次の語を
// 引くと、学習タブを押し直しただけで問題が変わってしまうため。

import { judge } from "../../vocab-core/src/normalizer.ts";
import { gradeFrom, isNew, review, type CardState } from "../../vocab-core/src/scheduler.ts";
import {
  activeCards,
  isCleared,
  streakOf,
  CLEAR_STREAK,
  COOLDOWN,
  FIRST_BATCH,
  POS_LABEL,
  STREAK_WEIGHT,
  WORKING_SET,
  type App,
} from "./app.ts";
import { KanaKeyboard } from "./kana-keyboard.ts";
import { speak } from "./speech.ts";
import { appendLog, saveCard, saveMeta, saveProgress } from "./storage.ts";

/** これより速く正解したら「即答」とみなす。 */
const QUICK_ANSWER_MS = 4000;

export function renderStudy(app: App, root: HTMLElement, rerender: () => void): void {
  const currentPart = app.meta.selectedGroups[0] ?? 1;
  const pool = activeCards(app);

  // --- パート表示バー ---------------------------------------------------
  // 学習画面から直接パートを選び直せるようにする。
  let total = 0;
  let cleared = 0;
  for (const w of app.vocabulary.words) {
    if (w.group !== currentPart) continue;
    total++;
    if (isCleared(app, w.id)) cleared++;
  }
  const partBar = `
    <button class="part-bar" data-part>
      <span class="part-main">
        <span class="part-name">パート ${currentPart}</span>
        <span class="part-progress">${cleared} / ${total} 語 クリア</span>
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
  //
  // 出題は連続正解数で決める。日付は見ない。
  //   ・クリア済み（3回連続正解）の語は出さない
  //   ・間違えた直後の語がいちばん出やすく、正解を重ねるほど出にくくなる
  //   ・一度出た語は COOLDOWN 問ぶん空けてから出す
  const clearedIds = new Set<number>();
  let inProgress = 0;
  for (const id of pool.keys()) {
    if (isCleared(app, id)) clearedIds.add(id);
    else if (!isNew(pool.get(id)!)) inProgress++;
  }

  // 新しい語を入れるか。
  //
  // 出題間隔を空けるには回す語が COOLDOWN より多く要るので、
  // そこに届くまでは速く、届いたあとはゆっくり入れる。
  // ただし最初の FIRST_BATCH 語を過ぎたら初見が続かないようにする
  // （初見ばかりが並ぶと全滅して手応えが無い）。
  const introduceNew =
    inProgress < WORKING_SET &&
    (inProgress < FIRST_BATCH
      ? true
      : inProgress <= COOLDOWN
        ? app.questionsSinceNew >= 1
        : app.questionsSinceNew >= 2);

  if (app.current === null) {
    const nextId = app.scheduler.nextWord(pool, app.today, app.meta.introducedToday, {
      ignoreDue: true,
      exclude: clearedIds,
      weightOf: (state: CardState) =>
        STREAK_WEIGHT[Math.min(streakOf(app, state.wordId), STREAK_WEIGHT.length - 1)],
      introduceNew,
    });
    if (nextId === null) {
      root.innerHTML = `
        ${partBar}
        <div class="empty">
          <p class="empty-big">パート ${currentPart} 完了！</p>
          <p>${total} 語すべてクリア</p>
        </div>`;
      bindPartBar();
      return;
    }
    // 初見が固まって出ないよう、初見からの間隔を数えておく
    app.questionsSinceNew = isNew(pool.get(nextId)!) ? 0 : app.questionsSinceNew + 1;

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

  /** この語の連続正解数。 */
  const streak = streakOf(app, question.wordId);

  /**
   * 解答する。
   *
   * 空のまま押した場合は「わからん」。判定を待たずに不正解として扱う。
   * 何か入れないと先へ進めないと、当てずっぽうを打つことになって
   * 記録が濁るし、連続正解のカウントも意味が薄れる。
   */
  function submit(value: string): void {
    const trimmed = value.trim();
    keyboard?.destroy();
    keyboard = null;
    question.phase = {
      kind: "judged",
      judgement: trimmed ? judge(trimmed, word.answers) : "wrong",
      input: trimmed,
      elapsedMs: performance.now() - question.shownAt,
    };
    draw();
  }

  function draw(): void {
    if (question.phase.kind === "asking") {
      container.innerHTML = `
        ${partBar}
        <div class="question">
          ${firstTime ? '<span class="badge">はじめて</span>' : streakMarks(streak)}
          <div class="word-row">
            <span class="word">${escapeHtml(word.word)}</span>
            <button class="speak-btn" data-speak aria-label="発音を聞く">🔊</button>
          </div>
          <div class="pos">${POS_LABEL[word.pos] ?? word.pos}</div>
        </div>
        <div class="answer-display" aria-live="polite" aria-label="入力中の解答">
          <span class="answer-text"></span><span class="caret"></span>
        </div>
        <div class="keyboard-slot"></div>`;

      // OS の IME を通さないので、漢字・カタカナへの変換が起こりえない。
      const display = container.querySelector<HTMLElement>(".answer-text")!;
      const box = container.querySelector<HTMLElement>(".answer-display")!;
      keyboard = new KanaKeyboard({
        onChange: (v) => {
          question.draft = v;
          display.textContent = v;
          // 文字数が増えても枠の高さを変えない。
          // 折り返して縦に伸びると、その下のキーボードがずれて
          // 打っている最中に指の位置が変わってしまう。
          box.style.fontSize = `${answerFontSize(v)}px`;
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
      // 許容解は全部並べると場所を食うだけなので、いくつかに絞る
      const others = word.answers.filter((a) => a !== word.reading).slice(0, 3);

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
              ? `<div class="answers">${escapeHtml(others.join(" / "))}</div>`
              : ""
          }
          <div class="your-input">${input ? escapeHtml(input) : "わからん"}</div>
        </div>
        <div class="streak-line">${streakPreview(judgement, streak)}</div>
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
      () => speak(word.word, app.meta.speechVolume),
    );
    bindPartBar();

    // 出題時に一度だけ自動で読み上げる
    if (question.phase.kind === "asking" && !question.spoken && app.meta.speechEnabled) {
      question.spoken = true;
      speak(word.word, app.meta.speechVolume);
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

    // 連続正解数の更新。まちがえたら 0 に戻す。
    // FSRS のカード状態も引き続き更新している（出題間隔の材料として残す）が、
    // クリア判定はこちらのカウンタだけを見る。
    const before = app.progress.get(question.wordId);
    const next = {
      wordId: question.wordId,
      streak: accepted ? (before?.streak ?? 0) + 1 : 0,
      misses: (before?.misses ?? 0) + (accepted ? 0 : 1),
    };
    app.progress.set(question.wordId, next);
    await saveProgress(next);

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

/**
 * クリアまでの進み具合。
 *
 * 丸を CLEAR_STREAK 個並べ、正解したぶんだけチェックを入れる。
 * 文字の ●○ だけでは何を表しているのか伝わらなかったので、
 * 「あと◯回」の短い添え字もつけている。
 *
 * @param justFilled 直前の正解で埋まった丸を目立たせる
 */
function streakMarks(streak: number, justFilled = false): string {
  const done = Math.min(Math.max(streak, 0), CLEAR_STREAK);
  const marks = Array.from({ length: CLEAR_STREAK }, (_, i) => {
    const on = i < done;
    const fresh = on && justFilled && i === done - 1;
    return `<i class="${on ? "on" : ""}${fresh ? " fresh" : ""}"></i>`;
  }).join("");
  const left = CLEAR_STREAK - done;
  return `<span class="streak">${marks}<b>${
    left === 0 ? "クリア！" : `あと${left}回`
  }</b></span>`;
}

/**
 * 判定後に、クリアまであと何回かを見せる。
 * 「惜しい」はこのあとの自己申告で結果が決まるので何も出さない。
 */
function streakPreview(judgement: string, streak: number): string {
  if (judgement === "unsure") return "";
  if (judgement !== "correct") return streakMarks(0);
  return streakMarks(streak + 1, true);
}

/**
 * 入力欄の文字サイズ。1行に収まるよう文字数に応じて縮める。
 * 折り返させないことで枠の高さが変わらず、下のキーボードが動かない。
 */
function answerFontSize(value: string): number {
  const n = [...value].length;
  const FULL = 26;      // これ以下の文字数なら等倍
  const FITS = 9;
  // MAX_LENGTH(24文字) まで打っても横にはみ出さない大きさ
  const MIN = 12;
  if (n <= FITS) return FULL;
  return Math.max(MIN, Math.round((FULL * FITS) / n));
}

/** 単語データは信頼できるが、ユーザー入力を混ぜて描画するので必ず通す。 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
