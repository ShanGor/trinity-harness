/**
 * Strips markdown syntax so assistant replies read naturally when spoken by
 * the TTS service. Purely presentational: the committed message text is
 * never modified, only the derived speech text is.
 */
export function markdownToSpeechText(markdown: string): string {
  return (
    markdown
      // Fenced code blocks carry no spoken value and often garble the reading.
      .replace(/```[\s\S]*?(?:```|$)/g, ' ')
      .replace(/`([^`\n]*)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+/gm, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
      .replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, ' ')
      .replace(/\|/g, ' ')
      .replace(/(\*\*|__)([^*_]+)\1/g, '$2')
      .replace(/(\*|_)([^*_]+)\1/g, '$2')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/[*_~#]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}
