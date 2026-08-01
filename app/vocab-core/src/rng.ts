// 決定的乱数 (SplitMix64)
//
// 言語標準の乱数は実装が違って再現しないため、自前で持つ。
// pipeline/scheduler.py の Rng と同一の系列を返すことが要件。
//
// JavaScript の number は 64bit 整数演算ができないので BigInt を使う。

const MASK64 = (1n << 64n) - 1n;

export class Rng {
  private state: bigint;

  constructor(seed: bigint | number) {
    this.state = BigInt(seed) & MASK64;
  }

  nextU64(): bigint {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & MASK64;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return (z ^ (z >> 31n)) & MASK64;
  }

  /** 0 以上 n 未満の一様乱数。剰余バイアスを除去してある。 */
  below(n: number): number {
    if (n <= 1) return 0;
    const bound = BigInt(n);
    // 2^64 mod n。これ未満の値を捨てると分布が厳密に一様になる。
    const threshold = ((1n << 64n) - bound) % bound;
    for (;;) {
      const r = this.nextU64();
      if (r >= threshold) return Number(r % bound);
    }
  }

  /** Fisher-Yates。Python / Swift 側と同一の並びになること。 */
  shuffled<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.below(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

/**
 * Python の round() と同じ「偶数丸め」。
 *
 * JavaScript の Math.round() は 0.5 を切り上げる（Math.round(0.5) === 1）が、
 * Python は偶数側へ丸める（round(0.5) === 0）。
 * この差は抽選の重みや間隔の計算結果を変えてしまうので合わせる必要がある。
 */
export function roundHalfToEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}
