// ひらがな専用のキーボード。フリック入力とトグル入力の両方で打てる。
//
// OS の IME を一切通さないので、漢字やカタカナへの変換が構造的に起こらない。
// `<input>` を使うと IME が介在してしまうため、表示は div で行い
// 文字列はこのクラスが完全に保持する。
//
// フリックだけにしないのには理由が2つある。
//   ・フリックが苦手な人でも打てるようにするため
//   ・フリック入力には日本で特許が成立しており（2007年出願・現在も存続）、
//     唯一の入力手段にすると権利に依存することになるため
// トグル入力（キーを連打して あ→い→う→え→お と巡回する方式）は
// 携帯電話で古くから使われてきた方式で、単独で完結する。

/** [中央, 左, 上, 右, 下] の順。空文字はその方向に文字が無いことを表す。 */
type FlickSet = [string, string, string, string, string];

type KeyDef =
  /** フリックで5方向に文字を持つキー */
  | { kind: "flick"; label: string; flick: FlickSet }
  /** 1文字だけの単純なキー */
  | { kind: "char"; label: string; char: string }
  /** 機能キー */
  | { kind: "fn"; label: string; fn: "back" | "cycle" | "submit"; tall?: boolean };

/** 入力があるときの送信キー。 */
const SUBMIT_LABEL = "こたえる";
/**
 * 何も入力していないときの送信キー。
 * 押すとそのまま不正解になるので、色を変えて取り違えを防ぐ。
 */
const GIVE_UP_LABEL = "わからん";

/**
 * 配置（左上から行方向）。
 *
 *   あ か さ ⌫
 *   た な は ┌────┐
 *   ま や ら │こたえる│   ← 3行ぶんの縦長
 *   小 わ ー └────┘
 */
const LAYOUT: KeyDef[] = [
  { kind: "flick", label: "あ", flick: ["あ", "い", "う", "え", "お"] },
  { kind: "flick", label: "か", flick: ["か", "き", "く", "け", "こ"] },
  { kind: "flick", label: "さ", flick: ["さ", "し", "す", "せ", "そ"] },
  // ⌫ の記号は端末によって極端に小さく描かれるので文字で書く
  { kind: "fn", label: "けす", fn: "back" },

  { kind: "flick", label: "た", flick: ["た", "ち", "つ", "て", "と"] },
  { kind: "flick", label: "な", flick: ["な", "に", "ぬ", "ね", "の"] },
  { kind: "flick", label: "は", flick: ["は", "ひ", "ふ", "へ", "ほ"] },
  // 何も入力していないときは「わからん」に変わる（updateSubmitKey）
  { kind: "fn", label: SUBMIT_LABEL, fn: "submit", tall: true },

  { kind: "flick", label: "ま", flick: ["ま", "み", "む", "め", "も"] },
  { kind: "flick", label: "や", flick: ["や", "", "ゆ", "", "よ"] },
  { kind: "flick", label: "ら", flick: ["ら", "り", "る", "れ", "ろ"] },

  { kind: "fn", label: "小゛゜", fn: "cycle" },
  // ん は「わ」の上フリックでも出せる
  { kind: "flick", label: "わ", flick: ["わ", "を", "ん", "", ""] },
  { kind: "char", label: "ー", char: "ー" },
];

/**
 * 濁点・半濁点・小文字の巡回表。
 * 「小゛゜」キーを押すたびに直前の文字がこの順で変化する。
 */
const CYCLE: Record<string, string> = {
  あ: "ぁ", ぁ: "あ",
  い: "ぃ", ぃ: "い",
  う: "ぅ", ぅ: "ゔ", ゔ: "う",
  え: "ぇ", ぇ: "え",
  お: "ぉ", ぉ: "お",
  か: "が", が: "か",
  き: "ぎ", ぎ: "き",
  く: "ぐ", ぐ: "く",
  け: "げ", げ: "け",
  こ: "ご", ご: "こ",
  さ: "ざ", ざ: "さ",
  し: "じ", じ: "し",
  す: "ず", ず: "す",
  せ: "ぜ", ぜ: "せ",
  そ: "ぞ", ぞ: "そ",
  た: "だ", だ: "た",
  ち: "ぢ", ぢ: "ち",
  // 小文字が先。「っ」は「づ」よりはるかに多く使うので手前に置く
  つ: "っ", っ: "づ", づ: "つ",
  て: "で", で: "て",
  と: "ど", ど: "と",
  は: "ば", ば: "ぱ", ぱ: "は",
  ひ: "び", び: "ぴ", ぴ: "ひ",
  ふ: "ぶ", ぶ: "ぷ", ぷ: "ふ",
  へ: "べ", べ: "ぺ", ぺ: "へ",
  ほ: "ぼ", ぼ: "ぽ", ぽ: "ほ",
  や: "ゃ", ゃ: "や",
  ゆ: "ゅ", ゅ: "ゆ",
  よ: "ょ", ょ: "よ",
  わ: "ゎ", ゎ: "わ",
};

/** この距離(px)を超えて動かしたらフリックとみなす。 */
const FLICK_THRESHOLD = 24;
const MAX_LENGTH = 24;

/**
 * 同じキーを続けて押したとき、トグルとみなす間隔(ms)。
 *
 * これを過ぎたら新しい文字として足す。「かかく」のように同じ行の文字が
 * 続く語を打てるようにするために要る。
 */
const TOGGLE_WINDOW_MS = 900;

export interface KanaKeyboardOptions {
  onChange?(value: string): void;
  onSubmit?(value: string): void;
  /**
   * トグル入力を使うか。既定は使う。
   * 切ると、タップは常に中央の文字を足すだけになる（フリックは変わらない）。
   */
  toggleInput?: boolean;
}

export class KanaKeyboard {
  private text = "";
  private readonly options: KanaKeyboardOptions;
  private root: HTMLElement | null = null;
  private submitKey: HTMLElement | null = null;
  /** トグル入力の状態。直前に押したキーと、その巡回位置。 */
  private toggle: { keyId: number; index: number; at: number } | null = null;

  constructor(options: KanaKeyboardOptions = {}) {
    this.options = options;
  }

  get value(): string {
    return this.text;
  }

  clear(): void {
    this.toggle = null;
    this.text = "";
    this.changed();
  }

  /** 再描画をまたいで入力途中の文字列を復元する。 */
  setValue(value: string): void {
    this.toggle = null;
    this.text = value;
    this.changed();
  }

  /** キーボードを描画して container に差し込む。 */
  mount(container: HTMLElement): void {
    const root = document.createElement("div");
    root.className = "kana-keyboard";
    root.innerHTML = `<div class="kk-grid">${LAYOUT.map(renderKey).join("")}</div>`;
    container.appendChild(root);
    this.root = root;
    this.submitKey = root.querySelector<HTMLElement>(".kk-submit");
    // 初期状態（空）では「わからん」で出す
    this.updateSubmitKey();

    LAYOUT.forEach((def, i) => {
      const key = root.querySelector<HTMLElement>(`[data-i="${i}"]`);
      if (!key) return;
      if (def.kind === "flick") {
        this.bindFlick(key, def.flick, i);
      } else if (def.kind === "char") {
        key.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          this.toggle = null;
          this.append(def.char);
        });
      } else {
        key.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          this.handleFunction(def.fn);
        });
      }
    });
  }

  private bindFlick(key: HTMLElement, flick: FlickSet, keyId: number): void {
    const preview = key.querySelector<HTMLElement>(".kk-preview")!;
    const slots = [...preview.querySelectorAll<HTMLElement>(".kk-p")];
    // 押している間、どの方向にどの文字があるかを十字で見せる
    slots.forEach((slot, i) => {
      slot.textContent = flick[i];
      slot.classList.toggle("kk-empty", !flick[i]);
    });
    const highlight = (dir: number) => {
      slots.forEach((slot, i) => slot.classList.toggle("kk-sel", i === dir));
    };

    let startX = 0;
    let startY = 0;
    let active = false;

    const directionOf = (dx: number, dy: number): number => {
      if (Math.hypot(dx, dy) < FLICK_THRESHOLD) return 0;
      // 横方向の移動が大きければ左右、そうでなければ上下
      if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 1 : 3;
      return dy < 0 ? 2 : 4;
    };

    const charAt = (index: number): string => flick[index] || flick[0];

    key.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      active = true;
      startX = e.clientX;
      startY = e.clientY;
      key.setPointerCapture(e.pointerId);
      key.classList.add("kk-active");
      highlight(0);
      preview.hidden = false;
    });

    key.addEventListener("pointermove", (e) => {
      if (!active) return;
      highlight(directionOf(e.clientX - startX, e.clientY - startY));
    });

    const finish = (e: PointerEvent) => {
      if (!active) return;
      active = false;
      key.classList.remove("kk-active");
      preview.hidden = true;
      const dir = directionOf(e.clientX - startX, e.clientY - startY);
      // 動かさずに離したらトグル入力。はじいたらフリック入力。
      if (dir === 0) {
        this.tapToggle(keyId, flick);
      } else {
        this.toggle = null;
        this.append(charAt(dir));
      }
    };

    key.addEventListener("pointerup", finish);
    key.addEventListener("pointercancel", () => {
      active = false;
      key.classList.remove("kk-active");
      preview.hidden = true;
    });
  }

  /**
   * トグル入力。同じキーを続けて押すと、直前の文字が あ→い→う→え→お と巡回する。
   *
   * 間が空いたときと、別のキーを押したあとは新しい文字として足す。
   * 直前の文字が自分の出したものでなくなっていた場合（けす・小゛゜のあとなど）も
   * 巡回はせず、素直に先頭の文字を足す。
   */
  private tapToggle(keyId: number, flick: FlickSet): void {
    if (this.options.toggleInput === false) {
      this.append(flick[0]);
      return;
    }
    const ring = flick.filter(Boolean); // 文字の無い方向は飛ばす
    const now = Date.now();
    const t = this.toggle;
    const chars = [...this.text];
    const last = chars[chars.length - 1];

    if (t && t.keyId === keyId && now - t.at < TOGGLE_WINDOW_MS && last === ring[t.index]) {
      const index = (t.index + 1) % ring.length;
      chars[chars.length - 1] = ring[index];
      this.text = chars.join("");
      this.toggle = { keyId, index, at: now };
      this.changed();
      return;
    }

    this.toggle = this.append(ring[0]) ? { keyId, index: 0, at: now } : null;
  }

  private handleFunction(fn: "back" | "cycle" | "submit"): void {
    this.toggle = null;
    switch (fn) {
      case "back":
        this.text = [...this.text].slice(0, -1).join("");
        this.changed();
        break;
      case "cycle": {
        const chars = [...this.text];
        const last = chars[chars.length - 1];
        const next = last ? CYCLE[last] : undefined;
        if (next) {
          chars[chars.length - 1] = next;
          this.text = chars.join("");
          this.changed();
        }
        break;
      }
      case "submit":
        this.options.onSubmit?.(this.text);
        break;
    }
  }

  /** 入力が変わったときの共通処理。 */
  private changed(): void {
    this.updateSubmitKey();
    this.options.onChange?.(this.text);
  }

  /**
   * 送信キーの表示を切り替える。
   * 空のときは押すと不正解になるので、ラベルも色も変えて別物に見せる。
   */
  private updateSubmitKey(): void {
    const key = this.submitKey;
    if (!key) return;
    const empty = this.text.length === 0;
    key.textContent = empty ? GIVE_UP_LABEL : SUBMIT_LABEL;
    key.classList.toggle("kk-giveup", empty);
  }

  /** 1文字足す。足せたかどうかを返す。 */
  private append(char: string): boolean {
    if (!char) return false;
    if ([...this.text].length >= MAX_LENGTH) return false;
    this.text += char;
    this.changed();
    return true;
  }

  destroy(): void {
    this.root?.remove();
    this.root = null;
    this.submitKey = null;
  }
}

function renderKey(def: KeyDef, i: number): string {
  if (def.kind === "flick") {
    return `
      <button type="button" class="kk-key" data-i="${i}">
        <span class="kk-label">${def.label}</span>
        <span class="kk-preview" hidden>
          ${["c", "l", "u", "r", "d"]
            .map((d) => `<span class="kk-p kk-p-${d}"></span>`)
            .join("")}
        </span>
      </button>`;
  }
  if (def.kind === "char") {
    return `<button type="button" class="kk-key" data-i="${i}">${def.label}</button>`;
  }
  const classes = ["kk-key", "kk-fn"];
  if (def.fn === "submit") classes.push("kk-submit");
  if (def.fn === "back") classes.push("kk-back");
  if (def.tall) classes.push("kk-tall");
  return `<button type="button" class="${classes.join(" ")}" data-i="${i}">${def.label}</button>`;
}
