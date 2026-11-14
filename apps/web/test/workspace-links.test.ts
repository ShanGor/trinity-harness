// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { workspaceLinkPath } from '../src/workspace-links';

it('recognizes workspace links without changing external source links or private paths', () => {
  expect(workspaceLinkPath('browser-capture-4906eb0a542c0bbc02db6e144dcc32f6/content.md')).toBe(
    'browser-capture-4906eb0a542c0bbc02db6e144dcc32f6/content.md',
  );
  expect(workspaceLinkPath('http://localhost:5173/report.html')).toBe('report.html');
  expect(workspaceLinkPath('https://example.com/report.md')).toBeNull();
  expect(workspaceLinkPath('model-context/request.md')).toBeNull();
  expect(workspaceLinkPath('javascript:alert(1)')).toBeNull();
  expect(workspaceLinkPath('#section')).toBeNull();
});
