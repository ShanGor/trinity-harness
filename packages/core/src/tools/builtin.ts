import { readFileOptionsSchema } from '@trinity-harness/contracts';
import { z } from 'zod';
import { isAbsolute, relative } from 'node:path';
import { prefixCommandArgv, literalCommandArgv, matchesCommandPrefix } from './command-prefix.js';

import { defineTool } from './define-tool.js';
import { classifyBashCommand, isReadOnlyBashCommand } from './bash-classifier.js';
import { bashReferencesSensitiveFile } from './sensitive-files.js';
import { assessFileChange, assessTargetedEdit } from './file-assessment.js';

export const readFileTool = defineTool({
  name: 'read_file',
  effect: { kind: 'read', scope: 'workspace', evidence: 'observation' },
  description:
    'Inspect workspace UTF-8 text with bounded streaming reads. Prefer this over Bash for file inspection. Defaults: 64 KiB and 2000 lines; maxBytes may be raised to 1 MiB. offset selects a 1-based starting line. Continue by passing the returned continuation as cursor (omit offset); this seeks directly, supports long lines and rejects changed files. startsMidLine/endsMidLine mark partial lines. totalLines is available only at EOF. Sensitive paths may require approval.',
  parameters: readFileOptionsSchema
    .safeExtend({
      path: z.string().min(1).describe('Workspace-relative file path'),
    })
    .refine((value) => value.cursor === undefined || value.offset === undefined, {
      message: 'Use cursor or offset, not both',
    }),
  execute: async (args, ctx) => {
    const result = await ctx.sandbox.readFile(args.path, {
      maxBytes: args.maxBytes,
      offset: args.offset,
      cursor: args.cursor,
      signal: ctx.signal,
      limit: args.limit,
    });
    return { value: { path: args.path, ...result }, isError: false };
  },
});

export const writeFileTool = defineTool({
  name: 'write_file',
  assess: (args, ctx) => assessFileChange(args.path, ctx, false),
  effect: { kind: 'mutation', scope: 'workspace', evidence: 'none' },
  description:
    'Write (create or overwrite) a UTF-8 text file in the workspace. Parent directories are created automatically.',
  parameters: z.object({
    path: z.string().min(1).describe('Workspace-relative file path'),
    content: z.string().describe('Full new file content'),
  }),
  execute: async (args, ctx) => {
    await ctx.sandbox.writeFile(args.path, args.content);
    return { value: { path: args.path, bytes: args.content.length }, isError: false };
  },
});

export const editFileTool = defineTool({
  name: 'edit_file',
  assess: (args, ctx) => assessTargetedEdit(args, ctx),
  effect: { kind: 'mutation', scope: 'workspace', evidence: 'none' },
  description:
    'Precise string replacement in a workspace file. old_text must match EXACTLY ONE occurrence — read the file first. Fails if found zero or multiple times.',
  parameters: z.object({
    path: z.string().min(1),
    old_text: z.string().min(1).describe('Exact existing text to replace'),
    new_text: z.string().describe('Replacement text'),
  }),
  execute: async (args, ctx) => {
    const result = await ctx.sandbox.editFile(args.path, args.old_text, args.new_text);
    return { value: { path: args.path, replacements: result.replacements }, isError: false };
  },
});

export const globTool = defineTool({
  name: 'glob',
  effect: { kind: 'read', scope: 'workspace', evidence: 'observation' },
  description: 'Find files in the workspace matching a glob pattern (e.g. "src/**/*.ts").',
  parameters: z.object({
    pattern: z.string().min(1).describe('Glob pattern, relative to the workspace root'),
  }),
  execute: async (args, ctx) => {
    const matches = await ctx.sandbox.glob(args.pattern);
    return { value: { matches }, isError: false };
  },
});

export const bashTool = defineTool({
  name: 'bash',
  effectFor: (args) =>
    isReadOnlyBashCommand(args.command)
      ? { kind: 'read', scope: 'workspace', evidence: 'observation' }
      : { kind: 'unknown', scope: 'workspace', evidence: 'none' },
  assess: async (args, ctx) => {
    const argv = prefixCommandArgv(args.command);
    if (
      isReadOnlyBashCommand(args.command) &&
      argv?.some((arg) => {
        if (!isAbsolute(arg)) return false;
        const scoped = relative(ctx.workspaceRoot, arg);
        return scoped === '..' || scoped.startsWith('../') || isAbsolute(scoped);
      })
    )
      return {
        decision: 'unavailable',
        summary:
          'This read leaves the authorized workspace. Use the supplied attachment URI or its recorded workspace-relative path; do not search runtime caches or host directories.',
      };
    if (
      classifyBashCommand(args.command) === 'workspace-internal' ||
      matchesCommandPrefix(args.command, ctx.permissionPolicy?.commandPrefixes ?? []) ||
      ctx.permissionPolicy?.tools['bash'] === 'allowed' ||
      ctx.permissionPolicy?.tools['*'] === 'allowed'
    )
      return { decision: 'allowed', summary: '' };
    const literal = literalCommandArgv(args.command);
    const binary = literal?.[0];
    if (binary && ctx.userRequest?.trim() === args.command.trim())
      return { decision: 'allowed', authorized: true, summary: '' };
    if (
      bashReferencesSensitiveFile(args.command) ||
      [
        'rm',
        'mv',
        'cp',
        'truncate',
        'chmod',
        'chown',
        'curl',
        'wget',
        'ssh',
        'scp',
        'sudo',
        'pkexec',
      ].includes(binary ?? '')
    )
      return {
        decision: 'ask',
        summary: JSON.stringify({
          summary:
            binary === 'rm'
              ? `Delete these paths: ${literal!
                  .slice(1)
                  .filter((arg) => !arg.startsWith('-'))
                  .join(', ')
                  .slice(0, 300)}.`
              : binary === 'mv' || binary === 'cp'
                ? `${binary === 'mv' ? 'Move' : 'Copy'} paths; an existing destination may be replaced.`
                : 'This command may overwrite content, disclose data, or change system access. Review its target and consequence.',
          command: args.command.slice(0, 1500),
        }),
      };
    return {
      decision: 'unavailable',
      summary:
        'The shell action has not been established. Use literal bounded read commands or file tools; split compound reads into independent calls. Inspect unknown programs before requesting approval for a concrete consequence.',
    };
  },
  description:
    'Run a shell command via `bash -c` inside the workspace. Use read_file to inspect workspace text files; sensitive-file access through Bash is approval-gated too. Reserve Bash for executing commands, tests, builds, and other shell tasks. Commands run with a timeout; exit code 124 means killed by timeout.',
  parameters: z.object({
    command: z.string().min(1),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(600_000)
      .optional()
      .describe('Optional timeout override (default 60s, max 600s)'),
  }),
  timeoutMs: 600_000,
  execute: async (args, ctx) => {
    const result = await ctx.sandbox.exec(args.command, {
      timeoutMs: args.timeout_ms,
      signal: ctx.signal,
    });
    return { value: result, isError: result.exitCode !== 0 };
  },
});
