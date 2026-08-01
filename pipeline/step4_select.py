"""step4: JMdict のタグを使って訳語を機械的に選別する（LLM 不使用・コスト0）.

JMdict は語義ごとに misc / field タグを持つので、
古語・俗語・専門用語・固有名詞をタグで落とせる。
（例: dear の候補にある「州」は arch = 古語 タグ付きなので落ちる）

入力: build/wordlist.json, build/glosses.json
出力: build/refined.json
"""

from __future__ import annotations

import json
import sys
from collections import Counter

from config import (
    BUILD,
    DEMOTE_MISC,
    DROP_ANY_FIELD,
    DROP_MISC,
    MAX_ACCEPTED,
    MAX_READING_LEN,
    MIN_READING_LEN,
    OVERRIDES_PATH,
    TODO_PATH,
)
from normalizer import normalize
from step3_extract_glosses import candidate_score

# JMdict の品詞タグ → アプリで使う品詞。上から順に判定する。
POS_MAP = [
    (("adj-i", "adj-na", "adj-no", "adj-t", "adj-f", "adj-pn", "adj-ku",
      "adj-shiku", "adj-nari"), "adjective"),
    (("adv", "adv-to"), "adverb"),
    (("conj",), "conjunction"),
    (("prt",), "particle"),
    (("int",), "interjection"),
    (("pref", "suf"), "affix"),
    (("exp",), "expression"),
]


def classify_pos(pos_tags: list[str]) -> str:
    for tags, label in POS_MAP:
        if any(t in tags for t in pos_tags):
            return label
    # 動詞は v1 / v5r / vs / vk ... と多様なので接頭辞で判定
    if any(t.startswith("v") for t in pos_tags):
        return "verb"
    return "noun"


def keep(c: dict, *, allow_field: bool, allow_demoted: bool,
         allow_exp: bool) -> bool:
    misc = set(c["misc"])
    if misc & DROP_MISC:
        return False
    if not allow_demoted and misc & DEMOTE_MISC:
        return False
    if DROP_ANY_FIELD and not allow_field and c["field"]:
        return False
    # 長すぎる読みは単語ではなく句（「歴史の一ページ」など）
    if not MIN_READING_LEN <= len(c["reading"]) <= MAX_READING_LEN:
        return False
    # 慣用表現は単語の訳としては避けたいが、
    # sick →「具合が悪い」のようにこれしか無い語もあるので緩和段階で拾う。
    if not allow_exp and "exp" in c["pos"]:
        return False
    return True


def rank_key(c: dict, word: str):
    # step3 と同じスコアで並べる。
    # sense_index（何番目の語義か）が最も効き、周辺的な語義を代表訳にしない。
    return (candidate_score(c, word), not c["exact"], len(c["reading"]))


# (専門分野を許すか, 口語を許すか, 慣用表現を許すか) を段階的に緩める
RELAXATION = [
    (False, False, False),
    (False, True, False),
    (False, True, True),
    (True, True, True),
]


def select(cands: list[dict], word: str) -> list[dict] | None:
    """段階的に条件を緩めながら候補を絞る."""
    for allow_field, allow_demoted, allow_exp in RELAXATION:
        kept = [c for c in cands
                if keep(c, allow_field=allow_field,
                        allow_demoted=allow_demoted, allow_exp=allow_exp)]
        if kept:
            return sorted(kept, key=lambda c: rank_key(c, word))
    return None


def main() -> int:
    print("step4: JMdict のタグで訳語を選別します（LLM 不使用）\n")

    wordlist = json.loads((BUILD / "wordlist.json").read_text(encoding="utf-8"))
    glosses = json.loads((BUILD / "glosses.json").read_text(encoding="utf-8"))

    refined: dict[str, dict] = {}
    dropped_all, no_candidates = [], []
    relaxed = 0

    # 難易度は頻度順の五分位で近似する（LLM を使わないため）。
    # FSRS の初期難易度として使う分には相対順序が保たれていれば十分。
    n = len(wordlist)
    difficulty_of = {e["word"]: min(5, 1 + (i * 5) // n)
                     for i, e in enumerate(wordlist)}

    for entry in wordlist:
        word = entry["word"]
        cands = glosses.get(word, {}).get("candidates", [])
        if not cands:
            no_candidates.append(word)
            continue

        picked = select(cands, word)
        if not picked:
            dropped_all.append(word)
            continue
        if any(c["field"] for c in picked[:1]):
            relaxed += 1

        best = picked[0]

        # 判定用の読み。正規化後の重複を除く。
        answers, seen = [], set()
        for c in picked:
            key = normalize(c["reading"])
            if not key or key in seen:
                continue
            seen.add(key)
            answers.append(c["reading"])
            if len(answers) >= MAX_ACCEPTED:
                break

        refined[word] = {
            "meaning": best["display"],      # 表示用（漢字 or かな）
            "reading": best["reading"],      # 代表の読み
            "answers": answers,              # 判定用（ひらがな）
            "pos": classify_pos(best["pos"]),
            "difficulty": difficulty_of[word],
        }

    # --- 手動オーバーライドを適用（ルールで拾えない分の逃げ道） ---
    applied = 0
    if OVERRIDES_PATH.exists():
        overrides = json.loads(OVERRIDES_PATH.read_text(encoding="utf-8"))
        for word, ov in overrides.items():
            if not ov.get("answers"):
                continue  # 未記入のテンプレートは無視
            base = refined.get(word, {})
            refined[word] = {
                "meaning": ov.get("meaning") or base.get("meaning") or ov["answers"][0],
                "reading": ov.get("reading") or ov["answers"][0],
                "answers": ov["answers"],
                "pos": ov.get("pos") or base.get("pos", "noun"),
                "difficulty": ov.get("difficulty") or difficulty_of.get(word, 3),
            }
            applied += 1

    out_path = BUILD / "refined.json"
    out_path.write_text(
        json.dumps(refined, ensure_ascii=False, indent=2), encoding="utf-8")

    # --- 要対応リストを書き出す（手で埋めれば次回から反映される） ---
    todo = {
        w: {"meaning": "", "reading": "", "answers": [], "pos": "", "note": note}
        for w, note in
        [(w, "JMdict に候補なし") for w in no_candidates]
        + [(w, "タグで全滅") for w in dropped_all]
        if w not in refined
    }
    TODO_PATH.write_text(
        json.dumps(todo, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"出力: {out_path}  ({len(refined)}/{len(wordlist)} 語)")
    if applied:
        print(f"  手動オーバーライドを適用: {applied} 語")
    if no_candidates:
        print(f"  JMdict に候補なし ({len(no_candidates)}): "
              f"{', '.join(no_candidates[:20])}")
    if dropped_all:
        print(f"  タグで全滅 ({len(dropped_all)}): {', '.join(dropped_all[:20])}")
    if relaxed:
        print(f"  専門分野タグを許容して救済: {relaxed} 語")
    if todo:
        print(f"\n  → {TODO_PATH} に要対応 {len(todo)} 語を書き出しました。")
        print(f"     answers を埋めて {OVERRIDES_PATH.name} にコピーすると反映されます。")

    counts = [len(r["answers"]) for r in refined.values()]
    print(f"\n  許容解の数: 平均 {sum(counts)/len(counts):.1f} / "
          f"最小 {min(counts)} / 最大 {max(counts)}")
    if solo := sum(1 for c in counts if c == 1):
        print(f"  [!] 許容解が1つだけの語が {solo} 語（判定が厳しくなります）")
    print("  品詞分布: " + " ".join(
        f"{p}:{c}" for p, c in Counter(
            r["pos"] for r in refined.values()).most_common()))

    print("\n  選別例:")
    for w in ["dear", "moreover", "objective", "historical"]:
        r = refined.get(w)
        if not r:
            continue
        print(f"    {w:<12} 表示={r['meaning']}  正解={r['reading']}")
        print(f"    {'':<12} 許容={'、'.join(r['answers'])}")

    print("\nstep4 完了。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
