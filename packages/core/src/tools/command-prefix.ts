/** Parse one literal shell command. Reject shell expansion and composition. */
export function literalCommandArgv(command: unknown): string[] | null {
  if (typeof command !== 'string' || command.length > 100_000) return null;
  const argv: string[] = [];
  let word = '';
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (/[$`\n\r\0]/.test(char)) return null;
    if (char === '\\') {
      const next = command[++i];
      if (next === undefined || /[\n\r\0]/.test(next)) return null;
      // In double quotes Bash preserves backslashes before ordinary letters.
      if (quote === '"' && !/[$`"\\]/.test(next)) word += '\\';
      word += next;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/[;&|<>()*?{}[\]~#]/.test(char)) return null;
    if (/\s/.test(char) && char !== ' ' && char !== '\t') return null;
    if (char === ' ' || char === '\t') {
      if (started) {
        argv.push(word);
        word = '';
        started = false;
      }
    } else {
      word += char;
      started = true;
    }
  }
  if (quote !== null) return null;
  if (started) argv.push(word);
  return argv.length ? argv : null;
}

/** Allow bounded stdin head/tail filters and stderr-to-stdout merging; no file redirects. */
export function prefixCommandArgv(command: unknown): string[] | null {
  const direct = literalCommandArgv(command);
  if (direct) return direct;
  if (typeof command !== 'string' || command.length > 100_000) return null;
  const filtered = command.match(
    /^(.*)\|\s*(?:head|tail)\s+(?:-[1-9]\d{0,3}|-n\s+[1-9]\d{0,3})\s*$/s,
  );
  const candidate = filtered?.[1] ?? command;
  const mergedStderr = candidate.match(/^(.*)\s+2>&1\s*$/s);
  return literalCommandArgv(mergedStderr?.[1] ?? candidate);
}

export function matchesCommandPrefix(
  command: unknown,
  prefixes: readonly (readonly string[])[],
): boolean {
  const argv = prefixCommandArgv(command);
  return (
    argv !== null &&
    prefixes.some((prefix) => prefix.length > 0 && prefix.every((word, i) => argv[i] === word))
  );
}
