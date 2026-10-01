import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { HistorySidebar, HistoryDivider, resizeHistoryRatio } from '../src/history-sidebar';

describe('conversation history visibility', () => {
  it('shows the history and exposes an expanded toggle', () => {
    const sidebar = renderToStaticMarkup(
      createElement(HistorySidebar, {
        collapsed: false,
        widthRatio: 0.22,
        children: 'Saved conversation',
      }),
    );
    const toggle = renderToStaticMarkup(
      createElement(HistoryDivider, {
        collapsed: false,
        widthRatio: 0.22,
        onToggle: () => undefined,
        onResize: () => undefined,
      }),
    );
    expect(sidebar).toContain('Saved conversation');
    expect(sidebar).toContain('id="conversation-history"');
    expect(sidebar).not.toContain('trinity-sider-collapsed');
    expect(toggle).toContain('aria-expanded="true"');
    expect(toggle).toContain('Hide conversation history');
    expect(toggle).toContain('aria-controls="conversation-history"');
    expect(toggle).toContain('m15 6-6 6 6 6');
  });

  it('removes history controls when collapsed and keeps a labelled restore button', () => {
    const sidebar = renderToStaticMarkup(
      createElement(HistorySidebar, {
        collapsed: true,
        widthRatio: 0.22,
        children: 'Saved conversation',
      }),
    );
    const toggle = renderToStaticMarkup(
      createElement(HistoryDivider, {
        collapsed: true,
        widthRatio: 0.22,
        onToggle: () => undefined,
        onResize: () => undefined,
      }),
    );
    expect(sidebar).not.toContain('Saved conversation');
    expect(sidebar).toContain('hidden=""');
    expect(sidebar).toContain('trinity-sider-collapsed');
    expect(toggle).toContain('aria-expanded="false"');
    expect(toggle).toContain('Show conversation history');
    expect(toggle).toContain('m9 6 6 6-6 6');
  });

  it('renders a decorative vector icon without an extra keyboard focus target', () => {
    const toggle = renderToStaticMarkup(
      createElement(HistoryDivider, {
        collapsed: false,
        widthRatio: 0.22,
        onToggle: () => undefined,
        onResize: () => undefined,
      }),
    );
    expect(toggle).toContain('<svg');
    expect(toggle).toContain('aria-hidden="true"');
    expect(toggle).toContain('focusable="false"');
    expect(toggle).not.toContain('☰');
    expect(toggle).not.toContain('⇤');
  });

  it('exposes a keyboard accessible resize separator beside the toggle', () => {
    const divider = renderToStaticMarkup(
      createElement(HistoryDivider, {
        collapsed: false,
        widthRatio: 0.3,
        onToggle: () => undefined,
        onResize: () => undefined,
      }),
    );
    expect(divider).toContain('role="separator"');
    expect(divider).toContain('tabindex="0"');
    expect(divider).toContain('aria-orientation="vertical"');
    expect(divider).toContain('aria-valuenow="30"');
    expect(divider).toContain('Resize conversation history');
    expect(divider).toContain('history-divider');
  });
});

describe('history resize constraints', () => {
  it('converts a pointer movement to a change in the width ratio', () => {
    expect(resizeHistoryRatio(0.22, 100, 1000)).toBeCloseTo(0.32);
    expect(resizeHistoryRatio(0.32, -100, 1000)).toBeCloseTo(0.22);
  });

  it('keeps the history at least 220px wide', () => {
    expect(resizeHistoryRatio(0.3, -1000, 1000)).toBeCloseTo(0.22);
  });

  it('limits history to 40% and leaves at least 380px for the chat and divider', () => {
    expect(resizeHistoryRatio(0.22, 1000, 1440)).toBeCloseTo(0.4);
    expect(resizeHistoryRatio(0.22, 1000, 600)).toBeCloseTo(220 / 600);
  });

  it('can expand from a collapsed pane by dragging right', () => {
    expect(resizeHistoryRatio(0, 80, 1000)).toBeCloseTo(0.22);
  });

  it('ignores resize before the container is measured', () => {
    expect(resizeHistoryRatio(0.3, 100, 0)).toBe(0.3);
  });
});
