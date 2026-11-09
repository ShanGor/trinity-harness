import { readFileOptionsSchema } from '@trinity-harness/contracts';
import type { ReadFileOptions, ReadFileResult } from '@trinity-harness/contracts';

export interface TextFileSource {
  size: number;
  version: string;
  read(position: number, length: number): Promise<Uint8Array>;
  assertUnchanged(): Promise<void>;
}

/** Stream the prefix only for line selection; continuation seeks directly to its byte position. */
export async function readTextFilePage(
  source: TextFileSource,
  options: ReadFileOptions = {},
): Promise<ReadFileResult> {
  const { signal, ...input } = options;
  const args = readFileOptionsSchema.parse(input);
  const active = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  const maxBytes = args.maxBytes ?? 64 * 1024;
  const limit = args.limit ?? 2000;
  const cursor = args.cursor;
  if (cursor && (cursor.version !== source.version || cursor.byteOffset > source.size))
    throw new Error('STALE_FILE_CURSOR: file changed; read again without cursor');
  let position = cursor?.byteOffset ?? 0;
  let line = cursor?.line ?? 1;
  let column = cursor?.lineByteOffset ?? 0;
  const target = args.offset ?? line;
  while (line < target && position < source.size) {
    active.throwIfAborted();
    const chunk = await source.read(position, Math.min(64 * 1024, source.size - position));
    if (chunk.length === 0) throw new Error('FILE_CHANGED: unexpected end of file');
    let consumed = 0;
    for (const byte of chunk) {
      consumed += 1;
      if (byte === 10 && ++line === target) break;
    }
    position += consumed;
  }
  if (line < target) throw new Error('FILE_OFFSET_OUT_OF_RANGE');
  const startLine = line;
  const startColumn = column;
  // Four lookahead bytes suffice to stop before a UTF-8 sequence crossing the byte budget.
  const buffer = Buffer.alloc(Math.min(maxBytes + 4, source.size - position));
  let filled = 0;
  while (filled < buffer.length) {
    active.throwIfAborted();
    const chunk = await source.read(position + filled, buffer.length - filled);
    if (chunk.length === 0) throw new Error('FILE_CHANGED: unexpected end of file');
    buffer.set(chunk, filled);
    filled += chunk.length;
  }
  let end = Math.min(maxBytes, filled);
  if (end < filled) {
    while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  }
  if (cursor && filled > 0 && (buffer[0]! & 0xc0) === 0x80)
    throw new Error('INVALID_FILE_CURSOR: byte position is inside a UTF-8 character');
  let lines = 0;
  for (let index = 0; index < end; index += 1) {
    if (buffer[index] === 10) {
      line += 1;
      column = 0;
      if (++lines === limit) {
        end = index + 1;
        break;
      }
    } else column += 1;
  }
  const next = position + end;
  const truncated = next < source.size;
  active.throwIfAborted();
  await source.assertUnchanged();
  active.throwIfAborted();
  return {
    content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, end),
    ),
    offset: startLine,
    truncated,
    startsMidLine: startColumn > 0,
    endsMidLine: truncated && column > 0,
    ...(truncated
      ? {
          continuation: { byteOffset: next, line, lineByteOffset: column, version: source.version },
          ...(column === 0 ? { nextOffset: line } : {}),
        }
      : { totalLines: source.size === 0 ? 0 : column === 0 ? line - 1 : line }),
  };
}
