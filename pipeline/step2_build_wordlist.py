"""step2: NGSL + NAWL から 1900 語の単語リストを構築する.

出力: build/wordlist.json
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys

from config import (
    BASIC_CUTOFF_RANK,
    BUILD,
    NAWL_DIFFICULTY_OFFSET,
    SOURCE_FILES,
    STOPWORDS,
    TARGET_WORD_COUNT,
    TIERS,
)

WORD_RE = re.compile(r"^[a-z]+$")


def _read_csv(path):
    with path.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def load_ngsl() -> list[dict]:
    """NGSL: Lemma, SFI Rank, SFI, Adjusted Frequency per Million (U)"""
    out = []
    for row in _read_csv(SOURCE_FILES["ngsl"]):
        word = (row.get("Lemma") or "").strip().lower()
        rank = row.get("SFI Rank")
        if not word or not rank:
            continue
        out.append({"word": word, "source": "ngsl", "rank": int(rank),
                    "sfi": float(row["SFI"])})
    out.sort(key=lambda r: r["rank"])
    return out


def load_nawl() -> list[dict]:
    """NAWL: Word, Order, Rank, Band, SFI, U"""
    out = []
    for row in _read_csv(SOURCE_FILES["nawl"]):
        word = (row.get("Word") or "").strip().lower()
        rank = row.get("Rank")
        if not word or not rank:
            continue
        out.append({"word": word, "source": "nawl", "rank": int(rank),
                    "sfi": float(row["SFI"])})
    out.sort(key=lambda r: r["rank"])
    return out


def is_usable(word: str) -> bool:
    """出題に適さない語を弾く."""
    if word in STOPWORDS:
        return False
    if not WORD_RE.match(word):   # 記号・数字・複合語を除外
        return False
    if len(word) < 3:             # 2文字語は機能語がほとんど
        return False
    return True


def main(cutoff: int = BASIC_CUTOFF_RANK,
         nawl_offset: float = NAWL_DIFFICULTY_OFFSET,
         write: bool = True) -> int:
    ngsl = load_ngsl()
    nawl = load_nawl()
    print(f"読み込み: NGSL {len(ngsl)} 語 / NAWL {len(nawl)} 語")

    # --- NGSL: 超基本語を除外 ---
    ngsl_kept = [r for r in ngsl if r["rank"] > cutoff and is_usable(r["word"])]
    print(f"NGSL: 頻度上位 {cutoff} 位までを基本語として除外 "
          f"→ {len(ngsl_kept)} 語")

    nawl_kept = [r for r in nawl if is_usable(r["word"])]
    print(f"NAWL: 使用可能な {len(nawl_kept)} 語")

    # --- 難易度の正規化（コーパスが違うので SFI 直接比較は不可） ---
    ngsl_span = max(r["rank"] for r in ngsl_kept) - cutoff
    for r in ngsl_kept:
        r["difficulty"] = (r["rank"] - cutoff) / ngsl_span

    nawl_max = max(r["rank"] for r in nawl_kept)
    for r in nawl_kept:
        p = r["rank"] / nawl_max
        r["difficulty"] = nawl_offset + (1 - nawl_offset) * p

    # --- 統合（NGSL 優先で重複排除） ---
    merged: dict[str, dict] = {}
    for r in ngsl_kept + nawl_kept:
        merged.setdefault(r["word"], r)
    dupes = len(ngsl_kept) + len(nawl_kept) - len(merged)
    print(f"統合: {len(merged)} 語（重複 {dupes} 語を除去）")

    candidates = sorted(merged.values(), key=lambda r: r["difficulty"])
    if len(candidates) < TARGET_WORD_COUNT:
        print(f"[!] 候補が {len(candidates)} 語しかなく、目標 {TARGET_WORD_COUNT} 語に届きません。"
              f"\n    config.BASIC_CUTOFF_RANK を下げてください。")
        return 1

    selected = candidates[:TARGET_WORD_COUNT]

    # --- ティア分け ---
    words, cursor = [], 0
    for tier_name, size in TIERS:
        for r in selected[cursor:cursor + size]:
            words.append({
                "word": r["word"],
                "tier": tier_name,
                "source": r["source"],
                "source_rank": r["rank"],
                "sfi": r["sfi"],
            })
        cursor += size

    if write:
        out_path = BUILD / "wordlist.json"
        out_path.write_text(
            json.dumps(words, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n出力: {out_path}  ({len(words)} 語)\n")
    else:
        print(f"\n[dry-run] 書き出しなし ({len(words)} 語)\n")

    # --- 診断出力（レベル感の確認用） ---
    cursor = 0
    for tier_name, size in TIERS:
        chunk = words[cursor:cursor + size]
        n_nawl = sum(1 for w in chunk if w["source"] == "nawl")
        sample = ", ".join(w["word"] for w in chunk[::max(1, size // 8)][:8])
        print(f"  {tier_name}: {len(chunk):>4} 語  "
              f"(NAWL {n_nawl:>3} 語 = {n_nawl / len(chunk):.0%})")
        print(f"    例: {sample}")
        cursor += size

    print("\nstep2 完了。レベル感が想定とずれていれば config.py の "
          "BASIC_CUTOFF_RANK / NAWL_DIFFICULTY_OFFSET を調整して再実行してください。")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="NGSL+NAWL から単語リストを構築")
    ap.add_argument("--cutoff", type=int, default=BASIC_CUTOFF_RANK,
                    help="NGSL の何位までを基本語として除外するか")
    ap.add_argument("--nawl-offset", type=float, default=NAWL_DIFFICULTY_OFFSET,
                    help="NAWL 語の難易度下駄 (0..1)")
    ap.add_argument("--dry-run", action="store_true",
                    help="レベル感の確認のみ。ファイルを書き出さない")
    a = ap.parse_args()
    sys.exit(main(a.cutoff, a.nawl_offset, write=not a.dry_run))
