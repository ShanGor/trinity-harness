import { posix } from 'node:path';
import type { ToolAssessment, ToolContext } from '@trinity-harness/contracts';

export function requestsWorkspaceChange(request: string | undefined): boolean {
  return Boolean(
    request &&
    /\b(implement|add|edit|update|change|fix|rewrite|replace|overwrite|modify|refactor|write)\b|实现|新增|添加|修改|更新|更改|修复|重写|替换|覆盖|编辑|實現|修復|改寫/i.test(
      request,
    ) &&
    !/\b(?:do not|don't|never|avoid)\s+(?:implement|add|edit|update|change|fix|rewrite|replace|overwrite|modify|refactor|write)\b|不要(?:修改|更新|更改|修复|重写|替换|覆盖|编辑)|只读|只讀/i.test(
      request,
    ),
  );
}

/** Only the committed request supplies authority; paths in tool output or plans cannot grant it. */
export function explicitlyRequestsFileChange(request: string | undefined, path: string): boolean {
  if (!request || !path || /[\n\r]/.test(path)) return false;
  // Conservative fallback for a named file: broad task interpretation remains model guidance,
  // never a filesystem permission grant. Do not infer authority from negated instructions.
  const index = request.indexOf(path);
  const before = index === 0 || /[\s`"'([{]/.test(request[index - 1] ?? '');
  const after =
    index + path.length === request.length ||
    /[\s`"')\]},.:;!?]/.test(request[index + path.length] ?? '');
  return (
    index >= 0 &&
    before &&
    after &&
    /(?:\b(?:edit|update|change|fix|rewrite|replace|overwrite|modify|refactor|write)\s+(?:(?:the|file)\s+)?[\x22'`]?|(?:修改|更新|更改|修复|重写|替换|覆盖|编辑|寫入|改寫|修復)\s*[\x22'`]?)$/i.test(
      request.slice(0, index),
    ) &&
    !/\b(no|not|never|don't|do not|without|except|avoid|only read)\b|不要|不得|禁止|不能|只读|只讀|勿|别|別/i.test(
      request,
    )
  );
}

export async function assessFileChange(
  path: string,
  ctx: ToolContext,
  mustExist: boolean,
): Promise<ToolAssessment> {
  if (ctx.permissionPolicy?.tools['*'] === 'allowed') return { decision: 'allowed', summary: '' };
  if (
    Array.from(path).some((char) => char.charCodeAt(0) < 32) ||
    /[*?{}()[\]\\!]/.test(path) ||
    posix.normalize(path) !== path ||
    path.startsWith('/') ||
    path.split('/').includes('..')
  )
    return {
      decision: 'unavailable',
      summary: 'Use a literal workspace-relative file path before preparing a change.',
    };
  const exists = mustExist || (await ctx.sandbox.glob(path)).includes(path);
  if (!exists || explicitlyRequestsFileChange(ctx.userRequest, path))
    return {
      decision: 'allowed',
      summary: `${exists ? 'Change existing' : 'Create new'} workspace file “${path}”.`,
    };
  return {
    decision: 'ask',
    summary: `Replace existing content in workspace file “${path}”. The current request does not explicitly authorize changing this named file. Existing content may be lost.`,
  };
}

/** A bounded replacement in a requested coding task is distinct from clobbering a file. */
export async function assessTargetedEdit(
  args: { path: string; old_text: string; new_text: string },
  ctx: ToolContext,
): Promise<ToolAssessment> {
  const assessment = await assessFileChange(args.path, ctx, true);
  if (assessment.decision !== 'ask' || !requestsWorkspaceChange(ctx.userRequest)) return assessment;
  const current = await ctx.sandbox.readFile(args.path, { maxBytes: 100_000 });
  if (
    current.truncated ||
    args.old_text === current.content ||
    current.content.replace(args.old_text, args.new_text).trim().length === 0
  )
    return assessment;
  return {
    decision: 'allowed',
    summary: `Apply a targeted edit in workspace file “${args.path}” for the requested change.`,
  };
}
