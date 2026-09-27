import { z } from 'zod';

import { defineTool } from './define-tool.js';

export const readFileTool = defineTool({
  name: 'read_file',
  description:
    'Read a UTF-8 text file from the workspace. Returns truncated content (maxBytes) with a truncated flag.',
  parameters: z.object({
    path: z.string().min(1).describe('Workspace-relative file path'),
    maxBytes: z.number().int().positive().optional().describe('Max bytes to return'),
  }),
  execute: async (args, ctx) => {
    const result = await ctx.sandbox.readFile(args.path, { maxBytes: args.maxBytes });
    return { value: { path: args.path, ...result }, isError: false };
  },
});

export const writeFileTool = defineTool({
  name: 'write_file',
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
  description:
    'Run a shell command via `bash -c` inside the workspace. Commands run with a timeout; exit code 124 means killed by timeout.',
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
