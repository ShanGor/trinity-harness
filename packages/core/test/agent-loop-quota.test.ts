import { describe, expect, it } from 'vitest';

import type { TenantQuota, UsagePort, UsageRecord } from '@trinity-harness/contracts';
import { CoreAgentLoop, CoreToolRegistry, MemorySessionStore } from '@trinity-harness/core';
import { FakeLLM, FakeSandbox, textChunks } from '@trinity-harness/core/testing';

/**
 * M5 quota gate + usage metering (docs/design.md §17). The loop must record
 * per-request token usage and deny model calls once a tenant window limit is
 * reached — fail-closed, before any tokens are spent.
 */

class FakeUsage implements UsagePort {
  records: UsageRecord[] = [];
  quota: TenantQuota = {};
  /** Forced usage sums per call (used > limit triggers denial). */
  usage = 0;
  failQuotaRead = false;
  failRecord = false;
  quotaReads = 0;

  async record(entry: UsageRecord): Promise<void> {
    if (this.failRecord) throw new Error('usage store down');
    this.records.push(entry);
  }

  async usageSince(): Promise<number> {
    return this.usage;
  }

  async quotaOf(): Promise<TenantQuota> {
    this.quotaReads += 1;
    if (this.failQuotaRead) throw new Error('quota store down');
    return this.quota;
  }
}

function makeLoop(store: MemorySessionStore, llm: FakeLLM, usage: UsagePort) {
  return new CoreAgentLoop({
    llm,
    model: 'fake/model',
    tools: new CoreToolRegistry(new FakeSandbox()),
    store,
    workspaceRoot: '/ws',
    usage,
  });
}

const runOpts = { tenantId: 't1', actor: 'u1' };

describe('M5: quota gate + usage metering', () => {
  it('records summed usage chunks per model request, tenant-attributed', async () => {
    const store = new MemorySessionStore();
    const usage = new FakeUsage();
    // A request may carry several usage chunks (provider mid-stream updates);
    // the loop accumulates them into ONE record per model request.
    const llm = new FakeLLM(() => [
      { kind: 'usage', inputTokens: 10, outputTokens: 5 },
      { kind: 'usage', inputTokens: 3, outputTokens: 7 },
      { kind: 'text-delta', text: 'hi' },
      { kind: 'finish', reason: 'stop' },
    ]);
    const loop = makeLoop(store, llm, usage);

    const outcome = await loop.run('s1', 'hello', { emit: () => {} }, runOpts);
    expect(outcome).toMatchObject({ reason: 'completed', steps: 1 });
    expect(usage.records).toEqual([
      { tenantId: 't1', sessionId: 's1', model: 'fake/model', inputTokens: 13, outputTokens: 12 },
    ]);
    llm.assertExhausted();
  });

  it('denies the model call when a quota window is exceeded (before spending tokens)', async () => {
    const store = new MemorySessionStore();
    const usage = new FakeUsage();
    usage.quota = { dailyTokens: 100 };
    usage.usage = 150; // over the day limit
    const llm = new FakeLLM(() => textChunks('never'));
    const loop = makeLoop(store, llm, usage);

    const events: string[] = [];
    const outcome = await loop.run('s1', 'hello', { emit: (e) => events.push(e.type) }, runOpts);
    expect(outcome.reason).toBe('error');
    // Friendly, admin-actionable message (design.md §17 超限返回友好错误).
    const turnEnd = await store.load('s1').then((l) => l.at(-1));
    expect(turnEnd?.type).toBe('turn/end');
    expect(turnEnd?.type === 'turn/end' && turnEnd.detail).toMatch(/quota exceeded/);
    expect(turnEnd?.type === 'turn/end' && turnEnd.detail).toMatch(/day/);
    // No model request was made and nothing was recorded.
    expect(llm.requests).toHaveLength(0);
    expect(usage.records).toHaveLength(0);
    expect(events).toContain('turn/end');
  });

  it('allows the call when usage is under every configured window', async () => {
    const store = new MemorySessionStore();
    const usage = new FakeUsage();
    usage.quota = { hourlyTokens: 1_000, dailyTokens: 10_000, monthlyTokens: 100_000 };
    usage.usage = 999;
    const llm = new FakeLLM(() => textChunks('ok'));
    const loop = makeLoop(store, llm, usage);

    const outcome = await loop.run('s1', 'hello', { emit: () => {} }, runOpts);
    expect(outcome.reason).toBe('completed');
    expect(llm.requests).toHaveLength(1);
  });

  it('fail-closed: a quota store failure denies the model call', async () => {
    const store = new MemorySessionStore();
    const usage = new FakeUsage();
    usage.failQuotaRead = true;
    const llm = new FakeLLM(() => textChunks('never'));
    const loop = makeLoop(store, llm, usage);

    const outcome = await loop.run('s1', 'hello', { emit: () => {} }, runOpts);
    expect(outcome.reason).toBe('error');
    expect(llm.requests).toHaveLength(0);
  });

  it('unlimited when no tenantId is provided (M1 in-memory mode)', async () => {
    const store = new MemorySessionStore();
    const usage = new FakeUsage();
    usage.quota = { dailyTokens: 1 };
    usage.usage = 10_000;
    const llm = new FakeLLM(() => textChunks('ok'));
    const loop = makeLoop(store, llm, usage);

    const outcome = await loop.run('s1', 'hello', { emit: () => {} }, { actor: 'u1' });
    expect(outcome.reason).toBe('completed');
    expect(usage.quotaReads).toBe(0);
  });

  it('record failure never breaks the turn (best-effort metering)', async () => {
    const store = new MemorySessionStore();
    const usage = new FakeUsage();
    usage.failRecord = true;
    const llm = new FakeLLM(() => [
      { kind: 'usage', inputTokens: 1, outputTokens: 1 },
      { kind: 'text-delta', text: 'ok' },
      { kind: 'finish', reason: 'stop' },
    ]);
    const loop = makeLoop(store, llm, usage);

    const outcome = await loop.run('s1', 'hello', { emit: () => {} }, runOpts);
    expect(outcome.reason).toBe('completed');
  });
});
