import { LanguageDescription, type LanguageSupport } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

export async function workspaceEditorLanguage(path: string): Promise<LanguageSupport | undefined> {
  return (
    LanguageDescription.matchFilename(languages, path) ??
    LanguageDescription.matchFilename(languages, path.toLowerCase())
  )?.load();
}

/** Format whitespace only: retain number precision, duplicate keys and string escapes. */
export function prettifyJson(text: string): { text: string } | { error: string } {
  try {
    JSON.parse(text);
  } catch {
    return { error: 'Invalid JSON. Fix the syntax before prettifying.' };
  }
  const tokens =
    text.match(/"(?:[^"\\]|\\.)*"|[{}[\],:]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g) ??
    [];
  const output: string[] = [];
  let depth = 0;
  let length = 0;
  const append = (...parts: string[]): void => {
    length += parts.reduce((total, part) => total + part.length, 0);
    if (length <= 5 * 1024 * 1024) output.push(...parts);
  };
  const newline = (): void => {
    append('\n', '  '.repeat(depth));
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === '{' || token === '[') {
      append(token);
      depth++;
      if (tokens[index + 1] !== '}' && tokens[index + 1] !== ']') newline();
    } else if (token === '}' || token === ']') {
      depth--;
      if (tokens[index - 1] !== '{' && tokens[index - 1] !== '[') newline();
      append(token);
    } else if (token === ',') {
      append(token);
      newline();
    } else {
      append(token === ':' ? ': ' : token);
    }
    if (length >= 5 * 1024 * 1024) {
      return { error: 'Prettified JSON exceeds the 5 MiB text limit.' };
    }
  }
  return { text: output.join('') + '\n' };
}
