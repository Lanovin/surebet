import { describe, expect, it } from 'vitest';
import { arbMargin, computeStakes, computeStakesFixed, effectiveOdds, impliedSum } from '../../src/core/arb.js';

describe('arb math', () => {
  it('computes margin', () => {
    expect(impliedSum([2.1, 2.1])).toBeCloseTo(0.95238, 4);
    expect(arbMargin([2.1, 2.1])).toBeCloseTo(0.05, 6);
    expect(arbMargin([1.9, 1.9])).toBeLessThan(0);
    expect(arbMargin([3.2, 3.6, 3.4])).toBeCloseTo(1 / (1 / 3.2 + 1 / 3.6 + 1 / 3.4) - 1, 10);
  });

  it('rounds stakes to whole CZK keeping profit positive in every outcome', () => {
    const odds = [2.05, 1.99];
    const plan = computeStakes(odds, 10_000)!;
    expect(plan.positive).toBe(true);
    expect(plan.stakes.every((s) => Number.isInteger(s))).toBe(true);
    expect(plan.total).toBeLessThanOrEqual(10_000 * 1.05);
    for (let i = 0; i < odds.length; i++) expect(plan.stakes[i] * odds[i] - plan.total).toBeGreaterThan(0);
  });

  it('handles 3-way markets and tiny margins with small bankroll', () => {
    const odds = [3.3, 3.55, 3.2]; // ~0.4 % arb
    expect(arbMargin(odds)).toBeGreaterThan(0);
    const plan = computeStakes(odds, 300)!;
    expect(plan.positive).toBe(true);
    for (let i = 0; i < 3; i++) expect(plan.payouts[i]).toBeGreaterThan(plan.total);
  });

  it('respects rounding unit', () => {
    const plan = computeStakes([2.2, 2.0], 5000, 10)!;
    expect(plan.stakes.every((s) => s % 10 === 0)).toBe(true);
    expect(plan.positive).toBe(true);
  });

  it('returns non-positive plan when there is no arb', () => {
    const plan = computeStakes([1.8, 1.9], 1000)!;
    expect(plan.positive).toBe(false);
  });

  it('recomputes other legs for a fixed stake', () => {
    const plan = computeStakesFixed([2.1, 2.05], 0, 1234)!;
    expect(plan.stakes[0]).toBe(1234);
    expect(plan.positive).toBe(true);
  });

  it('applies bookmaker fee', () => {
    expect(effectiveOdds(2, 5)).toBeCloseTo(1.9);
    expect(effectiveOdds(2, 0)).toBe(2);
  });
});
