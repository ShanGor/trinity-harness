import type { AttachmentReader, SessionStore } from '@trinity-harness/contracts';
import { readAttachmentBlob } from '../multimodal/attachment-service.js';
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
export function createReadBlobTool(
  blobStore: BlobStore,
  attachments?: AttachmentReader,
  events?: SessionStore,
): ToolDefinition {
  return defineTool({
    name: 'read_blob',
    effect: { kind: 'read', scope: 'reference', evidence: 'immutable-observation' },
    description:
      'Read or search an authorized blob:// attachment or spilled result. offset and nextOffset count Unicode code points. Continue partial reads with nextOffset instead of rereading the prefix. query performs literal text search with bounded snippets and offsets. A workspacePath, when present, is the authorized session copy; never search temporary directories, runtime caches or the filesystem root for attachments.',
    parameters: z.object({
      uri: z.string().min(1).describe('blob:// URI from a spilled result or attachment'),
      offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
      query: z.string().min(1).max(200).optional(),
      maxBytes: z
        .number()
        .int()
        .positive()
        .max(STAT_MAX_BYTES)
        .optional()
        .describe('Max bytes to return'),
    }),
    execute: async (args, ctx): Promise<{ value: unknown; isError: boolean }> => {
      if (!args.uri.startsWith(BLOB_URI_SCHEME)) {
        return {
          value: { message: `not a blob URI (${BLOB_URI_SCHEME}…): ${args.uri}` },
          isError: true,
        };
      }
      let key: string;
      try {
        key = decodeURIComponent(args.uri.slice(BLOB_URI_SCHEME.length));
      } catch {
        return { value: { message: 'Invalid blob URI' }, isError: true };
      }
      if (key.split('/').includes('model-context'))
        return {
          value: { message: 'Model context snapshots are private runtime artifacts.' },
          isError: true,
        };
      if (key.split('/').includes('browser') || key.split('/').includes('..') || key.includes('\\'))
        return {
          value: { message: 'Browser evidence requires bounded browser read_observation' },
          isError: true,
        };
      const data = await readAttachmentBlob(
        blobStore,
        attachments,
        ctx.sessionId,
        args.uri,
        events,
      );
      if (data === null) {
        return { value: { message: `blob not found: ${args.uri}` }, isError: true };
      }
      ctx.signal?.throwIfAborted();
      const maxBytes = Math.min(args.maxBytes ?? DEFAULT_MAX_BYTES, STAT_MAX_BYTES);
      const points = Array.from(new TextDecoder().decode(data));
      const offset = Math.min(args.offset ?? 0, points.length);
      const history = events && attachments ? await events.load(ctx.sessionId) : [];
      const attachment = history.findLast(
        (event) => event.type === 'session/attachment' && event.uri === args.uri,
      );
      const workspacePath =
        attachment?.type === 'session/attachment' ? attachment.workspacePath : undefined;
      if (args.query !== undefined) {
        const text = points.slice(offset).join('');
        const matches: { offset: number; end: number; text: string }[] = [];
        let position = 0;
        let used = 0;
        let nextOffset: number | null = null;
        for (;;) {
          ctx.signal?.throwIfAborted();
          const found = text.indexOf(args.query, position);
          if (found < 0) break;
          const start = offset + Array.from(text.slice(0, found)).length;
          const end = start + Array.from(args.query).length;
          const snippet = points
            .slice(Math.max(offset, start - 80), Math.min(points.length, end + 80))
            .join('');
          const bytes = Buffer.byteLength(snippet);
          if (matches.length === 20 || used + bytes > maxBytes) {
            nextOffset = start;
            break;
          }
          matches.push({ offset: start, end, text: snippet });
          used += bytes;
          position = found + args.query.length;
        }
        if (!matches.length && nextOffset !== null)
          return {
            isError: true,
            value: { message: 'maxBytes is too small for a search snippet; increase it.' },
          };
        return {
          isError: false,
          value: {
            uri: args.uri,
            bytes: data.byteLength,
            workspacePath,
            query: args.query,
            matches,
            nextOffset,
            truncated: nextOffset !== null,
          },
        };
      }
      let end = offset;
      let used = 0;
      while (end < points.length) {
        const bytes = Buffer.byteLength(points[end]!);
        if (used + bytes > maxBytes) break;
        used += bytes;
        end++;
      }
      if (end === offset && end < points.length)
        return {
          isError: true,
          value: { message: 'maxBytes is too small for the next Unicode character; increase it.' },
        };
      return {
        value: {
          uri: args.uri,
          content: points.slice(offset, end).join(''),
          bytes: data.byteLength,
          offset,
          nextOffset: end < points.length ? end : null,
          workspacePath,
          truncated: end < points.length,
        },
        isError: false,
      };
    },
  });
}
