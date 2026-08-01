"""step3: JMdict から各英単語の日本語訳候補を抽出する.

JMdict は和英辞書（日本語見出し → 英語 gloss）なので、
gloss 側から逆引きインデックスを作って英和として使う。

各候補は次を持つ:
  display  … 画面に出す表記（uk タグならかな、そうでなければ漢字）
  reading  … 判定に使う読み（ひらがな）
  misc/field/common/gloss_pos … step4 の選別に使うメタ情報

入力: sources/JMdict_e.gz, build/wordlist.json
出力: build/glosses.json
"""

from __future__ import annotations

import gzip
import io
import json
import re
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict

from config import BUILD, KANA_PREFERRED_TAG, MAX_GLOSS_CANDIDATES, SOURCE_FILES

# JMdict は DTD で独自エンティティ (&n; &vs; など) を定義している。
# ElementTree は DTD のエンティティ宣言を解決しないので、事前に素のテキストへ置換する。
ENTITY_RE = re.compile(rb"&(?!amp;|lt;|gt;|quot;|apos;)([A-Za-z0-9-]+);")

# 「よく使う語」を示す優先度タグ
COMMON_TAGS = {"news1", "ichi1", "spec1", "gai1"}

PAREN_RE = re.compile(r"\([^)]*\)")
LEAD_TO_RE = re.compile(r"^to\s+")
LEAD_ART_RE = re.compile(r"^(?:a|an|the)\s+")

# JMdict の gloss は "to rely on" のように前置詞付きのことが多い。
# そのままだとキーが "rely on" になり、"rely" で引けない。
# 前置詞を落としたキーでも引けるようにする（phrasal フラグを立てて優先度は下げる）。
TRAILING_PREPS = {
    "on", "upon", "to", "for", "with", "in", "at", "from", "into", "of",
    "about", "after", "over", "out", "up", "down", "off", "against",
    "as", "by", "through", "toward", "towards", "around",
}

# JMdict は名詞的な項目を動名詞で訳すことが多い。
#   無視 → "disregarding; ignoring"
# そのため "ignore" では引けない。語形を前方に展開して引き直す。
FORWARD_RULES = [
    ("e", "ing"),   # ignore  → ignoring
    ("", "ing"),    # regard  → regarding
    ("", "s"),      # ignore  → ignores
    ("", "d"),      # ignore  → ignored
    ("", "ed"),     # regard  → regarded
    ("y", "ies"),   # apply   → applies
    ("", "es"),     # watch   → watches
    ("", "ment"),   # develop → development
    ("e", "ion"),   # create  → creation
    ("", "ion"),    # predict → prediction
    ("", "ation"),  # expect  → expectation
    ("", "ance"),   # accept  → acceptance
    ("", "ence"),   # refer   → reference
    ("", "ness"),   # aware   → awareness
    ("y", "ication"),  # notify → notification
]

# 派生語 → 語幹 の候補を作るルール（step3 の取りこぼしを救う）
# (接尾辞, 置換後) の順に試す
BACKOFF_RULES = [
    ("ological", "ology"), ("ically", "ic"), ("ically", ""),
    ("ical", "ics"), ("ically", "ics"),
    ("ally", "al"), ("ally", ""),
    ("tic", "sis"), ("ern", ""),
    ("ly", ""), ("ness", ""), ("ity", ""), ("ity", "e"),
    ("ive", "ion"), ("ive", "e"), ("ive", ""),
    ("ation", "ate"), ("ation", ""), ("tion", "te"), ("tion", ""),
    ("sion", "de"), ("sion", ""), ("ment", ""), ("ance", ""), ("ence", ""),
    ("ial", ""), ("al", ""),
    ("ous", ""), ("ic", ""), ("ary", ""), ("ist", ""),
    ("ize", ""), ("ise", ""), ("ify", ""),
    ("er", ""), ("or", ""), ("ing", "e"), ("ing", ""),
    ("ed", "e"), ("ed", ""), ("es", ""), ("s", ""),
]


def katakana_to_hiragana(s: str) -> str:
    return "".join(
        chr(ord(c) - 0x60) if 0x30A1 <= ord(c) <= 0x30F6 else c for c in s
    )


def normalize_gloss(gloss: str) -> str:
    g = PAREN_RE.sub(" ", gloss).strip().lower()
    g = LEAD_TO_RE.sub("", g)
    g = LEAD_ART_RE.sub("", g)
    return re.sub(r"\s+", " ", g).strip()


def is_common(pri_tags: list[str]) -> bool:
    if COMMON_TAGS & set(pri_tags):
        return True
    for t in pri_tags:  # nf01..nf48 は頻度バンド
        if t.startswith("nf"):
            try:
                if int(t[2:]) <= 24:
                    return True
            except ValueError:
                pass
    return False


# nf バンドが無い語を表す番兵
NO_FREQ_BAND = 99


def freq_band(pri_tags: list[str]) -> int:
    """nf01..nf48 の頻度バンド。小さいほど高頻度。無ければ NO_FREQ_BAND.

    common の真偽値より細かいので、「橋」と「陸橋」のように
    どちらも sense#0 で常用の語を正しく順序づけられる。
    """
    best = NO_FREQ_BAND
    for t in pri_tags:
        if t.startswith("nf"):
            try:
                best = min(best, int(t[2:]))
            except ValueError:
                pass
    return best


def load_jmdict_xml() -> bytes:
    print("  JMdict を展開中...")
    with gzip.open(SOURCE_FILES["jmdict"], "rb") as f:
        raw = f.read()
    print(f"  展開後 {len(raw):,} bytes / エンティティを正規化中...")
    return ENTITY_RE.sub(rb"\1", raw)


def build_reverse_index() -> dict[str, list[dict]]:
    """英語 gloss → 日本語見出し候補 の逆引きインデックス."""
    index: dict[str, list[dict]] = defaultdict(list)
    n_entries = 0

    for _, entry in ET.iterparse(io.BytesIO(load_jmdict_xml()), events=("end",)):
        if entry.tag != "entry":
            continue
        n_entries += 1

        kanji, k_pri = None, []
        for k in entry.findall("k_ele"):
            kanji = k.findtext("keb")
            k_pri = [p.text for p in k.findall("ke_pri") if p.text]
            break

        reading, r_pri = None, []
        for r in entry.findall("r_ele"):
            reading = r.findtext("reb")
            r_pri = [p.text for p in r.findall("re_pri") if p.text]
            break

        if not reading:
            entry.clear()
            continue

        pri_tags = k_pri + r_pri
        common = is_common(pri_tags)
        nf = freq_band(pri_tags)
        hira = katakana_to_hiragana(reading)

        for sense_index, sense in enumerate(entry.findall("sense")):
            misc = [m.text for m in sense.findall("misc") if m.text]
            field = [f.text for f in sense.findall("field") if f.text]
            pos = [p.text for p in sense.findall("pos") if p.text]

            # 英語からの外来語かどうか。
            # leadership → リーダーシップ のような音写は、意味を理解していなくても
            # 答えられてしまうので代表訳には使わない（許容解には残す）。
            loan_sources = {
                (ls.text or "").strip().lower()
                for ls in sense.findall("lsource")
                if ls.get("{http://www.w3.org/XML/1998/namespace}lang") in (None, "eng")
            }

            # uk (usually kana alone) なら表示もかなにする
            display = reading if (KANA_PREFERRED_TAG in misc or not kanji) else kanji

            for gi, gloss_el in enumerate(sense.findall("gloss")):
                if not gloss_el.text:
                    continue
                key = normalize_gloss(gloss_el.text)
                if not key or len(key.split()) > 3:
                    continue  # 長い説明文は訳語として使わない

                # "rely on" → "rely" でも引けるようにする
                keys = [(key, False)]
                parts = key.split()
                if len(parts) == 2 and parts[1] in TRAILING_PREPS:
                    keys.append((parts[0], True))

                for k, phrasal in keys:
                    index[k].append({
                        "display": display,
                        "reading": hira,
                        "pos": pos,
                        "misc": misc,
                        "field": field,
                        "common": common,
                        "nf": nf,          # 頻度バンド（小さいほど高頻度）
                        # sense_index はその英語がこの日本語の何番目の語義かを表す。
                        # 「振り切る」の "ignore" は sense#3 ＝ 極めて周辺的。
                        # ここを見ないと周辺的な語義を代表訳に選んでしまう。
                        "sense_index": sense_index,
                        "gloss_pos": gi,   # sense 内で先頭に近いほど中心的
                        "exact": " " not in key,
                        "phrasal": phrasal,
                        "loan_sources": sorted(loan_sources),
                    })

        entry.clear()

    print(f"  {n_entries:,} エントリを処理 / gloss キー {len(index):,} 件")
    return index


def lookup(index: dict, word: str) -> tuple[list[dict], str | None]:
    """語形を変えながら候補を集める.

    直接ヒットがあっても前方展開の結果を必ず統合する。
    直接ヒットが周辺的な語義しか持たないことがあるため。
      例: "ignore" は 振り切る の sense#3 に直接ヒットするが、
          本命の 無視 は "ignoring" にしか登録されていない。

    戻り値: (候補リスト, 使った語幹 or None)
    """
    collected: list[dict] = [
        {**c, "derived": False} for c in index.get(word, [])
    ]

    # 前方展開: JMdict は名詞的な項目を動名詞などで訳すことが多い
    for suf, add in FORWARD_RULES:
        if suf and not word.endswith(suf):
            continue
        form = (word[: -len(suf)] if suf else word) + add
        if form == word or form not in index:
            continue
        collected.extend({**c, "derived": True} for c in index[form])

    if collected:
        return collected, None

    # 最後の手段: 派生語を語幹に落として引く
    for suf, repl in BACKOFF_RULES:
        if not word.endswith(suf) or len(word) - len(suf) < 3:
            continue
        stem = word[: -len(suf)] + repl
        if stem in index:
            return [{**c, "derived": True} for c in index[stem]], stem
        # 語末重複の解消: running → run
        if len(stem) > 3 and stem[-1] == stem[-2] and stem[:-1] in index:
            return [{**c, "derived": True} for c in index[stem[:-1]]], stem[:-1]
    return [], None


# 造語成分を示す品詞タグ。
# 「料」(fee) や「版」(edition) は単独の語ではなく接尾辞なので代表訳にしない。
AFFIX_POS = {"n-suf", "n-pref", "suf", "pref", "ctr"}


def _is_katakana_only(s: str) -> bool:
    """カタカナだけで書かれているか（外来語の音写かどうかの判定）."""
    return bool(s) and all(
        0x30A0 <= ord(ch) <= 0x30FF or ch in "ー・" for ch in s
    )


def _kanji_count(s: str) -> int:
    return sum(1 for ch in s if "一" <= ch <= "鿿")


def candidate_score(c: dict, word: str) -> int:
    """候補の悪さ。小さいほど良い訳語。

    最も効くのは sense_index（その英語がこの日本語の何番目の語義か）。
    「振り切る」の "ignore" は sense#3 なので大きく減点され、
    sense#0 の「無視」に負ける。
    """
    score = c["sense_index"] * 3 + c["gloss_pos"]

    # 語の頻度。common の真偽値より nf バンドのほうが細かく、
    # 「橋」(高頻度) と「陸橋」(低頻度) のようにどちらも sense#0 の
    # 常用語である組を正しく順序づけられる。
    nf = c.get("nf", NO_FREQ_BAND)
    if nf <= 8:
        pass
    elif nf <= 16:
        score += 1
    elif nf <= 24:
        score += 2
    elif nf <= 48:
        score += 3
    elif c["common"]:
        score += 2          # ichi1/news1 等はあるが頻度バンドが無い
    else:
        score += 4

    if c.get("phrasal"):
        score += 2          # "rely on" から前置詞を落として引いた
    if c.get("derived"):
        score += 1          # 語形を変えて引いた

    display = c.get("display", "")

    # asset → アセット のような音写。意味を理解していなくても答えられるので
    # 代表訳には使わない（許容解には残す）。
    # JMdict の lsource は原語を持たないことが多く当てにならないため、
    # 表記がカタカナだけかどうかで判定する。
    if _is_katakana_only(display) or word in c.get("loan_sources", []):
        score += 3

    # 「料」「版」のような接尾辞・助数詞は単独の訳語にならない
    if AFFIX_POS & set(c.get("pos", [])):
        score += 3

    return score


def main() -> int:
    print("step3: JMdict から訳語候補を抽出します\n")

    wordlist = json.loads((BUILD / "wordlist.json").read_text(encoding="utf-8"))
    index = build_reverse_index()

    result: dict[str, dict] = {}
    n_direct = n_backoff = n_missing = 0
    missing: list[str] = []

    for entry in wordlist:
        word = entry["word"]
        cands, stem = lookup(index, word)

        # 同じ読みの重複を除去（表示違いは1つにまとめる）
        seen, picked = set(), []
        ranked = sorted(cands, key=lambda c: (candidate_score(c, word),
                                              len(c["reading"])))
        for c in ranked:
            if c["reading"] in seen:
                continue
            seen.add(c["reading"])
            picked.append(c)
            if len(picked) >= MAX_GLOSS_CANDIDATES:
                break

        if not picked:
            n_missing += 1
            missing.append(word)
        elif stem:
            n_backoff += 1
        else:
            n_direct += 1

        result[word] = {"candidates": picked, "via_stem": stem}

    out_path = BUILD / "glosses.json"
    out_path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    total = len(wordlist)
    print(f"\n出力: {out_path}")
    print(f"  直接ヒット      : {n_direct} ({n_direct/total:.1%})")
    print(f"  語幹フォールバック: {n_backoff} ({n_backoff/total:.1%})")
    print(f"  未ヒット        : {n_missing} ({n_missing/total:.1%})")
    if missing:
        print(f"    → {', '.join(missing[:25])}"
              + (" ..." if len(missing) > 25 else ""))

    print("\n  抽出例:")
    for w in ["dear", "moreover", "consider", "objective"]:
        r = result.get(w)
        if not r or not r["candidates"]:
            continue
        shown = "、".join(
            f"{c['display']}({c['reading']})" for c in r["candidates"][:5])
        print(f"    {w:<12} → {shown}")

    print("\nstep3 完了。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
