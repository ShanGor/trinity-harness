import { describe, expect, it } from 'vitest';

import {
  bashReferencesSensitiveFile,
  classifyBashCommand,
  isSensitiveFilePath,
} from '../src/index.js';

describe('classifyBashCommand', () => {
  it('allows plain sandbox-binary commands', () => {
    expect(classifyBashCommand('ls -la')).toBe('workspace-internal');
    expect(classifyBashCommand('date')).toBe('workspace-internal');
    expect(classifyBashCommand('date -u')).toBe('workspace-internal');
    expect(classifyBashCommand('date --utc')).toBe('workspace-internal');
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

  it('recognizes literal absolute reads but rejects traversal', () => {
    expect(classifyBashCommand('ls /etc')).toBe('workspace-internal');
    expect(classifyBashCommand('cat ../secret')).toBe('needs-approval');
  });

  it('asks before Bash commands that reference sensitive files', () => {
    expect(classifyBashCommand('cat .env')).toBe('needs-approval');
    expect(classifyBashCommand('node -e "readFileSync(\'.env.local\')"')).toBe('needs-approval');
    expect(classifyBashCommand('cat *.env')).toBe('needs-approval');
    expect(classifyBashCommand('cat .env.example')).toBe('workspace-internal');
    expect(classifyBashCommand('cat *.env.example')).toBe('needs-approval');
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

it.each([
  'rm -rf output',
  'mv a b',
  'cp a b',
  'chmod 777 a',
  'node script.js',
  'python3 -c "print(1)"',
  'git reset --hard',
  'git clean -fd',
  'git push',
  "sed -i 's/a/b/' file",
  "sed -n '1e' file",
  'find . -delete',
  "find . -exec rm '{}' ';'",
  'rg --pre evil query',
  'date -s 12:00',
  'date --set=12:00',
  'date --file=clock.txt',
  'date +%Y-%m-%d',
])('keeps effectful or unsupported invocation gated %s', (command) => {
  expect(classifyBashCommand(command)).toBe('needs-approval');
});

it.each([
  "sed -n '833,1000p' uploads/book.txt",
  'grep -n insight uploads/book.txt',
  'cat uploads/book.txt | head -20',
  'rg insight uploads/book.txt | tail -n 40',
])('recognizes a bounded literal attachment read: %s', (command) => {
  expect(classifyBashCommand(command)).toBe('workspace-internal');
});
