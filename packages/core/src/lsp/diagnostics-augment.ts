import type { LSPPort, SessionStore } from '@trinity-harness/contracts';

/**
 * System-prompt augmentation factory (docs/design.md §9 "diagnostics 作为自动
 * 上下文注入"): scans the recent tool calls of the session log for file
 * paths, pulls language-server diagnostics (cached by the service), and
 * injects a compact section into the system prompt before each model call.
 * Failures degrade to no augmentation — context hints must never break a turn.
 */
export function makeDiagnosticsAugment(
  lsp: LSPPort,
  store: () => SessionStore,
  opts?: { maxFiles?: number | undefined; maxDiagnosticsPerFile?: number | undefined },
): (sessionId: string) => Promise<string | undefined> {
  const maxFiles = opts?.maxFiles ?? 5;
  const maxPerFile = opts?.maxDiagnosticsPerFile ?? 10;
  return async (sessionId) => {
    try {
      const events = await store().load(sessionId);
      const files = new Set<string>();
      for (const event of events.slice(-60)) {
        if (event.type !== 'tool/call') continue;
        const args = event.args as { path?: unknown; file?: unknown };
        for (const candidate of [args.path, args.file]) {
          if (typeof candidate === 'string' && candidate.includes('.')) files.add(candidate);
        }
        if (files.size >= maxFiles) break;
      }
      if (files.size === 0) return undefined;
      const sections: string[] = [];
      for (const file of files) {
        const diagnostics = await lsp.diagnostics(file);
        if (diagnostics.length === 0) continue;
        const lines = diagnostics
          .slice(0, maxPerFile)
          .map((d) => `- [${d.severity}] ${file}:${d.range.start.line + 1} ${d.message}`)
          .join('\n');
        sections.push(`Diagnostics for ${file}:\n${lines}`);
      }
      return sections.length > 0
        ? `[language-server diagnostics — verify before editing]\n${sections.join('\n')}`
        : undefined;
    } catch {
      return undefined;
    }
  };
}
