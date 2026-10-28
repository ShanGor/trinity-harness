import { describe, expect, it } from 'vitest';

import { detectSpeechLanguage } from '../src/speech-text.js';

describe('detectSpeechLanguage', () => {
  it('detects Chinese and mixed Chinese-dominant text', () => {
    expect(detectSpeechLanguage('你好世界')).toBe('Chinese');
    expect(detectSpeechLanguage('小猪佩奇（Peppa Pig）是英国作品')).toBe('Chinese');
  });

  it('detects Japanese kana, Korean hangul and Russian cyrillic', () => {
    expect(detectSpeechLanguage('こんにちは')).toBe('Japanese');
    expect(detectSpeechLanguage('안녕하세요')).toBe('Korean');
    expect(detectSpeechLanguage('Привет мир')).toBe('Russian');
  });

  it('falls back to Auto for Latin-script and empty text', () => {
    expect(detectSpeechLanguage('Hello world, this is a test.')).toBe('Auto');
    expect(detectSpeechLanguage('')).toBe('Auto');
  });
});
