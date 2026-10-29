import { describe, expect, it } from 'vitest';

import { segmentSpeechText, stableMarkdownPrefix } from '../src/voice-call-text.js';

describe('segmentSpeechText', () => {
  it('splits Chinese sentence and clause boundaries while retaining unfinished text', () => {
    const text = ' 第一句话。第二句！第三句？第四句；第五句、未完成';

    expect(segmentSpeechText(text, false)).toEqual({
      segments: ['第一句话。', '第二句！', '第三句？', '第四句；', '第五句、'],
      remainder: '未完成',
      consumed: text.length - '未完成'.length,
    });
  });

  it('splits English punctuation and newline boundaries without empty segments', () => {
    const text = ' First sentence. Second!\nThird?\r\nFourth; tail';

    expect(segmentSpeechText(text, false)).toEqual({
      segments: ['First sentence.', 'Second!', 'Third?', 'Fourth;'],
      remainder: ' tail',
      consumed: text.length - ' tail'.length,
    });
  });

  it('does not treat decimal points as sentence boundaries', () => {
    const text = 'Pi is 3.14159. Next is 2.5; tail';

    expect(segmentSpeechText(text, false)).toEqual({
      segments: ['Pi is 3.14159.', 'Next is 2.5;'],
      remainder: ' tail',
      consumed: text.length - ' tail'.length,
    });
  });

  it('breaks long prose at a safe whitespace boundary', () => {
    const words = Array.from({ length: 35 }, () => 'word');
    const text = words.join(' ');
    const expectedSegment = words.slice(0, 32).join(' ');
    const expectedRemainder = words.slice(32).join(' ');

    const result = segmentSpeechText(text, false);

    expect(expectedSegment.length).toBeGreaterThanOrEqual(120);
    expect(expectedSegment.length).toBeLessThanOrEqual(160);
    expect(result).toEqual({
      segments: [expectedSegment],
      remainder: expectedRemainder,
      consumed: text.length - expectedRemainder.length,
    });
  });

  it('bounds unbroken Chinese prose without waiting for punctuation', () => {
    const text = '汉'.repeat(325);

    const result = segmentSpeechText(text, false);

    expect(result.segments.map((segment) => segment.length)).toEqual([160, 160]);
    expect(result.segments).toEqual(['汉'.repeat(160), '汉'.repeat(160)]);
    expect(result.remainder).toBe('汉'.repeat(5));
    expect(result.consumed).toBe(320);
  });

  it('flushes a non-empty remainder only when final', () => {
    const text = 'Done.\n  last words  ';

    expect(segmentSpeechText(text, true)).toEqual({
      segments: ['Done.', 'last words'],
      remainder: '',
      consumed: text.length,
    });
    expect(segmentSpeechText(' \n ', true)).toEqual({
      segments: [],
      remainder: '',
      consumed: 3,
    });
  });

  it('supports cumulative input without duplicating speech or splitting a decimal prefix', () => {
    let cumulative = 'First sentence. Value 3.';
    let offset = 0;
    const spoken: string[] = [];

    const first = segmentSpeechText(cumulative.slice(offset), false);
    spoken.push(...first.segments);
    offset += first.consumed;

    expect(first).toEqual({
      segments: ['First sentence.'],
      remainder: ' Value 3.',
      consumed: cumulative.length - ' Value 3.'.length,
    });

    cumulative += '14159 is pi. Tail';
    const secondInput = cumulative.slice(offset);
    const second = segmentSpeechText(secondInput, false);
    spoken.push(...second.segments);
    offset += second.consumed;

    expect(second).toEqual({
      segments: ['Value 3.14159 is pi.'],
      remainder: ' Tail',
      consumed: secondInput.length - ' Tail'.length,
    });
    expect(second.remainder).toBe(secondInput.slice(second.consumed));

    const finalInput = cumulative.slice(offset);
    const flushed = segmentSpeechText(finalInput, true);
    spoken.push(...flushed.segments);
    offset += flushed.consumed;

    expect(flushed).toEqual({ segments: ['Tail'], remainder: '', consumed: finalInput.length });
    expect(offset).toBe(cumulative.length);
    expect(spoken).toEqual(['First sentence.', 'Value 3.14159 is pi.', 'Tail']);
  });
});

describe('stableMarkdownPrefix', () => {
  it('keeps plain leading sentences but holds links, code and raw URLs until final', () => {
    expect(stableMarkdownPrefix('Read this. [Hello](https://example.', false)).toBe('Read this. ');
    expect(stableMarkdownPrefix('Run it. `npm', false)).toBe('Run it. ');
    expect(stableMarkdownPrefix('See https://example.', false)).toBe('See ');
    expect(stableMarkdownPrefix('See www.example.', false)).toBe('See ');
    expect(stableMarkdownPrefix('[Hello](https://example.com)', true)).toBe(
      '[Hello](https://example.com)',
    );
  });

  it('holds AST-sensitive emphasis and tables without dropping ordinary final text', () => {
    expect(stableMarkdownPrefix('Read this. **Bold', false)).toBe('Read this. ');
    expect(stableMarkdownPrefix('Read this. | a | b |', false)).toBe('Read this. ');
    expect(stableMarkdownPrefix('Use C++ and C#.', false)).toBe('Use C++ and C#.');
    expect(stableMarkdownPrefix('Keep a*b and snake_case.', true)).toBe('Keep a*b and snake_case.');
  });
});
