import { bashReferencesSensitiveFile } from './sensitive-files.js';
import { literalCommandArgv, prefixCommandArgv } from './command-prefix.js';

export type BashCommandClass = 'workspace-internal' | 'needs-approval';

/** Recognize bounded literal reads, never arbitrary programs sharing an executable name. */
export function isReadOnlyBashCommand(command: string | undefined): boolean {
  if (bashReferencesSensitiveFile(command)) return false;
  const argv = prefixCommandArgv(command);
  if (!argv) return false;
  const [binary, ...args] = argv;
  if (args.some((arg) => arg.includes('../') || arg === '..')) return false;
  if (
    binary === 'date' &&
    (args.length === 0 ||
      (args.length === 1 && ['-u', '--utc', '--universal'].includes(args[0]!)))
  )
    return true;
  if (
    [
      'pwd',
      'ls',
      'cat',
      'head',
      'tail',
      'wc',
      'stat',
      'tree',
      'du',
      'which',
      'true',
      'false',
    ].includes(binary!)
  )
    return !args.some((arg) => arg === '--files0-from' || arg.startsWith('--files0-from='));
  if (binary === 'agent-browser') return args.length === 1 && args[0] === '--version';
  if (binary === 'rg')
    return !args.some((arg) =>
      /^(?:--pre(?:=|$)|--hostname-bin(?:=|$)|--search-zip$|--no-ignore$|--hidden$)/.test(arg),
    );
  if (binary === 'grep') return !args.includes('--dereference-recursive');
  if (binary === 'sed')
    return (
      args.length === 3 && args[0] === '-n' && /^\d+(?:,\d+)?p(?:;\d+(?:,\d+)?p)*$/.test(args[1]!)
    );
  if (binary === 'find')
    return !args.some((arg) =>
      /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(arg),
    );
  if (binary === 'git')
    return (
      ['status', 'diff', 'log', 'show', 'ls-files'].includes(args[0] ?? '') &&
      !args.some((arg) => /^(?:--output(?:=|$)|--ext-diff$|--textconv$)/.test(arg))
    );
  return false;
}

/** Unknown shell syntax is not proof of danger. The preflight asks for a concrete action. */
export function classifyBashCommand(command: string | undefined): BashCommandClass {
  if (isReadOnlyBashCommand(command)) return 'workspace-internal';
  if (bashReferencesSensitiveFile(command)) return 'needs-approval';
  const argv = literalCommandArgv(command);
  if (!argv || argv.some((arg) => arg === '..' || arg.includes('../') || arg.startsWith('/')))
    return 'needs-approval';
  const [binary, ...args] = argv;
  if (['npm', 'pnpm', 'yarn'].includes(binary!)) {
    const script = args[0] === 'run' ? args[1] : args[0];
    if (['test', 'build', 'lint', 'typecheck', 'format:check'].includes(script ?? ''))
      return 'workspace-internal';
  }
  if (['vitest', 'jest', 'eslint', 'tsc', 'pytest'].includes(binary!)) return 'workspace-internal';
  if (binary === 'make' && args.every((arg) => ['test', 'build', 'lint', 'check'].includes(arg)))
    return 'workspace-internal';
  if (binary === 'mkdir' && args.every((arg) => arg !== '-m' && !arg.startsWith('--mode')))
    return 'workspace-internal';
  return 'needs-approval';
}
