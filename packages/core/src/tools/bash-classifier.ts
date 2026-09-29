/**
 * Bash command classification for the `workspace-write + ask` preset
 * (docs/design.md §12.1: workspace-internal writes are free, dangerous
 * commands ask). Purely lexical — no execution, no FS access — so it is
 * deterministic and unit-testable. Conservative by design: anything involving
 * redirections, pipes, command substitution, absolute paths or non-sandbox
 * tooling falls back to 'ask'.
 */

export type BashCommandClass = 'workspace-internal' | 'needs-approval';

/** Compound-command metacharacters that could smuggle a dangerous subcommand. */
const SHELL_METACHARS = /[>|`$(){}[\];]/;
/** Absolute paths or parent-relative traversal leave the workspace root. */
const PATH_TRAVERSAL = /(^|\s)(\/|\.\.(\/|$))/;
/** Well-known sandbox-bound binaries (the LocalSandbox execs `bash -c` on the host). */
const SAFE_BINARIES =
  /^\s*(ls|pwd|cat|head|tail|find|grep|rg|sed|awk|sort|uniq|wc|diff|stat|file|tree|du|df|which|echo|true|false|mkdir|touch|cp|mv|rm|chmod|ln|tar|zip|unzip|gzip|gunzip|make|git|npm|npx|pnpm|yarn|node|deno|bun|bunx|python3?|pip3?|pytest|cargo|rustc|go|javac|java|mvn|gradle|ruby|gcc|g\+\+|clang|cc|tsc|vitest|jest|eslint|prettier|drizzle-kit|tsx|ts-node|jq)\b/;

/**
 * Classify a single `bash -c` command string. `undefined`/empty ⇒ ask (the
 * model must say SOMETHING; fail-closed).
 */
export function classifyBashCommand(command: string | undefined): BashCommandClass {
  const cmd = (command ?? '').trim();
  if (cmd.length === 0) return 'needs-approval';
  if (SHELL_METACHARS.test(cmd)) return 'needs-approval';
  if (PATH_TRAVERSAL.test(cmd)) return 'needs-approval';
  if (!SAFE_BINARIES.test(cmd)) return 'needs-approval';
  return 'workspace-internal';
}
