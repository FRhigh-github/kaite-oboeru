"""出題スケジューラ — 参照実装.

2つの要素からなる。

1. **FSRS**（記憶モデル）
   各語の「安定度」「難易度」を更新し、いつ忘れるかを推定する。

2. **重み付き抽選**（出題順の決定）
   忘れかけの語ほど高確率で選ばれるが、**順位順に並べて上から出すことはしない**。
   毎回抽選するので同じ順番は二度と再現されず、「順番で覚える」が構造的に起きない。
   これが本アプリの中核要件。

アプリ本体（Swift）はこれと同一の挙動を実装すること。
step6 が生成する out/scheduler_testcases.json で両者の一致を検証できる。

**再現性についての注意**
Python と Swift で同一の出力を得るため、次の2点を守っている。
- 言語標準の乱数は実装が違うので使わず、SplitMix64 を自前で持つ
- exp/pow は処理系で最終桁がずれうるため、抽選の重みは整数に量子化してから使う
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import IntEnum

# =============================================================================
# 決定的乱数 (SplitMix64)
# =============================================================================

MASK64 = (1 << 64) - 1


class Rng:
    """SplitMix64。Swift 側と同一の系列を返すことが要件."""

    def __init__(self, seed: int) -> None:
        self.state = seed & MASK64

    def next_u64(self) -> int:
        self.state = (self.state + 0x9E3779B97F4A7C15) & MASK64
        z = self.state
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK64
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK64
        return (z ^ (z >> 31)) & MASK64

    def below(self, n: int) -> int:
        """0 以上 n 未満の一様乱数。剰余バイアスを除去してある."""
        if n <= 1:
            return 0
        # 2^64 mod n。これ未満の値を捨てると分布が厳密に一様になる。
        threshold = ((1 << 64) - n) % n
        while True:
            r = self.next_u64()
            if r >= threshold:
                return r % n

    def shuffled(self, items: list) -> list:
        """Fisher-Yates。Swift 側と同一の並びになること."""
        out = list(items)
        for i in range(len(out) - 1, 0, -1):
            j = self.below(i + 1)
            out[i], out[j] = out[j], out[i]
        return out


# =============================================================================
# FSRS
# =============================================================================

class Grade(IntEnum):
    """3値判定 + 自己申告から導かれる評点."""
    again = 1   # 不正解
    hard = 2    # 「惜しい」を自己申告で正解にした
    good = 3    # 正解
    easy = 4    # 即答で正解


# FSRS-4.5 の既定パラメータ。
# 将来ユーザーの学習ログから最適化する余地があるが、既定値でも十分機能する。
W: list[float] = [
    0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.0310,
    1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.5870, 0.2272, 2.8755,
]

DECAY = -0.5
FACTOR = 19.0 / 81.0

MIN_DIFFICULTY = 1.0
MAX_DIFFICULTY = 10.0
MIN_STABILITY = 0.01

# 目標とする想起率。次回出題間隔の算出に使う。
REQUEST_RETENTION = 0.9


def initial_stability(grade: Grade) -> float:
    return max(W[int(grade) - 1], MIN_STABILITY)


def initial_difficulty(grade: Grade) -> float:
    d = W[4] - math.exp(W[5] * (int(grade) - 1)) + 1.0
    return _clamp_difficulty(d)


def _clamp_difficulty(d: float) -> float:
    return min(max(d, MIN_DIFFICULTY), MAX_DIFFICULTY)


def retrievability(stability: float, elapsed_days: float) -> float:
    """経過日数後にまだ思い出せる確率 (0..1)."""
    if stability <= 0:
        return 0.0
    if elapsed_days <= 0:
        return 1.0
    return (1.0 + FACTOR * elapsed_days / stability) ** DECAY


def next_interval(stability: float,
                  request_retention: float = REQUEST_RETENTION) -> int:
    """想起率が request_retention まで下がるまでの日数."""
    if stability <= 0:
        return 1
    days = (stability / FACTOR) * (request_retention ** (1.0 / DECAY) - 1.0)
    return max(1, int(round(days)))


def _next_difficulty(difficulty: float, grade: Grade) -> float:
    # 評点に応じて増減させたあと、初期難易度へ向けて平均回帰させる。
    # 回帰を入れないと難易度が際限なく振り切れる。
    d = difficulty - W[6] * (int(grade) - 3)
    d = W[7] * initial_difficulty(Grade.easy) + (1.0 - W[7]) * d
    return _clamp_difficulty(d)


def _stability_after_success(stability: float, difficulty: float,
                             r: float, grade: Grade) -> float:
    hard_penalty = W[15] if grade == Grade.hard else 1.0
    easy_bonus = W[16] if grade == Grade.easy else 1.0
    growth = (
        math.exp(W[8])
        * (11.0 - difficulty)
        * (stability ** -W[9])
        * (math.exp(W[10] * (1.0 - r)) - 1.0)
        * hard_penalty
        * easy_bonus
    )
    return max(stability * (1.0 + growth), MIN_STABILITY)


def _stability_after_lapse(stability: float, difficulty: float,
                           r: float) -> float:
    s = (
        W[11]
        * (difficulty ** -W[12])
        * (((stability + 1.0) ** W[13]) - 1.0)
        * math.exp(W[14] * (1.0 - r))
    )
    # 失敗で安定度が上がることはない
    return max(min(s, stability), MIN_STABILITY)


# =============================================================================
# カードの状態
# =============================================================================

@dataclass
class CardState:
    """1語ぶんの学習状態。アプリではこれをローカル DB に永続化する."""
    word_id: int
    stability: float = 0.0
    difficulty: float = 0.0
    reps: int = 0
    lapses: int = 0
    last_review_day: int = -1   # -1 = 未学習
    due_day: int = 0

    @property
    def is_new(self) -> bool:
        return self.reps == 0

    def retrievability_on(self, day: int) -> float:
        if self.is_new:
            return 0.0
        return retrievability(self.stability, day - self.last_review_day)


def review(state: CardState, grade: Grade, day: int) -> CardState:
    """1回の解答を反映した新しい状態を返す（元の状態は変更しない）."""
    if state.is_new:
        stability = initial_stability(grade)
        difficulty = initial_difficulty(grade)
        lapses = 1 if grade == Grade.again else 0
    else:
        r = state.retrievability_on(day)
        difficulty = _next_difficulty(state.difficulty, grade)
        if grade == Grade.again:
            stability = _stability_after_lapse(state.stability, difficulty, r)
            lapses = state.lapses + 1
        else:
            stability = _stability_after_success(
                state.stability, difficulty, r, grade)
            lapses = state.lapses

    interval = next_interval(stability)
    return CardState(
        word_id=state.word_id,
        stability=stability,
        difficulty=difficulty,
        reps=state.reps + 1,
        lapses=lapses,
        last_review_day=day,
        due_day=day + interval,
    )


# =============================================================================
# 出題スケジューラ
# =============================================================================

# 忘れかけの語をどれだけ優先するか。大きいほど「覚えていない語」に集中する。
URGENCY_EXPONENT = 2.0

# 直近この件数に出た語は候補から外す（連続出題の防止）
COOLDOWN_WINDOW = 12

# 直近この件数の語と綴りが似ていたら外す（干渉の防止）
INTERFERENCE_WINDOW = 6
INTERFERENCE_DISTANCE = 2

# この回数以上間違えた語は「リーチ」とみなす
LEECH_THRESHOLD = 8
# リーチ語の重み倍率。1未満にして出題過多による消耗を防ぐ
LEECH_WEIGHT = 0.5

# 1日に新規投入する語数の上限
NEW_PER_DAY = 20
# 復習待ちがこの数を下回ったら新規語を投入する
DUE_TARGET = 10

# 重みを整数に量子化する分解能。
# 浮動小数の最終桁のずれで抽選結果が変わるのを防ぐため。
WEIGHT_SCALE = 1_000_000


@dataclass
class SchedulerConfig:
    urgency_exponent: float = URGENCY_EXPONENT
    cooldown_window: int = COOLDOWN_WINDOW
    interference_window: int = INTERFERENCE_WINDOW
    interference_distance: int = INTERFERENCE_DISTANCE
    leech_threshold: int = LEECH_THRESHOLD
    leech_weight: float = LEECH_WEIGHT
    new_per_day: int = NEW_PER_DAY
    due_target: int = DUE_TARGET


@dataclass
class SchedulerWord:
    """スケジューラが必要とする最小限の語情報."""
    word_id: int
    word: str          # 英単語（干渉判定に使う）
    reading: str       # 代表の読み（干渉判定に使う）
    difficulty: int    # 1..5。初回投入順の決定に使う


def _edit_distance(a: str, b: str) -> int:
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


class Scheduler:
    """出題順を決める。

    設計の要点は「スコア順に並べて上から出さない」こと。
    並べてしまうと順番が固定され、ユーザーは意味ではなく順番を覚えてしまう。
    毎回重み付き抽選を行うことで、同じ並びが二度と再現されないようにしている。
    """

    def __init__(self, words: list[SchedulerWord], seed: int,
                 config: SchedulerConfig | None = None) -> None:
        self.config = config or SchedulerConfig()
        self.words = {w.word_id: w for w in words}
        self.rng = Rng(seed)
        # 新規語の投入順。辞書順や頻度順のままだと全ユーザーが同じ順序に
        # なるので、易しい順を保ちつつシード付きで揺らす。
        by_difficulty = sorted(words, key=lambda w: (w.difficulty, w.word_id))
        self.new_queue: list[int] = [
            w.word_id for w in self._jitter(by_difficulty)
        ]
        self.recent: list[int] = []

    def _jitter(self, words: list[SchedulerWord]) -> list[SchedulerWord]:
        """難易度の並びは保ちつつ、同難易度のなかだけシャッフルする."""
        out: list[SchedulerWord] = []
        bucket: list[SchedulerWord] = []
        current = None
        for w in words:
            if w.difficulty != current:
                out.extend(self.rng.shuffled(bucket))
                bucket, current = [], w.difficulty
            bucket.append(w)
        out.extend(self.rng.shuffled(bucket))
        return out

    # -- 重み ---------------------------------------------------------------

    def weight(self, state: CardState, day: int) -> float:
        """忘れかけているほど大きい重みを返す."""
        r = state.retrievability_on(day)
        w = max(1.0 - r, 0.0) ** self.config.urgency_exponent
        if state.lapses >= self.config.leech_threshold:
            w *= self.config.leech_weight
        return w

    def _quantized(self, weights: list[float]) -> list[int]:
        """浮動小数の誤差で抽選結果がぶれないよう整数化する."""
        return [max(1, int(round(w * WEIGHT_SCALE))) for w in weights]

    # -- 候補の絞り込み ------------------------------------------------------

    def _interferes(self, word_id: int, window_size: int) -> bool:
        """直近 window_size 件に出た語と紛らわしいか."""
        if window_size <= 0:
            return False
        cand = self.words[word_id]
        window = self.recent[-window_size:]
        for prev_id in window:
            prev = self.words.get(prev_id)
            if prev is None:
                continue
            if prev.reading == cand.reading:
                return True
            if _edit_distance(prev.word, cand.word) <= self.config.interference_distance:
                return True
        return False

    def _candidates(self, states: dict[int, CardState], day: int) -> list[int]:
        """出題対象になりうる語。段階的に条件を緩める.

        候補は必ず word_id 順に並べる。抽選は候補の並び順に依存するため、
        辞書の反復順に任せると Swift 版（Dictionary の順序が不定）と
        結果がずれてしまう。
        """
        due = sorted(wid for wid, s in states.items()
                     if not s.is_new and s.due_day <= day)
        if not due:
            # 期限前でも、最も忘れかけているものから出す
            due = sorted(wid for wid, s in states.items() if not s.is_new)
        if not due:
            return []

        cooldown = set(self.recent[-self.config.cooldown_window:])

        # 候補が尽きたら段階的に緩める。干渉判定は一気に捨てず
        # ウィンドウを狭めていき、「直前の語と紛らわしい」だけは最後まで守る。
        # 出題プールが小さいときに紛らわしい語が隣り合うのを防ぐため。
        for window in (self.config.interference_window, 2, 1, 0):
            pool = [w for w in due
                    if w not in cooldown and not self._interferes(w, window)]
            if pool:
                return pool

        # クールダウンも捨てる（プールが極端に小さい場合）
        for window in (1, 0):
            pool = [w for w in due if not self._interferes(w, window)]
            if pool:
                return pool
        return due

    # -- 出題 ---------------------------------------------------------------

    def _pop_new(self, states: dict[int, CardState]) -> int | None:
        """未学習の語をキューから1つ取り出す.

        キューはアプリ側で永続化されないので、再起動後は学習済みの語も
        先頭に残っている。それらは読み飛ばす。
        """
        while self.new_queue:
            word_id = self.new_queue.pop(0)
            state = states.get(word_id)
            if state is not None and not state.is_new:
                continue
            return word_id
        return None

    def next_word(self, states: dict[int, CardState], day: int,
                  introduced_today: int) -> int | None:
        """次に出題する語の id を返す。出せるものが無ければ None."""
        due_count = sum(1 for s in states.values()
                        if not s.is_new and s.due_day <= day)

        # 復習待ちが少なければ新規語を投入する
        if (due_count < self.config.due_target
                and introduced_today < self.config.new_per_day):
            word_id = self._pop_new(states)
            if word_id is not None:
                self._remember(word_id)
                return word_id

        candidates = self._candidates(states, day)
        if not candidates:
            if introduced_today < self.config.new_per_day:
                word_id = self._pop_new(states)
                if word_id is not None:
                    self._remember(word_id)
                    return word_id
            return None

        weights = self._quantized(
            [self.weight(states[wid], day) for wid in candidates])
        total = sum(weights)
        r = self.rng.below(total)
        acc = 0
        for wid, w in zip(candidates, weights):
            acc += w
            if r < acc:
                self._remember(wid)
                return wid
        # 到達しないはずだが安全のため
        self._remember(candidates[-1])
        return candidates[-1]

    def _remember(self, word_id: int) -> None:
        self.recent.append(word_id)
        keep = max(self.config.cooldown_window, self.config.interference_window)
        if len(self.recent) > keep * 2:
            self.recent = self.recent[-keep:]

    def is_leech(self, state: CardState) -> bool:
        return state.lapses >= self.config.leech_threshold
