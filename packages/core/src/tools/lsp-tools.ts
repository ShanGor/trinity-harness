import type { LSPPort, ToolDefinition } from '@trinity-harness/contracts';
import { z } from 'zod';

import { defineTool } from './define-tool.js';

/**
 * `lsp_*` tools (docs/design.md §8/§9): LSP capabilities exposed to the
 * model. The service is injected at the composition root; each tool is a
 * thin zod-validated adapter (failures converge to isError results).
 */
export function createLspTools(lsp: LSPPort): ToolDefinition[] {
  return [
    defineTool({
      name: 'lsp_diagnostics',
      description:
        'Get language-server diagnostics (errors/warnings) for a workspace file. File must be one of: Python, TS/JS, JSON, YAML.',
      parameters: z.object({
        path: z.string().min(1).describe('Workspace-relative file path'),
      }),
      execute: async (args): Promise<{ value: unknown; isError: boolean }> => {
        const diagnostics = await lsp.diagnostics(args.path);
        return { value: { path: args.path, diagnostics }, isError: false };
      },
    }),
    defineTool({
      name: 'lsp_symbols',
      description:
        'Workspace-wide symbol search (classes, functions, variables) across all open language servers.',
      parameters: z.object({
        query: z.string().min(1).describe('Symbol name substring'),
      }),
      execute: async (args): Promise<{ value: unknown; isError: boolean }> => {
        const symbols = await lsp.symbols(args.query);
        return { value: { query: args.query, symbols }, isError: false };
      },
    }),
    defineTool({
      name: 'lsp_hover',
      description: 'Hover documentation (type/signature info) at a position in a workspace file.',
      parameters: z.object({
        path: z.string().min(1),
        line: z.number().int().nonnegative().describe('0-based line'),
        character: z.number().int().nonnegative().describe('0-based character offset'),
      }),
      execute: async (args): Promise<{ value: unknown; isError: boolean }> => {
        const hover = await lsp.hover(args.path, { line: args.line, character: args.character });
        if (hover === null) {
          return { value: { message: 'no hover information at that position' }, isError: true };
        }
        return { value: { path: args.path, hover }, isError: false };
      },
    }),
    defineTool({
      name: 'lsp_rename',
      description:
        'Rename the symbol at a position workspace-wide via the language server. Returns the list of edited files.',
      parameters: z.object({
        path: z.string().min(1),
        line: z.number().int().nonnegative(),
        character: z.number().int().nonnegative(),
        new_name: z.string().min(1),
      }),
      concurrency: 'exclusive',
      execute: async (args): Promise<{ value: unknown; isError: boolean }> => {
        const edited = await lsp.rename(
          args.path,
          { line: args.line, character: args.character },
          args.new_name,
        );
        return { value: { edited }, isError: false };
      },
    }),
  ];
}
