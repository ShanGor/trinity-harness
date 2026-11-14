import { workspacePathSchema, type AnswerCitation } from '@trinity-harness/shared';

export function workspaceLinkPath(
  href: string | undefined,
  citations?: AnswerCitation[],
): string | null {
  if (!href || href.startsWith('#')) return null;
  try {
    const decoded = decodeURIComponent(href);
    if (decoded.includes('\\') || decoded.split(/[/?#]/).includes('..')) return null;
    const absolute = /^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//');
    const url = new URL(href, window.location.origin + '/');
    if (
      absolute &&
      url.origin !== window.location.origin &&
      !['localhost', '127.0.0.1'].includes(url.hostname)
    )
      return null;
    const path = decodeURIComponent(url.pathname).replace(/^\//, '');
    if (!workspacePathSchema.safeParse(path).success || !path) return null;
    const known = citations?.some((c) => c.kind === 'workspace_reference' && c.path === path);
    return known ||
      /\.(?:md|markdown|html?|txt|json|csv|ya?ml|png|jpe?g|gif|webp|pdf|tsx?|jsx?|css|log|svg)$/i.test(
        path,
      )
      ? path
      : null;
  } catch {
    return null;
  }
}
export function openWorkspaceDocument(sessionId: string, path: string): void {
  window.dispatchEvent(new CustomEvent('trinity:workspace-open', { detail: { sessionId, path } }));
}
