"""scheduler の挙動確認.

実行:  py test_scheduler.py
"""

from __future__ import annotations

import sys
from collections import Counter

from scheduler import (
    CardState,
    Grade,
    Rng,
    Scheduler,
    SchedulerConfig,
    SchedulerWord,
    next_interval,
    retrievability,
    review,
)

failures: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  [{'ok  ' if ok else 'FAIL'}] {label}"
          + (f"  — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def sample_words(n: int = 60) -> list[SchedulerWord]:
    return [
        SchedulerWord(word_id=i, word=f"word{i:03d}",
                      reading=f"よみ{i:03d}", difficulty=1 + i % 5)
        for i in range(1, n + 1)
    ]


# =============================================================================
print("乱数 (SplitMix64)")

r1 = Rng(42)
r2 = Rng(42)
check("同じシードで同じ系列",
      [r1.next_u64() for _ in range(5)] == [r2.next_u64() for _ in range(5)])
check("違うシードで違う系列",
      [Rng(1).next_u64() for _ in range(3)] != [Rng(2).next_u64() for _ in range(3)])

rng = Rng(7)
draws = [rng.below(10) for _ in range(20000)]
counts = Counter(draws)
check("below(n) が範囲内", all(0 <= d < 10 for d in draws))
spread = max(counts.values()) / min(counts.values())
check("below(n) が概ね一様", spread < 1.15, f"最大/最小 = {spread:.3f}")

check("shuffled が要素を保存",
      sorted(Rng(3).shuffled(list(range(50)))) == list(range(50)))
check("shuffled が並びを変える", Rng(3).shuffled(list(range(50))) != list(range(50)))


# =============================================================================
print("\nFSRS")

new = CardState(word_id=1)
check("未学習は is_new", new.is_new)
check("未学習の想起率は 0", new.retrievability_on(0) == 0.0)

good = review(new, Grade.good, day=0)
check("初回 good で安定度が付く", good.stability > 0, f"S={good.stability:.3f}")
check("初回 good で reps=1", good.reps == 1)
check("初回で次回期限が未来", good.due_day > 0, f"due={good.due_day}")

again = review(new, Grade.again, day=0)
easy = review(new, Grade.easy, day=0)
check("again < good < easy の安定度",
      again.stability < good.stability < easy.stability,
      f"{again.stability:.2f} < {good.stability:.2f} < {easy.stability:.2f}")
check("again は難易度が高い", again.difficulty > easy.difficulty,
      f"{again.difficulty:.2f} > {easy.difficulty:.2f}")

check("想起率は時間とともに下がる",
      retrievability(10, 0) > retrievability(10, 5) > retrievability(10, 30))
check("想起率は 0..1", 0.0 <= retrievability(10, 100) <= 1.0)
check("安定度が高いほど忘れにくい",
      retrievability(50, 10) > retrievability(5, 10))

# 復習を重ねると安定度が伸びる
state, day = good, good.due_day
stabilities = [state.stability]
for _ in range(5):
    state = review(state, Grade.good, day)
    stabilities.append(state.stability)
    day = state.due_day
check("正解を重ねると安定度が単調に伸びる",
      all(b > a for a, b in zip(stabilities, stabilities[1:])),
      " → ".join(f"{s:.1f}" for s in stabilities))
check("間隔も伸びる", next_interval(stabilities[-1]) > next_interval(stabilities[0]))

lapsed = review(state, Grade.again, state.due_day)
check("失敗で安定度が下がる", lapsed.stability < state.stability,
      f"{state.stability:.1f} → {lapsed.stability:.1f}")
check("失敗で lapses が増える", lapsed.lapses == state.lapses + 1)

# 難易度が範囲外に振り切れないこと
d = review(CardState(word_id=1), Grade.again, 0)
for _ in range(30):
    d = review(d, Grade.again, d.due_day)
check("難易度の上限が守られる", d.difficulty <= 10.0, f"D={d.difficulty:.3f}")
e = review(CardState(word_id=1), Grade.easy, 0)
for _ in range(30):
    e = review(e, Grade.easy, e.due_day)
check("難易度の下限が守られる", e.difficulty >= 1.0, f"D={e.difficulty:.3f}")


# =============================================================================
print("\n出題スケジューラ")

words = sample_words()


def run(seed: int, steps: int = 200, cfg: SchedulerConfig | None = None):
    """全語を学習済みにしてから steps 回出題する."""
    sched = Scheduler(words, seed=seed, config=cfg)
    states = {
        w.word_id: review(CardState(word_id=w.word_id), Grade.good, 0)
        for w in words
    }
    # 半数を「忘れかけ」にする
    for wid in list(states)[:30]:
        states[wid] = CardState(word_id=wid, stability=1.0, difficulty=5.0,
                                reps=3, lapses=0, last_review_day=0, due_day=1)
    order = []
    for _ in range(steps):
        wid = sched.next_word(states, day=30, introduced_today=999)
        if wid is None:
            break
        order.append(wid)
    return order


order_a = run(seed=1)
order_b = run(seed=1)
order_c = run(seed=2)

check("同じシードで同じ出題順", order_a == order_b)
check("違うシードで違う出題順", order_a != order_c)
check("十分な回数出題される", len(order_a) == 200, f"{len(order_a)} 回")

# --- 順番で覚えられないこと（本アプリの中核要件）---
first = order_a[:60]
second = order_a[60:120]
check("同じ並びが繰り返されない", first != second)

# 語 X の直後に来る語が毎回同じでないこと
followers: dict[int, set[int]] = {}
for a, b in zip(order_a, order_a[1:]):
    followers.setdefault(a, set()).add(b)
varied = [len(v) for v in followers.values() if len(v) >= 1]
check("同じ語の次に来る語が固定されない",
      sum(varied) / len(varied) > 1.5,
      f"平均 {sum(varied)/len(varied):.2f} 種類")

# --- クールダウン ---
cfg = SchedulerConfig()
window = cfg.cooldown_window
violations = sum(
    1 for i in range(len(order_a))
    for j in range(max(0, i - window), i)
    if order_a[i] == order_a[j]
)
check(f"直近 {window} 件に同じ語が出ない", violations == 0,
      f"違反 {violations} 件")

# --- 干渉回避 ---
# affect / effect は編集距離1で紛らわしい。
# accept は affect から距離3（ffe→cce）なので閾値2の対象外＝別語として扱われる。
# 読みが同じ組（1と7）も干渉扱いになること。
interference_words = [
    SchedulerWord(1, "affect", "えいきょう", 3),
    SchedulerWord(2, "effect", "こうか", 3),
    SchedulerWord(3, "accept", "うけいれる", 3),
    SchedulerWord(4, "banana", "ばなな", 3),
    SchedulerWord(5, "window", "まど", 3),
    SchedulerWord(6, "purple", "むらさき", 3),
    SchedulerWord(7, "influence", "えいきょう", 3),   # 1 と同じ読み
]
sched = Scheduler(interference_words, seed=5,
                  config=SchedulerConfig(cooldown_window=1))
states = {
    w.word_id: CardState(word_id=w.word_id, stability=1.0, difficulty=5.0,
                         reps=3, lapses=0, last_review_day=0, due_day=1)
    for w in interference_words
}
seq = [sched.next_word(states, day=30, introduced_today=999) for _ in range(200)]

spelling_adjacent = sum(1 for a, b in zip(seq, seq[1:]) if {a, b} == {1, 2})
check("綴りが紛らわしい語が隣接しない", spelling_adjacent == 0,
      f"affect/effect の隣接 {spelling_adjacent} 件")

reading_adjacent = sum(1 for a, b in zip(seq, seq[1:]) if {a, b} == {1, 7})
check("読みが同じ語が隣接しない", reading_adjacent == 0,
      f"同一読みの隣接 {reading_adjacent} 件")

check("干渉しない語は普通に隣接する",
      any({a, b} == {1, 3} for a, b in zip(seq, seq[1:])),
      "accept は距離3なので affect と隣接してよい")

# --- 忘れかけの語が優先されること ---
sched = Scheduler(words, seed=9)
states = {}
for i, w in enumerate(words):
    # 前半は「よく覚えている」、後半は「忘れかけ」
    if i < 30:
        states[w.word_id] = CardState(word_id=w.word_id, stability=200.0,
                                      difficulty=5.0, reps=5, lapses=0,
                                      last_review_day=29, due_day=1)
    else:
        states[w.word_id] = CardState(word_id=w.word_id, stability=1.0,
                                      difficulty=5.0, reps=5, lapses=0,
                                      last_review_day=0, due_day=1)
picked = [sched.next_word(states, day=30, introduced_today=999)
          for _ in range(600)]
weak = sum(1 for p in picked if p is not None and p > 30)
check("忘れかけの語が優先して出る", weak / len(picked) > 0.7,
      f"忘れかけ {weak/len(picked):.1%}")

# --- 新規語の投入 ---
sched = Scheduler(words, seed=11)
states = {w.word_id: CardState(word_id=w.word_id) for w in words}
introduced = []
for i in range(15):
    wid = sched.next_word(states, day=0, introduced_today=i)
    if wid is None:
        break
    introduced.append(wid)
    states[wid] = review(states[wid], Grade.good, 0)
check("未学習時は新規語が投入される", len(introduced) == 15, f"{len(introduced)} 語")
check("新規語に重複が無い", len(set(introduced)) == len(introduced))
check("新規語は易しい順に寄る",
      sum(sched.words[w].difficulty for w in introduced) / len(introduced) < 2.5,
      f"平均難易度 {sum(sched.words[w].difficulty for w in introduced)/len(introduced):.2f}")

# 別シードでは投入順が変わること（全ユーザー同じ順序にしない）
sched2 = Scheduler(words, seed=99)
states2 = {w.word_id: CardState(word_id=w.word_id) for w in words}
introduced2 = []
for i in range(15):
    wid = sched2.next_word(states2, day=0, introduced_today=i)
    introduced2.append(wid)
    states2[wid] = review(states2[wid], Grade.good, 0)
check("新規語の投入順がシードで変わる", introduced != introduced2)

# --- リーチ ---
leech = CardState(word_id=1, stability=1.0, difficulty=9.0, reps=20,
                  lapses=10, last_review_day=0, due_day=1)
normal = CardState(word_id=2, stability=1.0, difficulty=9.0, reps=20,
                   lapses=0, last_review_day=0, due_day=1)
s = Scheduler(words, seed=1)
check("リーチ語と判定される", s.is_leech(leech))
check("リーチ語の重みが下がる", s.weight(leech, 30) < s.weight(normal, 30),
      f"{s.weight(leech, 30):.4f} < {s.weight(normal, 30):.4f}")


# =============================================================================
print()
if failures:
    print(f"{len(failures)} 件失敗: {', '.join(failures)}")
    sys.exit(1)
print("すべて通過")
