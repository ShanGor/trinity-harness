/**
 * Language detection for the TTS proxy (docs/design.md §10), mirroring the
 * trinity backend (detect_qwen_tts_language_type): the reply's script is
 * classified so the TTS service gets an explicit language instead of a
 * fixed default. Latin-script languages fall back to "Auto": the local
 * faster-qwen3-tts backend resolves those on its own, so the reference's
 * keyword scoring is unnecessary here.
 */
export function detectSpeechLanguage(text: string): string {
  let han = 0;
  let kana = 0;
  let hangul = 0;
  let cyrillic = 0;
  let latin = 0;
  for (const ch of text.trim()) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      han += 1;
    } else if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0x31f0 && code <= 0x31ff)) {
      kana += 1;
    } else if (
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x3130 && code <= 0x318f)
    ) {
      hangul += 1;
    } else if (code >= 0x0400 && code <= 0x052f) {
      cyrillic += 1;
    } else if (/[a-z]/iu.test(ch)) {
      latin += 1;
    }
  }
  if (hangul > 0 && hangul >= han) return 'Korean';
  if (kana > 0) return 'Japanese';
  if (han > 0 && han * 2 >= Math.max(latin, 1)) return 'Chinese';
  if (cyrillic > 0 && cyrillic * 2 >= Math.max(latin, 1)) return 'Russian';
  return 'Auto';
}
