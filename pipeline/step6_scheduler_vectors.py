"""step6: スケジューラの検証用テストベクタを生成する.

実データで複数日の学習をシミュレートし、
「いつ・どの語が出題され・どう状態が更新されたか」を全て記録する。
Swift 側が同じ入力から同じ軌跡を再現できれば移植は正しい。

入力: out/vocabulary.json
出力: out/scheduler_testcases.json
"""

from __future__ import annotations

import json
import sys
from collections import Counter

from config import OUT
from scheduler import (
    CardState,
    Grade,
    Rng,
    Scheduler,
    SchedulerWord,
    review,
)

# シミュレーションの条件（Swift 側と一致させること）
SCHEDULER_SEED = 20260801
LEARNER_SEED = 12345
DAYS = 60
REVIEWS_PER_DAY = 60

# 想起率を整数化する分解能。
# pow() の最終桁のずれで「思い出せたか」の判定が反転しないようにする。
PROB_SCALE = 1_000_000

# 「ど忘れ」の確率。想起率に関係なく完全に失敗する割合。
# これが無いと、出題は常に想起率0.9前後で行われるため模擬学習者がほぼ失敗せず、
# FSRS の失敗時の式とリーチ検出が一度も検証されない。
BLANK_OUT_PROB = 80_000   # 8%


def simulated_answer(r: float, rng: Rng) -> Grade:
    """想起率 r の語に対する、模擬学習者の解答.

    浮動小数の比較を避けるため、確率を整数化してから判定する。
    """
    if rng.below(PROB_SCALE) < BLANK_OUT_PROB:
        return Grade.again

    r_q = max(0, min(PROB_SCALE, int(round(r * PROB_SCALE))))
    if rng.below(PROB_SCALE) < r_q:
        # 思い出せた。よく覚えているものは即答＝easy 扱い。
        return Grade.easy if r_q > 950_000 else Grade.good
    # 思い出せなかった。惜しい場合は「自己申告で正解」＝hard 扱い。
    return Grade.hard if r_q > 500_000 else Grade.again


def main() -> int:
    vocab_path = OUT / "vocabulary.json"
    if not vocab_path.exists():
        print(f"[!] {vocab_path} がありません。先に step5 を実行してください。")
        return 1

    vocab = json.loads(vocab_path.read_text(encoding="utf-8"))
    words = [
        SchedulerWord(word_id=w["id"], word=w["word"],
                      reading=w["reading"], difficulty=w["difficulty"])
        for w in vocab["words"]
    ]
    print(f"{len(words)} 語で {DAYS} 日 × {REVIEWS_PER_DAY} 回をシミュレートします\n")

    scheduler = Scheduler(words, seed=SCHEDULER_SEED)
    learner = Rng(LEARNER_SEED)
    states: dict[int, CardState] = {
        w.word_id: CardState(word_id=w.word_id) for w in words
    }

    steps = []
    for day in range(DAYS):
        introduced_today = 0
        for _ in range(REVIEWS_PER_DAY):
            word_id = scheduler.next_word(states, day, introduced_today)
            if word_id is None:
                break
            state = states[word_id]
            if state.is_new:
                introduced_today += 1
                grade = Grade.good
            else:
                grade = simulated_answer(state.retrievability_on(day), learner)

            updated = review(state, grade, day)
            states[word_id] = updated
            steps.append({
                "day": day,
                "word_id": word_id,
                "grade": int(grade),
                "stability": updated.stability,
                "difficulty": updated.difficulty,
                "reps": updated.reps,
                "lapses": updated.lapses,
                "due_day": updated.due_day,
            })

    payload = {
        "config": {
            "scheduler_seed": SCHEDULER_SEED,
            "learner_seed": LEARNER_SEED,
            "days": DAYS,
            "reviews_per_day": REVIEWS_PER_DAY,
            "prob_scale": PROB_SCALE,
        },
        "steps": steps,
    }
    out_path = OUT / "scheduler_testcases.json"
    out_path.write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    # --- レポート ---
    print(f"出力: {out_path}  ({len(steps)} ステップ)")
    studied = {s["word_id"] for s in steps}
    print(f"  出題された語     : {len(studied)}/{len(words)}")
    print("  評点の内訳       : " + " ".join(
        f"{Grade(g).name}:{c}" for g, c in
        sorted(Counter(s['grade'] for s in steps).items())))

    final = [states[w] for w in studied]
    matured = sum(1 for s in final if s.stability >= 21)
    leeches = sum(1 for s in final if s.lapses >= 8)
    print(f"  定着した語(S≥21): {matured}")
    print(f"  リーチ語(8回以上失敗): {leeches}")

    # 出題順の多様性 — 本アプリの中核要件の確認
    order = [s["word_id"] for s in steps]
    followers: dict[int, set[int]] = {}
    for a, b in zip(order, order[1:]):
        followers.setdefault(a, set()).add(b)
    avg = sum(len(v) for v in followers.values()) / len(followers)
    print(f"  同じ語の次に来る語: 平均 {avg:.1f} 種類（順番暗記の防止）")

    print("\nstep6 完了。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
