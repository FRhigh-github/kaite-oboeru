// 英単語の読み上げ。
//
// Web Speech API を使う。iOS は端末内蔵の音声を使うのでオフラインでも動き、
// 音声ファイルを同梱する必要がない。
//
// iOS の制約: 最初の1回はユーザー操作（タップ）を伴わないと発話されない。
// 学習画面はボタンを押しながら進むので2問目以降は問題なく鳴るが、
// 起動直後の自動読み上げは無音になることがある。

let cachedVoice: SpeechSynthesisVoice | null = null;
let voicesReady = false;

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

function pickVoice(): SpeechSynthesisVoice | null {
  const voices = speechSynthesis.getVoices();
  if (voices.length === 0) return null;
  return (
    voices.find((v) => v.lang === "en-US" && v.localService) ??
    voices.find((v) => v.lang === "en-US") ??
    voices.find((v) => v.lang.replace("_", "-").startsWith("en")) ??
    null
  );
}

/** 音声一覧は非同期に揃うので、準備できたら拾い直す。 */
export function initSpeech(): void {
  if (!speechSupported() || voicesReady) return;
  cachedVoice = pickVoice();
  if (cachedVoice) voicesReady = true;
  speechSynthesis.addEventListener("voiceschanged", () => {
    cachedVoice = pickVoice();
    voicesReady = cachedVoice !== null;
  });
}

/** 英単語を読み上げる。失敗しても学習は続けられるので例外は投げない。 */
export function speak(text: string): void {
  if (!speechSupported() || !text) return;
  try {
    // 前の読み上げが残っていると重なるので止める
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    cachedVoice ??= pickVoice();
    if (cachedVoice) utterance.voice = cachedVoice;
    utterance.rate = 0.9;
    speechSynthesis.speak(utterance);
  } catch {
    // 端末が対応していない場合は黙って何もしない
  }
}
