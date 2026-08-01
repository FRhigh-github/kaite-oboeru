"""日本語解答の正規化 — 参照実装.

**解答はひらがなのみで入力される前提**。
単語データ側の answers も JMdict の読み（ひらがな）で持っているため、
漢字・送り仮名の表記ゆれを考えなくてよく、判定が大幅に単純になる。
（カタカナが混ざった場合に備えて ひらがな化 は残してある）

アプリ本体（Swift）はこれと同一の挙動を実装すること。
step5 が生成する out/normalization_testcases.json で両者の一致を検証できる。

判定の段階（設計メモ）:
  段1 完全一致        … ここに来る前に済んでいる
  段2 正規化一致      … このモジュール
  段3 answers と照合  … 正規化してから比較
  段4 編集距離        … normalize 後の文字列に対して適用
"""

from __future__ import annotations

import re
import unicodedata

# 括弧内の注記を落とす:「(人)を助ける」→「を助ける」
_PAREN = re.compile(r"[（(\[［【][^）)\]］】]*[）)\]］】]")

# 複数解答の区切り
_SPLIT = re.compile(r"[、,／/;；・･\n]+")

# 除去する記号・空白（漢字/かな/英数は残す）
_NOISE = re.compile(r"[\s　~〜\-ー―–—…\.。!！?？\"'「」『』]+")

# 語尾（長いものから順に試す）
_SUFFIXES = (
    "ということ", "という意味", "ということば", "のこと",
    "すること", "であること", "させる", "される",
    "する", "した", "して", "しま",
    "こと", "もの",
    "な", "の", "に", "と", "だ", "です",
)

# 先頭の助詞。「(人)を助ける」→「助ける」のような注記の残骸を落とす。
# 末尾側は除去しない:「検討すること」の「と」を助詞と誤認して
# 語尾「すること」の除去を妨げてしまうため。
_LEADING_PARTICLES = ("を", "が", "は", "に", "へ", "で", "と", "も", "の")


def _is_kanji(ch: str) -> bool:
    return "一" <= ch <= "鿿"


def _katakana_to_hiragana(s: str) -> str:
    out = []
    for ch in s:
        code = ord(ch)
        # カタカナ（ァ〜ヶ）をひらがなへ。長音符とヽヾは対象外。
        if 0x30A1 <= code <= 0x30F6:
            out.append(chr(code - 0x60))
        else:
            out.append(ch)
    return "".join(out)


def _strip_suffix(s: str) -> str:
    """語尾の揺れを吸収する。1回だけ落とす（過剰除去を避ける）."""
    for suf in _SUFFIXES:
        if not s.endswith(suf):
            continue
        # 1文字の語尾は「おんな」「さかな」のような3文字語を壊してしまうので、
        # 4文字以上のときだけ落とす。
        min_len = 4 if len(suf) == 1 else len(suf) + 2
        if len(s) >= min_len:
            return s[: -len(suf)]
    return s


def _strip_leading_particles(s: str) -> str:
    while len(s) > 2 and s[0] in _LEADING_PARTICLES:
        s = s[1:]
    return s


def normalize(text: str) -> str:
    """1つの解答文字列を比較可能な正規形にする."""
    s = unicodedata.normalize("NFKC", text)   # 全角/半角・異体字
    s = _PAREN.sub("", s)
    s = _NOISE.sub("", s)
    s = s.lower()                              # 英字が混ざる場合に備える
    s = _katakana_to_hiragana(s)
    s = _strip_leading_particles(s)
    s = _strip_suffix(s)
    return s


def variants(text: str) -> set[str]:
    """1つの解答が含む全ての比較キー（複数解答の分割を含む）."""
    out = set()
    for part in _SPLIT.split(text):
        n = normalize(part)
        if n:
            out.add(n)
    # 分割せずに全体を1つとして見た場合も許容する
    whole = normalize(text)
    if whole:
        out.add(whole)
    return out


def edit_distance(a: str, b: str) -> int:
    """レーベンシュタイン距離."""
    if a == b:
        return 0
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def distance_threshold(s: str) -> int:
    """文字列長に応じたタイプミス許容量."""
    if len(s) <= 3:
        return 0
    if len(s) <= 6:
        return 1
    return 2


def judge(user_input: str, answers: list[str]) -> str:
    """3値判定を返す: 'correct' / 'unsure' / 'wrong'.

    answers は許容される読み（ひらがな）のリスト。先頭が代表の読み。

    'unsure' はアプリ側でユーザーに自己申告させる（「合ってた？」ボタン）。
    ここで集めた自己申告データが、後から AI 判定を導入する際の評価データになる。
    """
    user_keys = variants(user_input)
    if not user_keys:
        return "wrong"

    answer_keys: set[str] = set()
    for ans in answers:
        answer_keys |= variants(ans)
    if not answer_keys:
        return "wrong"

    # 段2・段3: 正規化後の完全一致
    if user_keys & answer_keys:
        return "correct"

    # 段4: 編集距離によるタイプミス許容
    for u in user_keys:
        for a in answer_keys:
            if edit_distance(u, a) <= distance_threshold(a):
                return "correct"

    # 部分一致は「惜しい」扱いにしてユーザーに委ねる。
    # 漢字は1文字でも意味を持つので許容するが、かな1文字（「る」など）は
    # 何にでも部分一致してしまうので除外する。
    for u in user_keys:
        if len(u) < 2 and not (len(u) == 1 and _is_kanji(u)):
            continue
        for a in answer_keys:
            if u in a or a in u:
                return "unsure"

    return "wrong"
