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
  dueAtOf,
  GAP_CORRECT,
  GAP_WRONG,
  POS_LABEL,
  STREAK_WEIGHT,
  WORKING_SET,
  wrongStreakOf,
  type App,
} from "./app.ts";
import { backupDue, saveBackup } from "./backup.ts";
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

  // --- バックアップの呼びかけ -------------------------------------------
  // 端末の初期化やアプリの削除では、端末内のデータはどうやっても消える。
  // 使い始めてしばらくたったときと、そのあと月に一度だけ声をかける。
  const notice =
    backupDue(app) && !app.backupNoticeClosed
      ? `<div class="notice">
           <span>学習データを保存しておきませんか</span>
           <span class="notice-actions">
             <button data-backup>保存</button>
             <button data-backup-close aria-label="閉じる">×</button>
           </span>
         </div>`
      : "";

  const bindPartBar = () => {
    root.querySelector<HTMLButtonElement>("[data-part]")?.addEventListener("click", () => {
      app.partPickerOpen = true;
      rerender();
    });
    root.querySelector<HTMLButtonElement>("[data-backup]")?.addEventListener("click", async () => {
      if (await saveBackup(app)) app.backupNoticeClosed = true;
      rerender();
    });
    root.querySelector<HTMLButtonElement>("[data-backup-close]")?.addEventListener("click", () => {
      app.backupNoticeClosed = true;
      rerender();
    });
  };

  // --- 出題中の問題を用意する ---------------------------------------------
  //
  // 出題は「解いた問題数」で決める。日付は見ない。
  //   ・クリア済み（3回連続正解）の語は出さない
  //   ・まちがえた語は GAP_WRONG 問後、あたった語は GAP_CORRECT 問後に戻す
  //   ・出す予定が来た語のうち、最も待たせている語から出す（同着なら抽選）
  const clearedIds = new Set<number>();
  let inProgress = 0;
  let dueNow = 0;
  for (const [id, card] of pool) {
    if (isCleared(app, id)) clearedIds.add(id);
    else if (!isNew(card)) {
      inProgress++;
      if (dueAtOf(app, id) <= app.meta.askedCount) dueNow++;
    }
  }

  // 新しい語を入れるか。
  //
  // 出す予定が来た語が1つも無いときだけ入れる。
  // ここで予定前の語を繰り上げて出すと、間隔の決まりが崩れて
  // 「さっき出た語がまた出る」ことになる。空いた枠は初見で埋める。
  const introduceNew = inProgress < WORKING_SET && dueNow === 0;

  if (app.current === null) {
    const nextId = app.scheduler.nextWord(pool, app.today, app.meta.introducedToday, {
      ignoreDue: true,
      exclude: clearedIds,
      weightOf: (state: CardState) =>
        STREAK_WEIGHT[Math.min(streakOf(app, state.wordId), STREAK_WEIGHT.length - 1)],
      // 予定の早い語から出す。予定より遅れている語が複数あっても、
      // いちばん長く待たせている語が先。
      preferOrder: (state: CardState) => dueAtOf(app, state.wordId),
      introduceNew,
    });
    if (nextId === null) {
      root.innerHTML = `
        ${partBar}${notice}
        <div class="empty">
          <p class="empty-big">パート ${currentPart} 完了！</p>
          <p>${total} 語すべてクリア</p>
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

  /** この語の連続正解数。 */
  const streak = streakOf(app, question.wordId);
  /** この語で連続してまちがえている回数。 */
  const wrongStreak = wrongStreakOf(app, question.wordId);

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
      judgement: trimmed ? judge(trimmed, word.answers, word.near) : "wrong",
      input: trimmed,
      elapsedMs: performance.now() - question.shownAt,
    };
    // 不正解がはっきりしていて書き取りをする設定なら、「つぎへ」を挟まない。
    // 押しても同じ画面のまま書き取りに変わるだけで、1タップ増えるだけになる。
    if (question.phase.judgement === "wrong" && app.meta.retypeOnWrong) {
      void finish(false);
      return;
    }
    draw();
  }

  /**
   * 入力欄とキーボードを組み立てる。出題と書き取りで同じものを使う。
   *
   * @param initial   復元する入力途中の文字列
   * @param onChange  1文字打つたびに呼ばれる
   * @param onSubmit  「こたえる」を押したとき
   */
  function mountKeyboard(
    initial: string,
    onChange: (v: string) => void,
    onSubmit: (v: string) => void,
    allowGiveUp = true,
  ): void {
    // OS の IME を通さないので、漢字・カタカナへの変換が起こりえない。
    const display = container.querySelector<HTMLElement>(".answer-text")!;
    const box = container.querySelector<HTMLElement>(".answer-display")!;
    keyboard = new KanaKeyboard({
      onChange: (v) => {
        display.textContent = v;
        // 文字数が増えても枠の高さを変えない。
        // 折り返して縦に伸びると、その下のキーボードがずれて
        // 打っている最中に指の位置が変わってしまう。
        box.style.fontSize = `${answerFontSize(v)}px`;
        onChange(v);
      },
      onSubmit,
      toggleInput: app.meta.toggleInput,
      allowGiveUp,
    });
    keyboard.mount(container.querySelector<HTMLElement>(".keyboard-slot")!);
    // 入力途中でタブを移動しても消えないよう復元する
    if (initial) keyboard.setValue(initial);
  }

  function draw(): void {
    if (question.phase.kind === "asking") {
      container.innerHTML = `
        ${partBar}${notice}
        <div class="question">
          ${firstTime ? '<span class="badge">はじめて</span>' : streakMarks(streak, false, wrongStreak)}
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

      mountKeyboard(question.draft, (v) => (question.draft = v), submit);
    } else {
      // 判定結果。書き取り中も同じ画面のまま、下だけキーボードに差し替える。
      // 別画面に送ると解説が消えてしまい、何を写しているのか分からなくなる。
      const phase = question.phase;
      const retyping = phase.kind === "retype";
      // 書き取り中はキーボードを出すぶん高さが要る。紙を伸ばして
      // 余白を吸わせ、下の要素と離れないようにする（CSS 側で使う）。
      container.classList.toggle("study-retype", retyping);
      const { judgement, input } = phase;
      const verdict =
        judgement === "correct" ? "正解" : judgement === "unsure" ? "惜しい" : "不正解";
      // 許容解は全部並べると場所を食うだけなので、いくつかに絞る
      const others = word.answers.filter((a) => a !== word.reading).slice(0, 3);

      container.innerHTML = `
        ${partBar}${notice}
        <div class="result ${judgement}${retyping ? " retyping" : ""}">
          <div class="verdict">${verdict}</div>
          <div class="word-row">
            <span class="result-word">${escapeHtml(word.word)}</span>
            <button class="speak-btn" data-speak aria-label="発音を聞く">🔊</button>
          </div>
          <div class="meaning">${escapeHtml(word.meaning)}</div>
          <div class="reading">${escapeHtml(word.reading)}</div>
          ${
            // 書き取り中は許容解を出さない。写すのは上の読みひとつなので、
            // ほかの言い方を並べるとどれを打てばいいのか分からなくなる。
            // 画面に入りきらずスクロールが要るようになるのも避けたい。
            others.length > 0 && !retyping
              ? `<div class="answers">${escapeHtml(others.join(" / "))}</div>`
              : ""
          }
          <div class="your-input">${input ? escapeHtml(input) : "わからん"}</div>
          ${
            retyping
              ? `<div class="retype-hint${phase.missed ? " missed" : ""}">${
                  phase.missed
                    ? "ちがいます。上の読みをもう一度"
                    : "上の読みを打って「こたえる」"
                }</div>`
              : ""
          }
        </div>
        <div class="streak-line">${streakPreview(
          judgement,
          streak,
          // 書き取りに入った時点で記録は書き終わっている（wrongStreak は更新済み）。
          // 判定を出しただけの段階では、これから足される1回ぶんを見越して足す。
          // 数え方を揃えないと、書き取り中にタブを行き来したときに増えてしまう。
          retyping ? wrongStreak : wrongStreak + 1,
        )}</div>
        ${
          retyping
            ? `<div class="answer-display${phase.missed ? " shake" : ""}"
                    aria-live="polite" aria-label="入力中の解答">
                 <span class="answer-text"></span><span class="caret"></span>
               </div>
               <div class="keyboard-slot"></div>`
            : judgement === "unsure"
              ? `<div class="self-report">
                   <button class="secondary" data-self="no">ちがった</button>
                   <button class="primary" data-self="yes">合ってた</button>
                 </div>`
              : `<button class="primary" data-next="1">つぎへ</button>`
        }`;

      if (retyping) {
        // 正しく打てるまで次へ進まない。まちがえた形のまま終わらせない。
        //
        // 打っている途中では判定しない。合った瞬間に画面が変わると、
        // 打ち終える前に勝手に進んだように見えるし、書き直したい途中の
        // 文字列がたまたま一致しただけでも先へ行ってしまう。
        // 進むのは「こたえる」を押したときだけにする。
        mountKeyboard(
          phase.typed,
          (v) => (phase.typed = v),
          (v) => {
            if (judge(v.trim(), [word.reading], []) === "correct") advance();
            else {
              question.phase = { ...phase, typed: v, missed: true };
              draw();
            }
          },
          // 書き取りに「わからん」は無い。答えは目の前に出ている。
          false,
        );
        // キーボードを置いたあとの、実際に残った高さで測る
        fitPaper(container.querySelector<HTMLElement>(".result")!);
      } else if (judgement === "unsure") {
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

  /** 次の語へ進む。 */
  function advance(): void {
    keyboard?.destroy();
    keyboard = null;
    app.current = null;
    rerender();
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

    // 出題間隔は「解いた問題数」で数える。この1問ぶんを進めてから予定を書く。
    const asked = app.meta.askedCount + 1;
    app.meta = {
      ...app.meta,
      askedCount: asked,
      introducedToday: app.meta.introducedToday + (firstTime ? 1 : 0),
    };
    await saveMeta(app.meta);

    // 連続正解数の更新。まちがえたら 0 に戻す。
    // FSRS のカード状態も引き続き更新している（出題間隔の材料として残す）が、
    // クリア判定はこちらのカウンタだけを見る。
    const before = app.progress.get(question.wordId);
    const next = {
      wordId: question.wordId,
      streak: accepted ? (before?.streak ?? 0) + 1 : 0,
      misses: (before?.misses ?? 0) + (accepted ? 0 : 1),
      wrongStreak: accepted ? 0 : (before?.wrongStreak ?? 0) + 1,
      // まちがえた語は早く、あたった語は遅く戻す
      dueAt: asked + (accepted ? GAP_CORRECT : GAP_WRONG),
    };
    app.progress.set(question.wordId, next);
    await saveProgress(next);

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

    // まちがえた語は、模範解答を1度書いてから次へ進む（設定で切れる）。
    // 見ただけで進むより、手を動かしたほうが形が残る。
    if (!accepted && app.meta.retypeOnWrong) {
      question.phase = { kind: "retype", judgement, input, typed: "", missed: false };
      draw();
      return;
    }
    advance();
  }

  draw();
}

/**
 * 紙の中身が入りきらないときだけ、収まるまで文字を縮める。
 *
 * 書き取り中はキーボードのぶんだけ紙が薄くなる。入る量は端末の高さと
 * その語の訳の長さの掛け算で決まるので、CSS で一律に決め打ちすると
 * どちらかで外れる。実際に置いてみて、はみ出したぶんだけ縮める。
 *
 * 縮めるのは紙の中の文字だけ（`--fit` を CSS 側で掛けている）。
 * 紙の外側の高さは変わらないので、下のキーボードは動かない。
 *
 * スクロールさせない理由は、写す先の読みが画面から消えてしまうため。
 * 下限を切ってもなお入らないときだけ、スクロールに逃がす。
 */
function fitPaper(paper: HTMLElement): void {
  const MIN = 0.5;
  const STEP = 0.04;
  let scale = 1;
  paper.style.setProperty("--fit", "1");
  while (paper.scrollHeight > paper.clientHeight + 1 && scale > MIN) {
    scale -= STEP;
    paper.style.setProperty("--fit", scale.toFixed(2));
  }
}

/**
 * クリアまでの進み具合。
 *
 * 丸を CLEAR_STREAK 個並べ、正解したぶんだけチェックを入れる。
 * 文字の ●○ だけでは何を表しているのか伝わらなかったので、
 * 「あと◯回」の短い添え字もつけている。
 *
 * 連続してまちがえている語には、その回数を添える。丸が0個のままなのが
 * 「まだ始めていない」のか「何度も落としている」のかを見分けられるようにする。
 *
 * @param justFilled  直前の正解で埋まった丸を目立たせる
 * @param wrongStreak 連続してまちがえている回数。0 なら何も出さない。
 */
function streakMarks(streak: number, justFilled = false, wrongStreak = 0): string {
  const done = Math.min(Math.max(streak, 0), CLEAR_STREAK);
  const marks = Array.from({ length: CLEAR_STREAK }, (_, i) => {
    const on = i < done;
    const fresh = on && justFilled && i === done - 1;
    return `<i class="${on ? "on" : ""}${fresh ? " fresh" : ""}"></i>`;
  }).join("");
  const left = CLEAR_STREAK - done;
  // 連続でまちがえているあいだは「あと◯回」を出さない。
  // まちがえた直後は必ず「あと3回」に戻っていて、読んでも何も分からないうえ、
  // いま伝えたいのは「この語でつまずいている」ことのほうだから。
  const text =
    wrongStreak > 0
      ? `<em class="streak-miss">${wrongStreak}回連続でミス</em>`
      : `<b>${left === 0 ? "クリア！" : `あと${left}回`}</b>`;
  return `<span class="streak">${marks}${text}</span>`;
}

/**
 * 判定後に、クリアまであと何回かを見せる。
 * 「惜しい」はこのあとの自己申告で結果が決まるので何も出さない。
 */
function streakPreview(judgement: string, streak: number, wrongStreak: number): string {
  if (judgement === "unsure") return "";
  if (judgement !== "correct") return streakMarks(0, false, wrongStreak);
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
