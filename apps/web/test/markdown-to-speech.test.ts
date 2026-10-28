import { describe, expect, it } from 'vitest';

import { markdownToSpeechText } from '../src/markdown-to-speech.js';

describe('markdownToSpeechText', () => {
  it('keeps plain prose unchanged', () => {
    expect(markdownToSpeechText('Hello world, how are you?')).toBe('Hello world, how are you?');
  });

  it('strips headings, bold, and italic markers', () => {
    expect(markdownToSpeechText('## **Bold** and *italic* and _italic_')).toBe(
      'Bold and italic and italic',
    );
  });

  it('removes fenced code blocks entirely but keeps inline code text', () => {
    const md = 'Run this:\n```bash\npnpm install\n```\nThen use `pnpm dev`.';
    expect(markdownToSpeechText(md)).toBe('Run this: Then use pnpm dev.');
  });

  it('keeps link labels and drops image references', () => {
    expect(
      markdownToSpeechText('See [the docs](https://example.com) and ![screenshot](a.png).'),
    ).toBe('See the docs and .');
  });

  it('flattens lists and task lists into plain sentences', () => {
    const md = '- first item\n- [x] done task\n2. second item';
    expect(markdownToSpeechText(md)).toBe('first item done task second item');
  });

  it('flattens tables, dropping the separator row and pipes', () => {
    const md = '| Name | Value |\n| ---- | ----- |\n| a | 1 |';
    expect(markdownToSpeechText(md)).toBe('Name Value a 1');
  });

  it('strips blockquote markers', () => {
    expect(markdownToSpeechText('> quoted text\nnormal text')).toBe('quoted text normal text');
  });

  it('collapses whitespace and trims', () => {
    expect(markdownToSpeechText('  a  \n\n  b  ')).toBe('a b');
    expect(markdownToSpeechText('')).toBe('');
  });
});
