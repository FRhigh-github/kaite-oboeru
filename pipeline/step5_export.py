"""step5: アプリ同梱用の最終データを書き出す.

入力: build/wordlist.json, build/refined.json
出力:
  out/vocabulary.json               アプリに同梱する単語データ
  out/normalization_testcases.json  Swift 実装の検証用テストベクタ
  out/ATTRIBUTION.md                CC BY-SA 4.0 の出典表示（アプリ内に必須）
"""

from __future__ import annotations

import json
import random
import sys
from collections import Counter
from datetime import datetime, timezone

from config import BUILD, OUT, WORDS_PER_GROUP
from normalizer import judge, normalize, variants

ATTRIBUTION = """\
# 出典表示 (Attribution)

このアプリの単語データは、以下のオープンデータを基に作成されています。
いずれも Creative Commons Attribution-ShareAlike 4.0 International
(CC BY-SA 4.0) の下で提供されています。

## New General Service List (NGSL) / New Academic Word List (NAWL)

Browne, C., Culligan, B., & Phillips, J.
<https://www.newgeneralservicelist.com/>
Licensed under CC BY-SA 4.0.

## JMdict / EDICT

Electronic Dictionary Research and Development Group (EDRDG)
<https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project>
Licensed under CC BY-SA 4.0.

日本語訳および読みは JMdict のデータを基に、学習用に選別・編集したものです。

## ライセンス上の注意

- CC BY-SA 4.0 の ShareAlike 条項により、本アプリの**単語データ
  (vocabulary.json)** は同じく CC BY-SA 4.0 で提供されます。
- EDRDG のライセンスは、スマートフォンアプリにおいて起動画面での言及では
  不十分であり、「About」「情報」等のメニューから開ける独立した画面での
  表示を求めています。**この文書の内容を必ずアプリ内に組み込んでください。**
- 辞書データは定期的に最新版へ更新することが求められています。
"""


def main() -> int:
    wl_path, rf_path = BUILD / "wordlist.json", BUILD / "refined.json"
    if not rf_path.exists():
        print(f"[!] {rf_path} がありません。先に step4 を実行してください。")
        return 1

    wordlist = json.loads(wl_path.read_text(encoding="utf-8"))
    refined = json.loads(rf_path.read_text(encoding="utf-8"))

    words, dropped = [], []
    for entry in wordlist:
        w = entry["word"]
        r = refined.get(w)
        if not r or not r.get("answers"):
            dropped.append(w)
            continue
        words.append({
            "word": w,
            "meaning": r["meaning"],    # 表示用（漢字 or かな）
            "reading": r["reading"],    # 代表の読み（ひらがな）
            "answers": r["answers"],    # 判定用の許容読み（ひらがな）
            "pos": r["pos"],
            "difficulty": r["difficulty"],
            "tier": entry["tier"],
        })

    # グループ番号。頻度順に 100 語ずつ区切る（グループ1が最も易しい）。
    for i, x in enumerate(words, 1):
        x["id"] = i
        x["group"] = (i - 1) // WORDS_PER_GROUP + 1

    group_count = (len(words) - 1) // WORDS_PER_GROUP + 1

    payload = {
        "meta": {
            "version": 1,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "word_count": len(words),
            "answer_script": "hiragana",
            "words_per_group": WORDS_PER_GROUP,
            "group_count": group_count,
            "license": "CC BY-SA 4.0",
            "sources": ["NGSL 1.2", "NAWL 1.0", "JMdict (EDRDG)"],
            "attribution_required": True,
        },
        "words": words,
    }

    out_vocab = OUT / "vocabulary.json"
    out_vocab.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    # --- Swift 実装の検証用テストベクタ ---
    # 参照実装(Python)の出力をそのまま記録し、Swift 側が同じ結果を返すことを
    # 確認する差分テスト。「正解はどれか」を人が書く必要がないので、
    # 手書きテストより桁違いに広いカバレッジが得られる。
    # 両者がずれると「合ってるのにバツ」が発生するため必ず通すこと。
    norm_vectors, seen = [], set()
    for x in words:
        for src in x["answers"]:
            if src in seen:
                continue
            seen.add(src)
            norm_vectors.append({
                "input": src,
                "normalized": normalize(src),
                "keys": sorted(variants(src)),
            })

    rng = random.Random(20260801)  # 再現性のため固定
    probes: list[tuple[str, list[str]]] = []

    # 1) 自分の許容解 → correct になるはず
    for x in words:
        for ans in x["answers"][:3]:
            probes.append((ans, x["answers"]))

    # 2) 他の語の読みとの交差 → 多くは wrong、同音語なら correct
    for x in rng.sample(words, min(1000, len(words))):
        other = rng.choice(words)
        probes.append((other["reading"], x["answers"]))

    # 3) 1文字落とし・置換のタイプミス → 編集距離の境界を突く
    for x in rng.sample(words, min(1000, len(words))):
        r = x["reading"]
        if len(r) < 3:
            continue
        i = rng.randrange(len(r))
        probes.append((r[:i] + r[i + 1:], x["answers"]))
        probes.append((r[:i] + "ん" + r[i + 1:], x["answers"]))

    # 4) 前方一致・後方一致 → unsure の境界を突く
    for x in rng.sample(words, min(500, len(words))):
        r = x["reading"]
        if len(r) >= 3:
            probes.append((r[:len(r) // 2], x["answers"]))

    # 5) 空・記号のみなどの異常系
    for weird in ["", " ", "　", "、", "()", "ー", "・・・"]:
        probes.append((weird, words[0]["answers"]))

    judge_vectors = [
        {"input": inp, "answers": ans, "expected": judge(inp, ans)}
        for inp, ans in probes
    ]

    out_vectors = OUT / "normalization_testcases.json"
    out_vectors.write_text(
        json.dumps({"normalize": norm_vectors, "judge": judge_vectors},
                   ensure_ascii=False, indent=2),
        encoding="utf-8")

    (OUT / "ATTRIBUTION.md").write_text(ATTRIBUTION, encoding="utf-8")

    # --- レポート ---
    print(f"出力: {out_vocab}  ({len(words)} 語)")
    print(f"      {out_vectors}  "
          f"(normalize {len(norm_vectors)} / judge {len(judge_vectors)} ケース)")
    print(f"      {OUT / 'ATTRIBUTION.md'}")
    print("  judge の内訳: " + " ".join(
        f"{k}:{v}" for k, v in Counter(
            v["expected"] for v in judge_vectors).most_common()))
    if dropped:
        print(f"\n[!] 訳語が無く除外した語 ({len(dropped)}): "
              f"{', '.join(dropped[:20])}")
        print("    data/needs_review.json を埋めて manual_overrides.json に"
              "置くと復活します。")

    counts = [len(x["answers"]) for x in words]
    print(f"\n  許容解の数: 平均 {sum(counts)/len(counts):.1f} / "
          f"最小 {min(counts)} / 最大 {max(counts)}")
    print("  ティア分布: " + " ".join(
        f"{t}:{c}" for t, c in sorted(Counter(x["tier"] for x in words).items())))
    print("  品詞分布  : " + " ".join(
        f"{p}:{c}" for p, c in Counter(
            x["pos"] for x in words).most_common()))

    # --- 判定の健全性チェック ---
    # 別の単語の正解が、この単語の正解としても通ってしまうと出題として破綻する。
    key_owner: dict[str, str] = {}
    collisions = 0
    for x in words:
        for k in variants(x["reading"]):
            if k in key_owner and key_owner[k] != x["word"]:
                collisions += 1
                break
            key_owner[k] = x["word"]
    print(f"\n  代表読みの衝突: {collisions} 語 "
          f"({collisions/len(words):.1%}) — 同音異義語なので許容範囲")

    print("\nstep5 完了。out/ATTRIBUTION.md の内容をアプリ内に必ず組み込んでください。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
