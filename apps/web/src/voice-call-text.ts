/**
 * Returns the conservative raw Markdown prefix whose speech rendering cannot
 * depend on an unfinished link, inline-code span, code fence or raw URL.
 * Content after the first such construct waits for more input (and ultimately
 * the final snapshot); plain sentences before it remain streamable.
 */
export function stableMarkdownPrefix(markdown: string, final: boolean): string {
  if (final) return markdown;
  const linkOrCode = /[[`]/u.exec(markdown)?.index;
  const rawUrl = /https?:\/\//iu.exec(markdown)?.index;
  const end = Math.min(linkOrCode ?? markdown.length, rawUrl ?? markdown.length);
  return markdown.slice(0, end);
}

const MIN_LONG_SEGMENT_LENGTH = 120;
const MAX_LONG_SEGMENT_LENGTH = 160;

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= '0' && character <= '9';
}

function isHighSurrogate(character: string | undefined): boolean {
  if (character === undefined) return false;
  const codeUnit = character.charCodeAt(0);
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(character: string | undefined): boolean {
  if (character === undefined) return false;
  const codeUnit = character.charCodeAt(0);
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function findLongSegmentBreak(
  text: string,
  segmentStart: number,
): { end: number; nextStart: number } {
  const maximumEnd = segmentStart + MAX_LONG_SEGMENT_LENGTH;

  // Prefer a whitespace boundary in the 120-160 character window so English
  // words stay intact. Newlines have already been handled as hard boundaries.
  for (let index = maximumEnd - 1; index >= segmentStart + MIN_LONG_SEGMENT_LENGTH; index -= 1) {
    if (/\s/u.test(text[index]!)) {
      return { end: index, nextStart: index + 1 };
    }
  }

  // Unbroken prose (including Chinese) still needs a bounded chunk for TTS.
  // Move back one code unit rather than splitting a surrogate pair.
  const end =
    isHighSurrogate(text[maximumEnd - 1]) && isLowSurrogate(text[maximumEnd])
      ? maximumEnd - 1
      : maximumEnd;
  return { end, nextStart: end };
}

/**
 * Splits cumulative, markdown-cleaned speech text without changing its raw offsets.
 *
 * `consumed` is the UTF-16 offset into this call's `text` immediately before
 * `remainder`, so `remainder === text.slice(consumed)`. Callers retaining the
 * cumulative text can advance their offset by `consumed`; trimmed segment
 * lengths must not be used for offset accounting because surrounding whitespace
 * and newline delimiters may have been consumed too.
 */
export function segmentSpeechText(
  text: string,
  final: boolean,
): { segments: string[]; remainder: string; consumed: number } {
  const segments: string[] = [];
  let segmentStart = 0;
  let index = 0;

  const emit = (end: number): void => {
    const segment = text.slice(segmentStart, end).trim();
    if (segment.length > 0) segments.push(segment);
  };

  while (index < text.length) {
    const character = text[index]!;

    if (character === '\n' || character === '\r') {
      emit(index);
      index += character === '\r' && text[index + 1] === '\n' ? 2 : 1;
      segmentStart = index;
      continue;
    }

    const isDecimalPoint =
      character === '.' && isDigit(text[index - 1]) && isDigit(text[index + 1]);
    const couldBecomeDecimalPoint =
      character === '.' && isDigit(text[index - 1]) && index === text.length - 1 && !final;

    // A digit followed by a final chunk-ending dot is ambiguous: the next
    // cumulative chunk may extend it into a decimal. Wait for more input.
    if (couldBecomeDecimalPoint) break;

    const isSentenceBoundary =
      character === '。' ||
      character === '！' ||
      character === '？' ||
      character === '；' ||
      character === '、' ||
      character === '.' ||
      character === '!' ||
      character === '?' ||
      character === ';';

    if (isSentenceBoundary && !isDecimalPoint) {
      emit(index + 1);
      index += 1;
      segmentStart = index;
      continue;
    }

    if (index - segmentStart + 1 >= MAX_LONG_SEGMENT_LENGTH) {
      const boundary = findLongSegmentBreak(text, segmentStart);
      emit(boundary.end);
      segmentStart = boundary.nextStart;
      index = boundary.nextStart;
      continue;
    }

    index += 1;
  }

  if (final) {
    emit(text.length);
    segmentStart = text.length;
  }

  return {
    segments,
    remainder: text.slice(segmentStart),
    consumed: segmentStart,
  };
}
