import { describe, expect, it } from 'vitest';

import { classifyBashCommand } from '../src/index.js';

describe('classifyBashCommand', () => {
  it('allows plain sandbox-binary commands', () => {
    expect(classifyBashCommand('ls -la')).toBe('workspace-internal');
    expect(classifyBashCommand('npm test')).toBe('workspace-internal');
    expect(classifyBashCommand('git status')).toBe('workspace-internal');
    expect(classifyBashCommand('make build')).toBe('workspace-internal');
  });

  it('asks for shell metacharacters (pipes, redirects, substitution)', () => {
    expect(classifyBashCommand('cat x | grep y')).toBe('needs-approval');
    expect(classifyBashCommand('echo hi > /tmp/x')).toBe('needs-approval');
    expect(classifyBashCommand('echo $(whoami)')).toBe('needs-approval');
    expect(classifyBashCommand('ls; rm -rf /')).toBe('needs-approval');
  });

  it('asks for absolute or traversing paths', () => {
    expect(classifyBashCommand('ls /etc')).toBe('needs-approval');
    expect(classifyBashCommand('cat ../secret')).toBe('needs-approval');
  });

  it('asks for unknown or empty commands', () => {
    expect(classifyBashCommand('')).toBe('needs-approval');
    expect(classifyBashCommand(undefined)).toBe('needs-approval');
    expect(classifyBashCommand('unknown-binary --x')).toBe('needs-approval');
  });
});
