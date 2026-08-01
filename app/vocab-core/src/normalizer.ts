// ひらがな解答の正規化と判定。
//
// **これは pipeline/normalizer.py の移植です。挙動を一致させること。**
// out/normalization_testcases.json で照合できます（npm run verify）。
// 両者がずれると「合っているのにバツ」が発生し、離脱に直結します。
//
// 文字数は一貫して Unicode コードポイント単位で数えます。
// Python の len() がコードポイント単位であるためで、JavaScript の
// String.length（UTF-16 単位）を使うと絵文字などで結果がずれます。
// コードポイント配列は Array.from(str) で得られます。

/**
 * 解答の判定結果。
 *
 * `unsure` はユーザーに自己申告させるための状態。
 * ローカル判定だけで白黒つけようとすると「合っているのにバツ」が必ず起きるため、
 * 判定の最終権限をユーザーに渡す逃げ道を用意している。
 * ここで集まる「wrong と判定したがユーザーは正解と申告した」ペアが、
 * 訳語データを改善するための評価データになる。
 */
export type Judgement = "correct" | "unsure" | "wrong";

// --- 文字集合（Python 側の正規表現と対応）---

/** _NOISE に対応。除去する記号・空白。 */
const NOISE = new Set([
  " ", "\t", "\n", "\r", "\u000B", "\u000C", "　",
  "~", "〜", "-", "ー", "―", "–", "—", "…",
  ".", "。", "!", "！", "?", "？",
  '"', "'", "「", "」", "『", "』",
]);

/** _SPLIT に対応。複数解答の区切り。 */
const SPLITTERS = new Set(["、", ",", "／", "/", ";", "；", "・", "･", "\n"]);

/** _PAREN に対応。括弧内の注記を落とす。 */
const OPENERS = new Set(["（", "(", "[", "［", "【"]);
const CLOSERS = new Set(["）", ")", "]", "］", "】"]);

/**
 * _LEADING_PARTICLES に対応。
 * 末尾側は除去しない。「けんとうすること」の「と」を助詞と誤認して
 * 語尾「すること」の除去を妨げてしまうため。
 */
const LEADING_PARTICLES = new Set(["を", "が", "は", "に", "へ", "で", "と", "も", "の"]);

/** _SUFFIXES に対応。**順序を Python と一致させること**（上から順に試す）。 */
const SUFFIXES: readonly string[][] = [
  "ということ", "という意味", "ということば", "のこと",
  "すること", "であること", "させる", "される",
  "する", "した", "して", "しま",
  "こと", "もの",
  "な", "の", "に", "と", "だ", "です",
].map((s) => Array.from(s));

// --- 正規化 ---

/** 1つの解答文字列を比較可能な正規形にする。 */
export function normalize(text: string): string {
  // NFKC: 全角/半角・異体字をそろえる
  let chars = Array.from(text.normalize("NFKC"));

  chars = removeParenthesised(chars);
  chars = chars.filter((c) => !NOISE.has(c));
  chars = Array.from(chars.join("").toLowerCase());
  chars = chars.map(katakanaToHiragana);
  chars = stripLeadingParticles(chars);
  chars = stripSuffix(chars);

  return chars.join("");
}

/** 1つの解答が含む全ての比較キー（複数解答の分割を含む）。 */
export function variants(text: string): Set<string> {
  const keys = new Set<string>();

  const parts: string[][] = [];
  let current: string[] = [];
  for (const c of Array.from(text)) {
    if (SPLITTERS.has(c)) {
      parts.push(current);
      current = [];
    } else {
      current.push(c);
    }
  }
  parts.push(current);

  for (const part of parts) {
    const key = normalize(part.join(""));
    if (key) keys.add(key);
  }
  // 分割せずに全体を1つとして見た場合も許容する
  const whole = normalize(text);
  if (whole) keys.add(whole);

  return keys;
}

// --- 判定 ---

/**
 * 3値判定。answers は許容される読み（ひらがな）のリスト。
 *
 * near は「意味は近いが代表訳ではない」読み（準正解）。
 * JMdict の下位候補で、その語の訳として挙がってはいるが ○ にするには
 * 確度が足りないもの。当たれば `unsure` を返す。
 * 字面がまったく違う同義語（規則／ルール）はここでしか拾えない。
 */
export function judge(
  userInput: string,
  answers: readonly string[],
  near: readonly string[] = [],
): Judgement {
  const userKeys = variants(userInput);
  if (userKeys.size === 0) return "wrong";

  const answerKeys = new Set<string>();
  for (const answer of answers) {
    for (const key of variants(answer)) answerKeys.add(key);
  }
  if (answerKeys.size === 0) return "wrong";

  // 段2・段3: 正規化後の完全一致
  for (const key of userKeys) {
    if (answerKeys.has(key)) return "correct";
  }

  // 段4: 編集距離によるタイプミス許容
  for (const user of userKeys) {
    const userChars = Array.from(user);
    for (const answer of answerKeys) {
      const answerChars = Array.from(answer);
      if (editDistance(userChars, answerChars) <= distanceThreshold(answerChars.length)) {
        return "correct";
      }
    }
  }

  // 部分一致は「惜しい」扱いにしてユーザーに委ねる。
  // 漢字は1文字でも意味を持つので許容するが、かな1文字（「る」など）は
  // 何にでも部分一致してしまうので除外する。
  for (const user of userKeys) {
    const chars = Array.from(user);
    const singleKanji = chars.length === 1 && isKanji(chars[0]);
    if (chars.length < 2 && !singleKanji) continue;
    for (const answer of answerKeys) {
      if (answer.includes(user) || user.includes(answer)) return "unsure";
    }
  }

  // 段5: 準正解。answers と字面が違っても、その語の訳語候補ではあるもの。
  // ここは correct にせず必ず unsure に留める（下位候補なので確度が足りない）。
  const nearKeys = new Set<string>();
  for (const n of near) {
    for (const key of variants(n)) nearKeys.add(key);
  }
  for (const key of answerKeys) nearKeys.delete(key);
  if (nearKeys.size > 0) {
    for (const user of userKeys) {
      if (nearKeys.has(user)) return "unsure";
    }
    for (const user of userKeys) {
      const userChars = Array.from(user);
      for (const n of nearKeys) {
        const nearChars = Array.from(n);
        if (editDistance(userChars, nearChars) <= distanceThreshold(nearChars.length)) {
          return "unsure";
        }
      }
    }
  }

  return "wrong";
}

// --- 部品 ---

function removeParenthesised(chars: readonly string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < chars.length) {
    if (!OPENERS.has(chars[i])) {
      out.push(chars[i]);
      i++;
      continue;
    }
    // 対応する閉じ括弧を探す。無ければ括弧文字をそのまま残す
    // （Python 側の正規表現もマッチしないため）。
    let scan = i + 1;
    while (scan < chars.length && !CLOSERS.has(chars[scan])) scan++;
    if (scan < chars.length) {
      i = scan + 1;
    } else {
      out.push(chars[i]);
      i++;
    }
  }
  return out;
}

function katakanaToHiragana(char: string): string {
  // ァ(U+30A1)〜ヶ(U+30F6) のみ。長音符やヽヾは対象外。
  const code = char.codePointAt(0)!;
  if (code >= 0x30a1 && code <= 0x30f6) return String.fromCodePoint(code - 0x60);
  return char;
}

function stripLeadingParticles(chars: readonly string[]): string[] {
  let result = [...chars];
  while (result.length > 2 && LEADING_PARTICLES.has(result[0])) {
    result = result.slice(1);
  }
  return result;
}

/** 語尾の揺れを吸収する。1回だけ落とす（過剰除去を避ける）。 */
function stripSuffix(chars: readonly string[]): string[] {
  for (const suffix of SUFFIXES) {
    if (chars.length < suffix.length) continue;
    const tail = chars.slice(chars.length - suffix.length);
    if (!tail.every((c, i) => c === suffix[i])) continue;
    // 1文字の語尾は「おんな」「さかな」のような3文字語を壊してしまうので、
    // 4文字以上のときだけ落とす。
    const minLength = suffix.length === 1 ? 4 : suffix.length + 2;
    if (chars.length >= minLength) {
      return chars.slice(0, chars.length - suffix.length);
    }
  }
  return [...chars];
}

function isKanji(char: string): boolean {
  // Python 側の "一" <= ch <= "鿿" と同じ範囲
  const code = char.codePointAt(0)!;
  return code >= 0x4e00 && code <= 0x9fff;
}

/** 文字列長に応じたタイプミス許容量。 */
export function distanceThreshold(length: number): number {
  if (length <= 3) return 0;
  if (length <= 6) return 1;
  return 2;
}

/** レーベンシュタイン距離。 */
export function editDistance(a: readonly string[], b: readonly string[]): number {
  if (a.length === b.length && a.every((c, i) => c === b[i])) return 0;
  const [long, short] = a.length >= b.length ? [a, b] : [b, a];
  if (short.length === 0) return long.length;

  let previous = Array.from({ length: short.length + 1 }, (_, i) => i);
  let current = new Array<number>(short.length + 1).fill(0);

  for (let i = 0; i < long.length; i++) {
    current[0] = i + 1;
    for (let j = 0; j < short.length; j++) {
      current[j + 1] = Math.min(
        previous[j + 1] + 1,
        current[j] + 1,
        previous[j] + (long[i] === short[j] ? 0 : 1),
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[short.length];
}
