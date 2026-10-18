import { describe, expect, it } from 'vitest';
import { sessionEventSchema, taskBudgetSchema, taskToolInputSchema } from '../src/index.js';

describe('task contracts', () => {
  it('validates durable budget and request records through the session union', () => {
    const base = {
      eventId: crypto.randomUUID(),
      at: '2026-10-18T00:00:00.000Z',
      promptId: crypto.randomUUID(),
    };
    expect(sessionEventSchema.parse({ ...base, type: 'task/budget', limits: {} })).toMatchObject({
      limits: { maxCost: [], reserveRequests: 3, reserveTokens: 16384 },
    });
    expect(taskBudgetSchema.parse({}).maxRequests).toBeUndefined();
    const legacyLimits = {
      maxSteps: 64,
      maxRequests: 128,
      maxTokens: 2000000,
      maxDurationMs: 1800000,
    };
    expect(
      sessionEventSchema.parse({ ...base, type: 'task/budget', limits: legacyLimits }),
    ).toMatchObject({ limits: legacyLimits });
    expect(
      sessionEventSchema.parse({
        ...base,
        type: 'task/request',
        requestId: crypto.randomUUID(),
        model: 'fake/model',
        purpose: 'compaction',
        estimatedInputTokens: 100,
        reservedTokens: 200,
        reservedCost: [],
        lane: 'work',
      }).type,
    ).toBe('task/request');
    expect(taskBudgetSchema.safeParse({ maxRequests: 0 }).success).toBe(false);
  });
  it('rejects ambiguous check IDs and command checks without a command', () => {
    const check = { id: 'tests', requirement: 'Test result', kind: 'command' };
    expect(taskToolInputSchema.safeParse({ operation: 'plan', checks: [check] }).success).toBe(
      false,
    );
    expect(
      taskToolInputSchema.safeParse({
        operation: 'plan',
        checks: [
          { ...check, command: 'pnpm test' },
          { ...check, command: 'pnpm test' },
        ],
      }).success,
    ).toBe(false);
  });
});
