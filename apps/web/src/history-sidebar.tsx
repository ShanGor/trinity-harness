import { useRef, type PointerEvent, type ReactElement, type ReactNode } from 'react';
import { Button } from 'antd';

export function HistorySidebar({
  collapsed,
  children,
  widthRatio,
}: {
  collapsed: boolean;
  widthRatio: number;
  children: ReactNode;
}): ReactElement {
  return (
    <aside
      id="conversation-history"
      style={{ width: `${widthRatio * 100}%` }}
      className={`trinity-sider${collapsed ? ' trinity-sider-collapsed' : ''}`}
      hidden={collapsed}
    >
      {collapsed ? null : <div className="history-sidebar-body">{children}</div>}
    </aside>
  );
}

/** Keep history readable while reserving enough room for the conversation. */
export function resizeHistoryRatio(ratio: number, delta: number, containerWidth: number): number {
  if (containerWidth <= 0) return ratio;
  const max = Math.min(0.4, Math.max(0, (containerWidth - 380) / containerWidth));
  const min = Math.min(220 / containerWidth, max);
  return Math.max(min, Math.min(max, ratio + delta / containerWidth));
}

export function HistoryDivider({
  collapsed,
  widthRatio,
  onToggle,
  onResize,
}: {
  collapsed: boolean;
  widthRatio: number;
  onToggle: () => void;
  onResize: (ratio: number) => void;
}): ReactElement {
  const dividerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    ratio: number;
    containerWidth: number;
    target: HTMLElement;
  } | null>(null);
  const suppressClick = useRef(false);
  const label = collapsed ? 'Show conversation history' : 'Hide conversation history';

  const containerWidth = (): number => {
    const container = dividerRef.current?.parentElement;
    if (!container) return 0;
    const style = getComputedStyle(container);
    return container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  };

  const startDrag = (event: PointerEvent<HTMLElement>): void => {
    suppressClick.current = false;
    if (event.button !== 0 || window.matchMedia('(max-width: 980px)').matches) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      ratio: collapsed ? 0 : widthRatio,
      containerWidth: containerWidth(),
      target: event.currentTarget,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const finishDrag = (event: PointerEvent<HTMLElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (drag.target.hasPointerCapture(event.pointerId)) {
      drag.target.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      ref={dividerRef}
      className="history-divider"
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const delta = event.clientX - drag.startX;
        if ((Math.abs(delta) < 4 && !suppressClick.current) || (drag.ratio === 0 && delta < 0)) {
          return;
        }
        suppressClick.current = true;
        onResize(resizeHistoryRatio(drag.ratio, delta, drag.containerWidth));
      }}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onLostPointerCapture={finishDrag}
    >
      <div
        className="history-resize-handle"
        role="separator"
        tabIndex={0}
        aria-label="Resize conversation history"
        aria-orientation="vertical"
        aria-controls="conversation-history"
        aria-valuemin={0}
        aria-valuemax={40}
        aria-valuenow={collapsed ? 0 : Math.round(widthRatio * 100)}
        aria-valuetext={collapsed ? 'Collapsed' : `${Math.round(widthRatio * 100)}% history width`}
        title="Drag to resize conversation history"
        onPointerDown={startDrag}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          if (event.key === 'Home') {
            if (!collapsed) onToggle();
          } else if (collapsed && event.key === 'ArrowLeft') {
            return;
          } else if (collapsed && event.key === 'ArrowRight') {
            onToggle();
          } else {
            const width = containerWidth();
            const delta = event.key === 'End' ? width : event.key === 'ArrowLeft' ? -20 : 20;
            onResize(resizeHistoryRatio(widthRatio, delta, width));
          }
        }}
      />
      <Button
        className="history-toggle"
        type="text"
        onPointerDown={startDrag}
        onClick={() => {
          if (!suppressClick.current) onToggle();
          suppressClick.current = false;
        }}
        aria-label={label}
        aria-expanded={!collapsed}
        aria-controls="conversation-history"
        title={`${label} · drag to resize`}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d={collapsed ? 'm9 6 6 6-6 6' : 'm15 6-6 6 6 6'} />
        </svg>
      </Button>
    </div>
  );
}
