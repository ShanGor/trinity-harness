import { describe, expect, it } from 'vitest';
import { attachmentMimeType, ATTACHMENT_ACCEPT } from '../src/attachments.js';

describe('attachment file recognition', () => {
  it.each([
    ['page.html', 'text/html'],
    ['data.json', 'application/json'],
    ['README.md', ''],
    ['styles.css', 'text/css'],
    ['app.ts', 'video/mp2t'],
    ['component.tsx', 'application/octet-stream'],
    ['script.py', 'application/x-python-code'],
    ['main.rs', ''],
    ['main.go', ''],
    ['Main.java', ''],
    ['config.yml', ''],
    ['Dockerfile', ''],
    ['Makefile', ''],
    ['.gitignore', ''],
    ['NOTES.MD', 'application/octet-stream'],
    ['data', 'Application/JSON; charset=utf-8'],
  ])('recognizes %s (%s) as workspace text', (name, mime) => {
    expect(attachmentMimeType(mime, name)).toBe('text/plain');
  });

  it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'])(
    'preserves %s media',
    (mime) => expect(attachmentMimeType(mime)).toBe(mime),
  );

  it.each([
    ['archive.zip', 'application/zip'],
    ['binary.exe', ''],
    ['unknown', 'application/octet-stream'],
  ])('rejects unsupported %s (%s)', (name, mime) => {
    expect(attachmentMimeType(mime, name)).toBeUndefined();
  });

  it('offers text and source extensions in the picker', () => {
    expect(ATTACHMENT_ACCEPT.split(',')).toEqual(
      expect.arrayContaining(['text/*', '.html', '.json', '.md', '.css', '.ts', '.py']),
    );
  });
});
