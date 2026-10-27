import { expect, it, vi } from 'vitest';
import { ZendriverOperationGate, type ZendriverToolResult } from '../src/tools/zendriver-mcp.js';

it('fences later agent calls without interrupting an already dispatched browser call', async () => {
  let resolve!: (value: ZendriverToolResult) => void;
  const pending = new Promise<ZendriverToolResult>((done) => {
    resolve = done;
  });
  const call = vi.fn(() => pending);
  const gate = new ZendriverOperationGate({ call });
  const first = gate.call('browser_click', { x: 1 });
  gate.fence();
  expect(() => gate.call('browser_capture', {})).toThrow('taking browser control');
  expect(call).toHaveBeenCalledTimes(1);
  resolve({ content: [], structuredContent: { ok: true } });
  await expect(first).resolves.toEqual({ content: [], structuredContent: { ok: true } });
  expect(() => gate.call('browser_goto', {})).toThrow('taking browser control');
  expect(call).toHaveBeenCalledTimes(1);
});

it('passes cancellation and arguments through while unfenced', async () => {
  const call = vi.fn(async (): Promise<ZendriverToolResult> => ({
    content: [],
    structuredContent: {},
  }));
  const gate = new ZendriverOperationGate({ call });
  const signal = new AbortController().signal;
  await gate.call('browser_capture', { full: true }, signal, true);
  expect(call).toHaveBeenCalledWith('browser_capture', { full: true }, signal, true);
  const aborted = AbortSignal.abort();
  expect(() => gate.call('browser_capture', {}, aborted)).toThrow();
  expect(call).toHaveBeenCalledTimes(1);
});
