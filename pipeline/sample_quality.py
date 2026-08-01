"""生成された訳語を目視確認するためのサンプリング.

ルールベースで訳語を選んでいる以上、機械的には測れない誤りが残る。
定期的にこれで抜き取り、おかしいものを data/manual_overrides.json に書く。

実行:
  py sample_quality.py            # ランダム40語
  py sample_quality.py --n 100    # 件数を指定
  py sample_quality.py --tier part3
  py sample_quality.py --word ignore predict
"""

from __future__ import annotations

import argparse
import json
import random
import sys

from config import BUILD, OUT


def main() -> int:
    ap = argparse.ArgumentParser(description="訳語の品質を抜き取り確認する")
    ap.add_argument("--n", type=int, default=40, help="表示する語数")
    ap.add_argument("--tier", help="part1 / part2 / part3 に絞る")
    ap.add_argument("--word", nargs="*", help="特定の語だけ見る")
    ap.add_argument("--seed", type=int, default=0, help="抽出の再現用")
    ap.add_argument("--suspicious", action="store_true",
                    help="怪しいものだけ表示する")
    a = ap.parse_args()

    vocab_path = OUT / "vocabulary.json"
    if not vocab_path.exists():
        print(f"[!] {vocab_path} がありません。先に step5 を実行してください。")
        return 1
    words = json.loads(vocab_path.read_text(encoding="utf-8"))["words"]

    glosses = {}
    gpath = BUILD / "glosses.json"
    if gpath.exists():
        glosses = json.loads(gpath.read_text(encoding="utf-8"))

    if a.word:
        picked = [w for w in words if w["word"] in set(a.word)]
    else:
        pool = [w for w in words if not a.tier or w["tier"] == a.tier]
        if a.suspicious:
            pool = [w for w in pool if is_suspicious(w, glosses)]
        rng = random.Random(a.seed)
        picked = rng.sample(pool, min(a.n, len(pool)))
        picked.sort(key=lambda w: w["id"])

    if not picked:
        print("該当する語がありません。")
        return 0

    print(f"{len(picked)} 語を表示します"
          + ("（怪しいもののみ）" if a.suspicious else "") + "\n")
    for w in picked:
        flags = suspicion_flags(w, glosses)
        mark = "  ⚠ " + " / ".join(flags) if flags else ""
        print(f"{w['word']:<16} {w['meaning']:<10} {w['reading']:<14}"
              f"[{w['tier']}]{mark}")
        others = [x for x in w["answers"] if x != w["reading"]]
        if others:
            print(f"{'':<16} 許容: {'、'.join(others)}")
        via = glosses.get(w["word"], {}).get("via_stem")
        if via:
            print(f"{'':<16} ※ 語幹 '{via}' から引いた")
        print()

    print("おかしい訳語は data/manual_overrides.json に書けば上書きできます。")
    return 0


def suspicion_flags(word: dict, glosses: dict) -> list[str]:
    flags = []
    if len(word["answers"]) <= 1:
        flags.append("許容解が1つだけ")
    if glosses.get(word["word"], {}).get("via_stem"):
        flags.append("語幹から推定")
    # 読みが英単語の音写に見える（意味を知らなくても答えられる）
    if all(0x30FC == ord(c) or 0x3041 <= ord(c) <= 0x3096 for c in word["reading"]):
        if word["meaning"] == word["reading"]:
            flags.append("かな表記のみ")
    return flags


def is_suspicious(word: dict, glosses: dict) -> bool:
    return bool(suspicion_flags(word, glosses))


if __name__ == "__main__":
    sys.exit(main())
