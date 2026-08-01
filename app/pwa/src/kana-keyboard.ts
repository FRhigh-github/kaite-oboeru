// ひらがな専用のフリック入力キーボード。
//
// OS の IME を一切通さないので、漢字やカタカナへの変換が構造的に起こらない。
// `<input>` を使うと IME が介在してしまうため、表示は div で行い
// 文字列はこのクラスが完全に保持する。

/** [中央, 左, 上, 右, 下] の順。空文字はその方向に文字が無いことを表す。 */
type FlickSet = [string, string, string, string, string];

type KeyDef =
  /** フリックで5方向に文字を持つキー */
  | { kind: "flick"; label: string; flick: FlickSet }
  /** 1文字だけの単純なキー */
  | { kind: "char"; label: string; char: string }
  /** 機能キー */
  | { kind: "fn"; label: string; fn: "back" | "cycle" | "submit"; tall?: boolean };

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
  { kind: "fn", label: "⌫", fn: "back" },

  { kind: "flick", label: "た", flick: ["た", "ち", "つ", "て", "と"] },
  { kind: "flick", label: "な", flick: ["な", "に", "ぬ", "ね", "の"] },
  { kind: "flick", label: "は", flick: ["は", "ひ", "ふ", "へ", "ほ"] },
  { kind: "fn", label: "こたえる", fn: "submit", tall: true },

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
  つ: "づ", づ: "っ", っ: "つ",
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

export interface KanaKeyboardOptions {
  onChange?(value: string): void;
  onSubmit?(value: string): void;
}

export class KanaKeyboard {
  private text = "";
  private readonly options: KanaKeyboardOptions;
  private root: HTMLElement | null = null;

  constructor(options: KanaKeyboardOptions = {}) {
    this.options = options;
  }

  get value(): string {
    return this.text;
  }

  clear(): void {
    this.text = "";
    this.options.onChange?.(this.text);
  }

  /** 再描画をまたいで入力途中の文字列を復元する。 */
  setValue(value: string): void {
    this.text = value;
    this.options.onChange?.(this.text);
  }

  /** キーボードを描画して container に差し込む。 */
  mount(container: HTMLElement): void {
    const root = document.createElement("div");
    root.className = "kana-keyboard";
    root.innerHTML = `<div class="kk-grid">${LAYOUT.map(renderKey).join("")}</div>`;
    container.appendChild(root);
    this.root = root;

    LAYOUT.forEach((def, i) => {
      const key = root.querySelector<HTMLElement>(`[data-i="${i}"]`);
      if (!key) return;
      if (def.kind === "flick") {
        this.bindFlick(key, def.flick);
      } else if (def.kind === "char") {
        key.addEventListener("pointerdown", (e) => {
          e.preventDefault();
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

  private bindFlick(key: HTMLElement, flick: FlickSet): void {
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
      this.append(charAt(directionOf(e.clientX - startX, e.clientY - startY)));
    };

    key.addEventListener("pointerup", finish);
    key.addEventListener("pointercancel", () => {
      active = false;
      key.classList.remove("kk-active");
      preview.hidden = true;
    });
  }

  private handleFunction(fn: "back" | "cycle" | "submit"): void {
    switch (fn) {
      case "back":
        this.text = [...this.text].slice(0, -1).join("");
        this.options.onChange?.(this.text);
        break;
      case "cycle": {
        const chars = [...this.text];
        const last = chars[chars.length - 1];
        const next = last ? CYCLE[last] : undefined;
        if (next) {
          chars[chars.length - 1] = next;
          this.text = chars.join("");
          this.options.onChange?.(this.text);
        }
        break;
      }
      case "submit":
        this.options.onSubmit?.(this.text);
        break;
    }
  }

  private append(char: string): void {
    if (!char) return;
    if ([...this.text].length >= MAX_LENGTH) return;
    this.text += char;
    this.options.onChange?.(this.text);
  }

  destroy(): void {
    this.root?.remove();
    this.root = null;
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
  if (def.tall) classes.push("kk-tall");
  return `<button type="button" class="${classes.join(" ")}" data-i="${i}">${def.label}</button>`;
}
