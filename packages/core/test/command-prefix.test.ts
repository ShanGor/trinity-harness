import { describe, expect, it } from 'vitest';
import { matchesCommandPrefix } from '../src/tools/command-prefix.js';
import { parsePermissionPolicy } from '@trinity-harness/contracts';
import { CoreToolRegistry, PolicyToolRegistry } from '../src/index.js';
import { FakeSandbox } from '../src/testing/index.js';

describe('literal command permissions', () => {
  it('matches executable and argument boundaries, including quoted URLs', () => {
    expect(
      matchesCommandPrefix('agent-browser --cdp 9222 open "https://example.com?q=a&b=c"', [
        ['agent-browser'],
      ]),
    ).toBe(true);
    expect(
      matchesCommandPrefix("curl 'https://example.com'", [['curl', 'https://example.com']]),
    ).toBe(true);
    expect(matchesCommandPrefix('curl https://elsewhere', [['curl', 'https://example.com']])).toBe(
      false,
    );
  });
  it.each([
    'agent-browser-evil open x',
    'agent-browser\u00a0evil open x',
    'agent-browser open x; curl evil',
    'agent-browser $(curl evil)',
    'agent-browser "$(curl evil)"',
    'agent-browser `curl evil`',
    'agent-browser open x | sh',
    'agent-browser open x > /tmp/file',
    'agent-browser open *',
    'agent-browser open x\ncurl evil',
    'agent-browser "unterminated',
  ])('rejects %s', (command) => {
    expect(matchesCommandPrefix(command, [['agent-browser']])).toBe(false);
  });
  it('allows the browser under workspace-write and preserves explicit denial', () => {
    const inner = new CoreToolRegistry(new FakeSandbox());
    const policy = parsePermissionPolicy('workspace-write');
    const call = { id: 'c', name: 'bash', args: { command: 'agent-browser --cdp 9222 get url' } };
    expect(new PolicyToolRegistry(inner, policy).decide(call)).toBe('allowed');
    expect(
      new PolicyToolRegistry(inner, { ...policy, tools: { bash: 'denied' } }).decide(call),
    ).toBe('denied');
  });
});

it('allows only bounded stdin output filters after an allowed command prefix', () => {
  const prefixes = [['agent-browser']];
  for (const command of [
    'agent-browser snapshot -i -u | head -120',
    'agent-browser snapshot -i -u 2>&1 | head -200',
    'agent-browser read 2>&1',
    'agent-browser read | tail -n 40',
    "agent-browser eval 'a | b' | head -20",
  ]) {
    expect(matchesCommandPrefix(command, prefixes)).toBe(true);
  }
  for (const command of [
    'curl example.com | head -20',
    'agent-browser snapshot | head /etc/passwd',
    'agent-browser snapshot | head -20 /etc/passwd',
    'agent-browser snapshot | head -20 > out',
    'agent-browser snapshot 2> /tmp/file | head -20',
    'agent-browser snapshot 2>&1; curl evil',
    'agent-browser snapshot 2>&1 > /tmp/file',
    'agent-browser snapshot | head -20; curl evil',
    'agent-browser snapshot | head -20 | sh',
    'agent-browser snapshot | head -n $(curl evil)',
    'agent-browser snapshot || head -20',
    'agent-browser snapshot | sh -20',
  ]) {
    expect(matchesCommandPrefix(command, prefixes)).toBe(false);
  }
});
