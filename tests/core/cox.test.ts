import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coxSurvival, coxLinearPredictor, coxPredict, type CoxPayload } from '../../src/core/cox.js';

// Model vyexportovaný z analytics/train.py včetně referenčních predikcí lifelines.
const model = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/cox-parity.json'), 'utf8')) as CoxPayload & {
  checks: { x: Record<string, string | number>; surv: Record<string, number> }[];
};

describe('Cox scoring parity with lifelines', () => {
  it('reproduces S(t|x) at 5/10/30/60 s', () => {
    expect(model.checks.length).toBeGreaterThan(0);
    for (const c of model.checks) {
      const lp = coxLinearPredictor(model, c.x);
      for (const [h, s] of Object.entries(c.surv)) expect(coxSurvival(model, lp, Number(h) * 1000)).toBeCloseTo(s, 3);
    }
  });
  it('produces a prediction object', () => {
    const p = coxPredict(model, model.checks[0].x, 10_000)!;
    expect(p.pOver[10]).toBeGreaterThanOrEqual(0);
    expect(p.pNeeded).toBeCloseTo(p.pOver[10], 10);
  });
});
