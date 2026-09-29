import { BLOB_URI_SCHEME } from '@trinity-harness/contracts';
import type { BlobStore, ToolDefinition } from '@trinity-harness/contracts';
import { z } from 'zod';

import { defineTool } from './define-tool.js';

const DEFAULT_MAX_BYTES = 100_000;
const STAT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Retrieval tool for spilled tool results and extracted attachments
 * (docs/design.md §7 "spill 到对象存储仅留引用"): the event log stores
 * `blob://` references; the model pulls content back on demand via this tool.
 */
export function createReadBlobTool(blobStore: BlobStore): ToolDefinition {
  return defineTool({
    name: 'read_blob',
    description:
      'Fetch the content of a blob:// URI (spilled tool output or an attachment extraction). Returns truncated UTF-8 text with a truncated flag.',
    parameters: z.object({
      uri: z.string().min(1).describe('blob:// URI from a spilled result or attachment'),
      maxBytes: z
        .number()
        .int()
        .positive()
        .max(STAT_MAX_BYTES)
        .optional()
        .describe('Max bytes to return'),
    }),
    execute: async (args): Promise<{ value: unknown; isError: boolean }> => {
      if (!args.uri.startsWith(BLOB_URI_SCHEME)) {
        return {
          value: { message: `not a blob URI (${BLOB_URI_SCHEME}…): ${args.uri}` },
          isError: true,
        };
      }
      const data = await blobStore.get(args.uri);
      if (data === null) {
        return { value: { message: `blob not found: ${args.uri}` }, isError: true };
      }
      const maxBytes = Math.min(args.maxBytes ?? DEFAULT_MAX_BYTES, STAT_MAX_BYTES);
      return {
        value: {
          uri: args.uri,
          content: Buffer.from(data.subarray(0, maxBytes)).toString('utf8'),
          bytes: data.byteLength,
          truncated: data.byteLength > maxBytes,
        },
        isError: false,
      };
    },
  });
}
