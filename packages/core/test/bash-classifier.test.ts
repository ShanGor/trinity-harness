import { describe, expect, it } from 'vitest';

import {
  bashReferencesSensitiveFile,
  classifyBashCommand,
  isSensitiveFilePath,
} from '../src/index.js';

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

  it('asks before Bash commands that reference sensitive files', () => {
    expect(classifyBashCommand('cat .env')).toBe('needs-approval');
    expect(classifyBashCommand('node -e "readFileSync(\'.env.local\')"')).toBe('needs-approval');
    expect(classifyBashCommand('cat *.env')).toBe('needs-approval');
    expect(classifyBashCommand('cat .env.example')).toBe('workspace-internal');
    expect(classifyBashCommand('cat *.env.example')).toBe('workspace-internal');
    expect(bashReferencesSensitiveFile('cat config/credentials.json')).toBe(true);
    expect(bashReferencesSensitiveFile('cat .env.example')).toBe(false);
  });

  it('matches the maintained sensitive file path patterns', () => {
    expect(isSensitiveFilePath('.env')).toBe(true);
    expect(isSensitiveFilePath('/workspace/project/.env.production')).toBe(true);
    expect(isSensitiveFilePath('keys/id_ed25519')).toBe(true);
    expect(isSensitiveFilePath('config/credentials.json')).toBe(true);
    expect(isSensitiveFilePath('config/.env.example')).toBe(false);
    expect(isSensitiveFilePath('src/app.ts')).toBe(false);
  });

  it('asks for unknown or empty commands', () => {
    expect(classifyBashCommand('')).toBe('needs-approval');
    expect(classifyBashCommand(undefined)).toBe('needs-approval');
    expect(classifyBashCommand('unknown-binary --x')).toBe('needs-approval');
  });
});
