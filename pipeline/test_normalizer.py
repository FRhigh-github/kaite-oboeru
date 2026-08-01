"""normalizer の挙動確認.

解答はひらがなのみで入力される前提。
判定エンジンはアプリの体験を直接左右するので、
「こう入力されたらこう判定してほしい」をここに書き足しながら育てる。

実行:  py test_normalizer.py
"""

from __future__ import annotations

import sys

from normalizer import judge, normalize

# (ユーザー入力, 許容される読みのリスト, 期待する判定)
CASES: list[tuple[str, list[str], str]] = [
    # --- 完全一致 ---
    ("かんがえる", ["かんがえる", "おもう"], "correct"),

    # --- 「〜する」の有無 ---
    ("けんとうする", ["けんとう"], "correct"),
    ("けんとう", ["けんとうする"], "correct"),
    ("じゅっこう", ["じゅっこうする"], "correct"),

    # --- 形容詞・連体修飾の語尾 ---
    ("じゅうような", ["じゅうよう"], "correct"),
    ("じゅうよう", ["じゅうような"], "correct"),
    ("きゃっかんてき", ["きゃっかんてき", "もくてき"], "correct"),

    # --- 別解（answers の2番目以降）---
    ("もくてき", ["きゃっかんてき", "もくてき", "ねらい"], "correct"),
    ("ねらい", ["きゃっかんてき", "もくてき", "ねらい"], "correct"),

    # --- カタカナが混ざった場合も救う ---
    ("リンゴ", ["りんご"], "correct"),
    ("ゴール", ["ごーる"], "correct"),

    # --- 全角・空白・記号 ---
    (" かんがえる ", ["かんがえる"], "correct"),
    ("かんがえる。", ["かんがえる"], "correct"),

    # --- 助詞の残骸 ---
    ("をたすける", ["たすける"], "correct"),

    # --- 複数入力 ---
    ("かんがえる、けんとうする", ["かんがえる"], "correct"),
    ("たすける/すくう", ["すくう"], "correct"),

    # --- タイプミス許容（編集距離）---
    ("じゅつこうする", ["じゅっこうする"], "correct"),
    ("きゃっかんてけ", ["きゃっかんてき"], "correct"),

    # --- 短い語は誤爆を避けるため厳しく ---
    ("うみ", ["やま"], "wrong"),

    # --- 3文字語が語尾除去で壊れないこと ---
    ("さかな", ["さかな"], "correct"),
    ("おんな", ["おんな"], "correct"),
    ("さかな", ["さか"], "unsure"),

    # --- 惜しい（ユーザーに自己申告させる）---
    ("かんが", ["かんがえる"], "unsure"),
    ("れきし", ["れきしてき"], "unsure"),

    # --- 明確な誤り ---
    ("はしる", ["かんがえる", "おもう"], "wrong"),
    ("りんご", ["つくえ"], "wrong"),
    ("", ["かんがえる"], "wrong"),
    ("かんがえる", [], "wrong"),
]


def main() -> int:
    print("normalize() の例:")
    for s in ["けんとうする", "じゅうような", "ゴール", "をたすける",
              "さかな", "けんとうすること"]:
        print(f"    {s!r:<20} → {normalize(s)!r}")

    print("\njudge() のテスト:")
    failures = 0
    for user, answers, expected in CASES:
        got = judge(user, answers)
        ok = got == expected
        if not ok:
            failures += 1
        mark = "ok  " if ok else "FAIL"
        shown = "、".join(answers) or "(なし)"
        print(f"  [{mark}] {user!r:<20} vs {shown:<22} "
              f"期待={expected:<8} 実際={got}")

    total = len(CASES)
    print(f"\n{total - failures}/{total} 通過")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
