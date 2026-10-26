import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Button, Input, Modal, Space, type InputRef } from 'antd';
import type { AcpClient } from '@trinity-harness/client-acp';
import { newId } from '@trinity-harness/shared';
import type {
  BrowserControlState,
  BrowserHumanAction,
  BrowserInteractionFrame,
  BrowserInteractionRequest,
  BrowserInteractionResult,
} from '@trinity-harness/shared';

const unavailable: BrowserControlState = {
  available: false,
  mode: 'paused',
  generation: null,
  epoch: 0,
  controllerId: null,
  expiresAt: null,
  nextSequence: 1,
};
type Queued =
  | {
      action: BrowserHumanAction;
      frameId?: string;
      generation?: string;
      epoch?: number;
      composerVersion?: number;
    }
  | { operation: 'state' | 'take' | 'release' | 'pause' | 'reset' };
export function mapBrowserPoint(
  rect: { left: number; top: number; width: number; height: number },
  frame: { width: number; height: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    clientX < rect.left ||
    clientY < rect.top ||
    clientX > rect.left + rect.width ||
    clientY > rect.top + rect.height
  )
    return null;
  return {
    x: Math.min(frame.width - 1, ((clientX - rect.left) * frame.width) / rect.width),
    y: Math.min(frame.height - 1, ((clientY - rect.top) * frame.height) / rect.height),
  };
}
function wait(signal: AbortSignal, wake: EventTarget, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(ms)]);
    const finish = (): void => {
      timeout.removeEventListener('abort', finish);
      wake.removeEventListener('change', finish);
      resolve();
    };
    timeout.addEventListener('abort', finish, { once: true });
    wake.addEventListener('change', finish, { once: true });
    if (timeout.aborted) finish();
  });
}
export function InteractiveBrowserView({
  client,
  sessionId,
  onClose,
  onUnsupported,
}: {
  client: Pick<AcpClient, 'interactBrowser'>;
  sessionId: string;
  onClose: () => void;
  onUnsupported: () => void;
}): ReactElement {
  const [viewId] = useState(() => newId());
  const [state, setState] = useState<BrowserControlState>(unavailable);
  const [frame, setFrame] = useState<BrowserInteractionFrame | null>(null);
  const [message, setMessage] = useState('Connecting to browser…');
  const [pending, setPending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);
  const [panView, setPanView] = useState(false);
  const [refreshMs, setRefreshMs] = useState<number | null>(null);
  const [dragPreview, setDragPreview] = useState<{
    from: { x: number; y: number };
    to: { x: number; y: number };
  } | null>(null);
  const [address, setAddress] = useState('https://www.google.com/');
  const [textDraft, setTextDraft] = useState('');
  const [insertingText, setInsertingText] = useState(false);
  const draftVersion = useRef(0);
  const current = useRef(state),
    picture = useRef(frame);
  const closeRequested = useRef(false);
  const heldControl = useRef(false);
  const closeView = useRef(onClose);
  closeView.current = onClose;
  const queue = useRef<Queued[]>([]);
  const wake = useRef(new EventTarget());
  const image = useRef<HTMLImageElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const addressInput = useRef<InputRef>(null);
  const addressDirty = useRef(false);
  const localPan = useRef<{
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const composing = useRef(false);
  const keyboardId = useRef<string | undefined>(undefined);
  const lastClick = useRef<{
    x: number;
    y: number;
    at: number;
    button: number;
    epoch: number;
  } | null>(null);
  const pointer = useRef<{
    x: number;
    y: number;
    pointerId: number;
    clientX: number;
    clientY: number;
    button: number;
    width: number;
    height: number;
    rect: DOMRect;
    frameId: string;
    generation: string;
    epoch: number;
  } | null>(null);
  const cancelPointer = useCallback((): void => {
    const active = pointer.current ?? localPan.current;
    pointer.current = null;
    localPan.current = null;
    setDragPreview(null);
    if (active && image.current?.hasPointerCapture?.(active.pointerId))
      image.current.releasePointerCapture(active.pointerId);
    wake.current.dispatchEvent(new Event('change'));
  }, []);
  const owns = state.mode === 'human' && state.controllerId === viewId;
  const enqueue = useCallback(
    (item: Queued): boolean => {
      if (closeRequested.current) return false;
      if ('action' in item) {
        const control = current.current;
        if (control.mode !== 'human' || control.controllerId !== viewId) return false;
        item = {
          ...item,
          generation: item.generation ?? control.generation ?? undefined,
          epoch: item.epoch ?? control.epoch,
        };
        const last = queue.current.at(-1);
        if (
          item.action.type === 'scroll' &&
          last &&
          'action' in last &&
          last.action.type === 'scroll' &&
          last.generation === item.generation &&
          last.epoch === item.epoch &&
          Math.abs(last.action.dx + item.action.dx) <= 2000 &&
          Math.abs(last.action.dy + item.action.dy) <= 2000
        ) {
          last.action = {
            type: 'scroll',
            dx: last.action.dx + item.action.dx,
            dy: last.action.dy + item.action.dy,
          };
          return true;
        }
        if (
          item.action.type === 'text' &&
          last &&
          'action' in last &&
          last.action.type === 'text' &&
          item.composerVersion === undefined &&
          last.composerVersion === undefined &&
          last.generation === item.generation &&
          last.epoch === item.epoch &&
          last.action.text.length + item.action.text.length <= 4000
        ) {
          last.action = { type: 'text', text: last.action.text + item.action.text };
          return true;
        }
      }
      if (queue.current.length >= 64) {
        setMessage('Input queue is full. Wait for the picture to refresh.');
        return false;
      }
      queue.current.push(item);
      wake.current.dispatchEvent(new Event('change'));
      return true;
    },
    [viewId],
  );
  useEffect(() => {
    const controller = new AbortController();
    const apply = (result: BrowserInteractionResult, item?: Queued): void => {
      setConnected(true);
      if (item && 'action' in item && item.composerVersion !== undefined) {
        setInsertingText(false);
        if (result.input?.effect === 'applied' && draftVersion.current === item.composerVersion)
          setTextDraft('');
      }
      const old = current.current;
      current.current = result.state;
      if (result.state.mode !== 'paused')
        heldControl.current = result.state.mode === 'human' && result.state.controllerId === viewId;
      setState(result.state);
      if (
        old.epoch !== result.state.epoch ||
        old.generation !== result.state.generation ||
        old.controllerId !== result.state.controllerId
      ) {
        cancelPointer();
        lastClick.current = null;
        queue.current = [];
        setInsertingText(false);
        keyboardId.current = undefined;
        composing.current = false;
        if (keyboard.current) keyboard.current.value = '';
        picture.current = null;
        setFrame(null);
      }
      if (result.state.mode !== 'human') cancelPointer();
      if (result.keyboardId) keyboardId.current = result.keyboardId;
      if (result.input && !result.keyboardId) {
        keyboardId.current = undefined;
        if (!result.frame) {
          picture.current = null;
          queue.current = [];
          setInsertingText(false);
        }
      }
      if (result.frame && !pointer.current) {
        picture.current = result.frame;
        setFrame(result.frame);
        const activeTab = result.frame.browser?.tabs.find((tab) => tab.active);
        if (activeTab && !addressDirty.current) setAddress(activeTab.url);
      } else if (
        result.error?.code === 'UNAVAILABLE' ||
        result.error?.code === 'PRIVACY_BLOCKED' ||
        result.error?.code === 'NOT_AUTHORIZED'
      ) {
        picture.current = null;
        setFrame(null);
        keyboardId.current = undefined;
        if (result.error?.code === 'NOT_AUTHORIZED') setTextDraft('');
      }
      setMessage(
        result.error?.message ??
          (result.state.mode === 'human' && result.state.controllerId === viewId
            ? 'You control the browser'
            : result.state.mode === 'agent'
              ? 'Agent controls the browser'
              : result.state.mode === 'quarantined'
                ? 'Input outcome is unknown. Take control to inspect the browser before continuing.'
                : result.state.available
                  ? 'Browser control is paused'
                  : 'No browser is active. Start a browser to continue.'),
      );
      if (result.error && !['BUSY', 'UNAVAILABLE'].includes(result.error.code)) {
        queue.current = [];
        setInsertingText(false);
        keyboardId.current = undefined;
      }
    };
    const watch = async (): Promise<void> => {
      let initialized = false;
      while (!controller.signal.aborted) {
        let retryDelay = 0;
        const cycleStarted = performance.now();
        if (
          document.visibilityState === 'hidden' &&
          !queue.current.length &&
          !closeRequested.current
        ) {
          await wait(controller.signal, wake.current, 60_000);
          continue;
        }
        // Briefly collect adjacent text commits; keys and pointer actions keep their order.
        const first = queue.current[0];
        if (first && 'action' in first && first.action.type === 'text')
          await wait(controller.signal, new EventTarget(), 35);
        if (controller.signal.aborted) break;
        const closing = closeRequested.current;
        const control = current.current;
        if (
          closing &&
          (!control.generation ||
            !heldControl.current ||
            !['human', 'paused'].includes(control.mode))
        ) {
          closeView.current();
          return;
        }
        const item: Queued | undefined = closing ? { operation: 'release' } : queue.current.shift();
        try {
          let request: BrowserInteractionRequest;
          const control = current.current;
          if (item && 'operation' in item) {
            if (
              item.operation === 'state' ||
              item.operation === 'take' ||
              item.operation === 'reset'
            )
              request = { sessionId, viewId, operation: item.operation };
            else if (control.generation)
              request = {
                sessionId,
                viewId,
                operation: item.operation,
                generation: control.generation,
                epoch: control.epoch,
              };
            else continue;
          } else if (item && 'action' in item) {
            const shown = picture.current;
            if (
              !shown ||
              !control.generation ||
              control.mode !== 'human' ||
              control.controllerId !== viewId
            ) {
              setMessage('Wait for a fresh picture before sending input.');
              queue.current = [];
              setInsertingText(false);
              continue;
            }
            request = {
              sessionId,
              viewId,
              operation: 'input',
              generation: item.generation ?? shown.generation,
              epoch: item.epoch ?? shown.epoch,
              frameId: item.frameId ?? shown.frameId,
              sequence: control.nextSequence,
              requestId: newId(),
              action: item.action,
              capture: item.action.type !== 'text' && item.action.type !== 'key',
              ...((item.action.type === 'text' || item.action.type === 'key') && keyboardId.current
                ? { keyboardId: keyboardId.current }
                : {}),
            };
          } else
            request =
              pointer.current && control.generation
                ? {
                    sessionId,
                    viewId,
                    operation: 'heartbeat',
                    generation: control.generation,
                    epoch: control.epoch,
                  }
                : {
                    sessionId,
                    viewId,
                    operation: initialized && control.available ? 'frame' : 'state',
                  };
          if (item) setPending(true);
          const started = performance.now();
          const result = await client.interactBrowser(request, controller.signal);
          if (!controller.signal.aborted && result.frame)
            setRefreshMs(Math.round(performance.now() - started));
          if (controller.signal.aborted) break;
          apply(result, item);
          if (closing) {
            closeRequested.current = false;
            if (!result.error && result.state.mode === 'agent') {
              closeView.current();
              return;
            }
            setMessage(
              `Could not return control to the agent. ${result.error?.message ?? 'Check the browser state and close again.'}`,
            );
          }
          initialized = true;
          if (result.error?.code === 'UNAVAILABLE') retryDelay = 5000;
        } catch (error) {
          if (controller.signal.aborted) break;
          closeRequested.current = false;
          setConnected(false);
          const status = error instanceof Error && 'status' in error ? error.status : undefined;
          if (status === 501) {
            onUnsupported();
            return;
          }
          initialized = false;
          cancelPointer();
          queue.current = [];
          setInsertingText(false);
          keyboardId.current = undefined;
          picture.current = null;
          setFrame(null);
          if (status === 401 || status === 404) {
            setTextDraft('');
            picture.current = null;
            setFrame(null);
            current.current = unavailable;
            setState(unavailable);
            setMessage('Browser access is no longer available.');
            return;
          }
          setMessage(
            closing
              ? 'Could not confirm that control returned to the agent. Reconnecting; close again once connected.'
              : status === 503
                ? 'Managed browser service is temporarily unavailable. Retrying the connection; input was not retried.'
                : 'Connection interrupted. Input was not retried; waiting for a fresh picture…',
          );
          retryDelay = 5000;
        } finally {
          if (!controller.signal.aborted) setPending(false);
        }
        if (!queue.current.length && !closeRequested.current)
          await wait(
            controller.signal,
            wake.current,
            retryDelay ||
              (current.current.mode === 'human' && !pointer.current
                ? Math.max(16, Math.round(250 - (performance.now() - cycleStarted)))
                : 1000),
          );
      }
    };
    const visible = (): void => {
      if (document.visibilityState === 'hidden') {
        cancelPointer();
        queue.current = [];
        if (current.current.mode === 'human' && current.current.controllerId === viewId)
          enqueue({ operation: 'pause' });
      } else wake.current.dispatchEvent(new Event('change'));
    };
    document.addEventListener('visibilitychange', visible);
    void watch();
    return () => {
      controller.abort();
      cancelPointer();
      queue.current = [];
      document.removeEventListener('visibilitychange', visible);
    };
  }, [client, sessionId, viewId, onUnsupported, enqueue, cancelPointer]);
  const requestClose = (): void => {
    if (closeRequested.current) return;
    closeRequested.current = true;
    cancelPointer();
    queue.current = [];
    setInsertingText(false);
    setPending(true);
    setMessage('Returning control to the agent…');
    wake.current.dispatchEvent(new Event('change'));
  };
  useEffect(() => {
    const node = viewport.current;
    const wheel = (event: WheelEvent): void => {
      if (
        current.current.mode !== 'human' ||
        current.current.controllerId !== viewId ||
        !picture.current
      )
        return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        cancelPointer();
        setZoom((value) =>
          Math.max(0.5, Math.min(4, (value ?? 1) + (event.deltaY < 0 ? 0.25 : -0.25))),
        );
        return;
      }
      if (panView && zoom !== null) {
        cancelPointer();
        node?.scrollBy({ left: event.deltaX, top: event.deltaY });
        return;
      }
      if (pointer.current) return;
      enqueue({
        action: {
          type: 'scroll',
          dx: Math.max(
            -2000,
            Math.min(
              2000,
              Math.round(
                event.deltaX *
                  (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? picture.current.width : 1),
              ),
            ),
          ),
          dy: Math.max(
            -2000,
            Math.min(
              2000,
              Math.round(
                event.deltaY *
                  (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? picture.current.height : 1),
              ),
            ),
          ),
        },
      });
    };
    node?.addEventListener('wheel', wheel, { passive: false });
    return () => node?.removeEventListener('wheel', wheel);
  }, [enqueue, viewId, zoom, panView, cancelPointer]);
  useEffect(() => {
    window.addEventListener('resize', cancelPointer);
    window.addEventListener('blur', cancelPointer);
    return () => {
      window.removeEventListener('resize', cancelPointer);
      window.removeEventListener('blur', cancelPointer);
    };
  }, [cancelPointer]);
  const browserAction = (action: BrowserHumanAction): void => {
    cancelPointer();
    addressDirty.current = false;
    enqueue({ action });
  };
  const changeZoom = (value: number | null): void => {
    cancelPointer();
    setZoom(value);
    if (value === null) setPanView(false);
  };
  const text = (value: string, composerVersion?: number): boolean => {
    if (!value || current.current.mode !== 'human' || current.current.controllerId !== viewId)
      return false;
    const chunks: string[] = [];
    for (let offset = 0; offset < value.length;) {
      let end = Math.min(offset + 4000, value.length);
      if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
      chunks.push(value.slice(offset, end));
      offset = end;
    }
    if (queue.current.length + chunks.length > 64) {
      setMessage('Input queue is full. Wait for the picture to refresh.');
      return false;
    }
    for (const chunk of chunks) enqueue({ action: { type: 'text', text: chunk }, composerVersion });
    return true;
  };
  return (
    <Modal
      title={
        <div className="browser-view-heading">
          <span>Browser</span>
          <span className={`browser-control-badge${owns ? ' is-controlled' : ''}`}>
            {owns
              ? 'You have control'
              : state.mode === 'agent' && state.available
                ? 'Agent has control'
                : 'View only'}
          </span>
        </div>
      }
      className={`browser-view-modal${expanded ? ' browser-view-expanded' : ''}`}
      open
      onCancel={requestClose}
      footer={null}
      width={expanded ? 'calc(100vw - 32px)' : 1120}
      destroyOnHidden
    >
      <div className="browser-view-actions">
        <Space wrap className="browser-control-toolbar">
          <Button
            type={owns ? 'default' : 'primary'}
            disabled={!connected || pending || owns || (state.mode === 'human' && !owns)}
            onClick={() => enqueue({ operation: 'take' })}
          >
            {state.available ? 'Take control' : 'Start browser'}
          </Button>
          <Button
            type={owns ? 'primary' : 'default'}
            disabled={pending || !state.available || (state.mode === 'human' && !owns)}
            onClick={() => enqueue({ operation: 'release' })}
          >
            Return control to agent
          </Button>
        </Space>
        <Button
          aria-pressed={expanded}
          onClick={() => {
            cancelPointer();
            setExpanded(!expanded);
          }}
        >
          {expanded ? 'Restore view' : 'Expand view'}
        </Button>
      </div>
      <details className="browser-advanced-controls">
        <summary>More controls</summary>
        <Space wrap>
          <Button disabled={pending} onClick={() => enqueue({ operation: 'state' })}>
            Retry connection
          </Button>
          <Button disabled={pending || !owns} onClick={() => enqueue({ operation: 'pause' })}>
            Pause
          </Button>
          <Button
            disabled={pending || (state.mode === 'human' && !owns)}
            onClick={() => enqueue({ operation: 'reset' })}
          >
            Restart browser
          </Button>
        </Space>
      </details>
      <p className="browser-view-status" role="status" aria-live="polite">
        {message}
        {pending && <span className="browser-working"> · Applying action…</span>}
      </p>
      <div className="browser-navigation-toolbar" role="toolbar" aria-label="Browser navigation">
        <Button
          aria-label="Go back"
          disabled={!owns || pending || !frame}
          onClick={() => browserAction({ type: 'back' })}
        >
          ←
        </Button>
        <Button
          aria-label="Go forward"
          disabled={!owns || pending || !frame}
          onClick={() => browserAction({ type: 'forward' })}
        >
          →
        </Button>
        <Button
          aria-label="Reload page"
          disabled={!owns || pending || !frame}
          onClick={() => browserAction({ type: 'reload' })}
        >
          ↻
        </Button>
        <Input.Search
          ref={addressInput}
          aria-label="Browser address"
          value={address}
          disabled={!owns}
          onChange={(event) => {
            addressDirty.current = true;
            setAddress(event.target.value);
          }}
          enterButton="Go"
          onSearch={() => {
            try {
              const url = new URL(address.includes('://') ? address : `https://${address}`);
              if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
                throw new Error('invalid');
              browserAction({ type: 'navigate', url: url.href });
            } catch {
              setMessage('Enter an HTTP or HTTPS address without credentials.');
            }
          }}
        />
      </div>
      {owns && frame?.browser && (
        <div className="browser-tab-toolbar" role="toolbar" aria-label="Browser tabs">
          {frame.browser.tabs.map((tab) => (
            <div className={`browser-tab${tab.active ? ' is-active' : ''}`} key={tab.id}>
              <Button
                aria-pressed={tab.active}
                title={tab.url}
                disabled={pending}
                onClick={() => browserAction({ type: 'switch_tab', tabId: tab.id })}
              >
                {tab.title || (tab.url === 'about:blank' ? 'New tab' : tab.url)}
              </Button>
              <Button
                aria-label={`Close tab ${tab.title || tab.url}`}
                disabled={pending || frame.browser!.tabs.length <= 1}
                onClick={() => browserAction({ type: 'close_tab', tabId: tab.id })}
              >
                ×
              </Button>
            </div>
          ))}
          <Button
            disabled={pending || frame.browser.tabs.length >= 64}
            onClick={() => browserAction({ type: 'new_tab' })}
          >
            New tab
          </Button>
        </div>
      )}
      <div className="browser-zoom-toolbar">
        <label>
          View zoom{' '}
          <select
            aria-label="View zoom"
            value={zoom ?? 'fit'}
            onChange={(event) =>
              changeZoom(event.target.value === 'fit' ? null : Number(event.target.value))
            }
          >
            <option value="fit">Fit</option>
            {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4].map(
              (value) => (
                <option key={value} value={value}>
                  {value * 100}%
                </option>
              ),
            )}
          </select>
        </label>
        <Button
          aria-pressed={panView}
          disabled={zoom === null}
          onClick={() => {
            cancelPointer();
            setPanView(!panView);
          }}
        >
          {panView ? 'Interact with page' : 'Pan view'}
        </Button>
        <span>
          {panView
            ? 'Drag or scroll to move the enlarged view'
            : 'Ctrl/⌘ + wheel to magnify · Pan view to move around'}
        </span>
      </div>
      <div
        ref={viewport}
        aria-busy={pending}
        data-input-sequence={state.nextSequence}
        className={`browser-interactive-viewport${owns ? ' browser-controlled' : ''}${zoom !== null ? ' is-zoomed' : ''}${panView ? ' is-panning' : ''}`}
        onScroll={() => {
          if (pointer.current) cancelPointer();
        }}
      >
        {!frame && (
          <div className="browser-view-empty">
            <svg width="64" height="54" viewBox="0 0 64 54" fill="none" aria-hidden="true">
              <rect
                x="3"
                y="3"
                width="58"
                height="38"
                rx="6"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path d="M23 51h18M32 41v10M3 13h58" stroke="currentColor" strokeWidth="2" />
              <circle cx="10" cy="8" r="1" fill="currentColor" />
              <circle cx="15" cy="8" r="1" fill="currentColor" />
            </svg>
            <strong>
              {state.available
                ? 'Waiting for the browser picture'
                : 'Your browser, ready when you are'}
            </strong>
            <span>
              {state.available ? message : 'Start the browser to open a page and interact with it.'}
            </span>
          </div>
        )}
        {frame && (
          <div
            className="browser-picture"
            style={zoom !== null ? { width: frame.width * zoom } : undefined}
          >
            <img
              ref={image}
              className="browser-preview-image"
              alt="Interactive browser viewport"
              draggable={false}
              width={frame.width}
              height={frame.height}
              src={`data:image/png;base64,${frame.png}`}
              onContextMenu={(event) => {
                if (owns) event.preventDefault();
              }}
              onPointerDown={(event) => {
                if (
                  panView &&
                  zoom !== null &&
                  event.button === 0 &&
                  event.isPrimary !== false &&
                  !localPan.current &&
                  viewport.current
                ) {
                  event.preventDefault();
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  localPan.current = {
                    pointerId: event.pointerId,
                    x: event.clientX,
                    y: event.clientY,
                    left: viewport.current.scrollLeft,
                    top: viewport.current.scrollTop,
                  };
                  return;
                }
                if (!owns || !picture.current || pointer.current || event.isPrimary === false)
                  return;
                event.preventDefault();
                keyboard.current?.focus({ preventScroll: true });
                const rect = event.currentTarget.getBoundingClientRect();
                const point = mapBrowserPoint(rect, picture.current, event.clientX, event.clientY);
                if (point) {
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  pointer.current = {
                    ...point,
                    pointerId: event.pointerId,
                    clientX: event.clientX,
                    clientY: event.clientY,
                    button: event.button,
                    width: picture.current.width,
                    height: picture.current.height,
                    rect,
                    frameId: picture.current.frameId,
                    generation: picture.current.generation,
                    epoch: picture.current.epoch,
                  };
                  wake.current.dispatchEvent(new Event('change'));
                }
              }}
              onPointerMove={(event) => {
                const pan = localPan.current;
                if (pan && pan.pointerId === event.pointerId && viewport.current) {
                  viewport.current.scrollLeft = pan.left + pan.x - event.clientX;
                  viewport.current.scrollTop = pan.top + pan.y - event.clientY;
                  return;
                }
                const from = pointer.current;
                if (!from || from.pointerId !== event.pointerId || from.button !== 0) return;
                const to = mapBrowserPoint(from.rect, from, event.clientX, event.clientY);
                if (
                  to &&
                  Math.hypot(event.clientX - from.clientX, event.clientY - from.clientY) > 3
                )
                  setDragPreview({ from: { x: from.x, y: from.y }, to });
              }}
              onPointerCancel={(event) => {
                if (localPan.current?.pointerId === event.pointerId) localPan.current = null;
                if (pointer.current?.pointerId === event.pointerId) cancelPointer();
              }}
              onLostPointerCapture={(event) => {
                if (localPan.current?.pointerId === event.pointerId) localPan.current = null;
                if (pointer.current?.pointerId === event.pointerId) cancelPointer();
              }}
              onPointerUp={(event) => {
                if (localPan.current && localPan.current.pointerId === event.pointerId) {
                  localPan.current = null;
                  if (event.currentTarget.hasPointerCapture?.(event.pointerId))
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  return;
                }
                const from = pointer.current;
                if (!from || from.pointerId !== event.pointerId || from.button !== event.button)
                  return;
                cancelPointer();
                if (!owns || !picture.current) return;
                const rect = event.currentTarget.getBoundingClientRect();
                if (
                  rect.left !== from.rect.left ||
                  rect.top !== from.rect.top ||
                  rect.width !== from.rect.width ||
                  rect.height !== from.rect.height
                )
                  return;
                const point = mapBrowserPoint(rect, from, event.clientX, event.clientY);
                if (!point) return;
                const previous = lastClick.current;
                const isDrag =
                  Math.hypot(event.clientX - from.clientX, event.clientY - from.clientY) > 3;
                if (isDrag && from.button !== 0) return;
                const double =
                  !isDrag &&
                  previous &&
                  previous.button === event.button &&
                  previous.epoch === from.epoch &&
                  Date.now() - previous.at < 400 &&
                  Math.hypot(point.x - previous.x, point.y - previous.y) <= 4;
                lastClick.current =
                  isDrag || double
                    ? null
                    : { ...point, at: Date.now(), button: event.button, epoch: from.epoch };
                const action: BrowserHumanAction = isDrag
                  ? { type: 'drag', from: { x: from.x, y: from.y }, to: point }
                  : {
                      type: 'click',
                      point,
                      button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left',
                      count: double ? 2 : 1,
                      modifiers: [
                        ...(event.altKey ? ['alt' as const] : []),
                        ...(event.ctrlKey ? ['ctrl' as const] : []),
                        ...(event.metaKey ? ['meta' as const] : []),
                        ...(event.shiftKey ? ['shift' as const] : []),
                      ],
                    };
                enqueue({
                  action,
                  frameId: from.frameId,
                  generation: from.generation,
                  epoch: from.epoch,
                });
              }}
            />
            {dragPreview && (
              <svg
                className="browser-drag-preview"
                viewBox={`0 0 ${frame.width} ${frame.height}`}
                aria-hidden="true"
              >
                <line
                  x1={dragPreview.from.x}
                  y1={dragPreview.from.y}
                  x2={dragPreview.to.x}
                  y2={dragPreview.to.y}
                />
                <circle cx={dragPreview.from.x} cy={dragPreview.from.y} r="5" />
                <circle cx={dragPreview.to.x} cy={dragPreview.to.y} r="12" />
              </svg>
            )}
          </div>
        )}
        {dragPreview && <div className="browser-drag-hint">Release to drop</div>}
        <textarea
          ref={keyboard}
          className="browser-input-capture"
          aria-label="Browser keyboard input"
          disabled={!owns}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(event) => {
            composing.current = false;
            text(event.data);
            event.currentTarget.value = '';
          }}
          onInput={(event) => {
            if (!composing.current) {
              text(event.currentTarget.value);
              event.currentTarget.value = '';
            }
          }}
          onPaste={(event) => {
            event.preventDefault();
            text(event.clipboardData.getData('text'));
          }}
          onKeyDown={(event) => {
            if (composing.current || event.nativeEvent.isComposing) return;
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
              event.preventDefault();
              addressInput.current?.focus();
              return;
            }
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return;
            const shortcut = event.key.toLowerCase();
            if (
              (event.ctrlKey || event.metaKey) &&
              ['t', 'w', 'r', '+', '=', '-', '0'].includes(shortcut)
            ) {
              event.preventDefault();
              if (shortcut === 't') browserAction({ type: 'new_tab' });
              else if (shortcut === 'w') {
                const tab = picture.current?.browser?.tabs.find((tab) => tab.active);
                if (tab) browserAction({ type: 'close_tab', tabId: tab.id });
              } else if (shortcut === 'r') browserAction({ type: 'reload' });
              else
                changeZoom(
                  shortcut === '0'
                    ? null
                    : Math.max(0.5, Math.min(4, (zoom ?? 1) + (shortcut === '-' ? -0.25 : 0.25))),
                );
              return;
            }
            if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
              event.preventDefault();
              browserAction({ type: event.key === 'ArrowLeft' ? 'back' : 'forward' });
              return;
            }
            const special = [
              'Enter',
              'Tab',
              'Escape',
              'Backspace',
              'Delete',
              'ArrowUp',
              'ArrowDown',
              'ArrowLeft',
              'ArrowRight',
              'Home',
              'End',
              'PageUp',
              'PageDown',
            ];
            if (
              special.includes(event.key) ||
              ((event.ctrlKey || event.metaKey || event.altKey) && event.key.length === 1)
            ) {
              event.preventDefault();
              enqueue({
                action: {
                  type: 'key',
                  key: event.key,
                  modifiers: [
                    ...(event.altKey ? ['alt' as const] : []),
                    ...(event.ctrlKey ? ['ctrl' as const] : []),
                    ...(event.metaKey ? ['meta' as const] : []),
                    ...(event.shiftKey ? ['shift' as const] : []),
                  ],
                },
              });
            }
          }}
        />
      </div>
      <details className="browser-typing-tools">
        <summary>Paste or compose text</summary>
        <label className="browser-text-composer">
          Type text locally, then insert into the focused browser field
          <textarea
            aria-label="Text to insert into browser"
            value={textDraft}
            disabled={!owns}
            maxLength={4000}
            rows={3}
            autoComplete="off"
            onChange={(event) => {
              draftVersion.current++;
              setTextDraft(event.currentTarget.value);
            }}
          />
        </label>
        <Button
          disabled={!owns || !textDraft || insertingText}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (text(textDraft, draftVersion.current)) setInsertingText(true);
          }}
        >
          Insert text
        </Button>
      </details>
      {frame && (
        <p className="browser-preview-meta">
          Last picture{' '}
          <time dateTime={frame.capturedAt}>{new Date(frame.capturedAt).toLocaleTimeString()}</time>{' '}
          {refreshMs !== null && ` · ${refreshMs} ms refresh`} ·{' '}
          {owns
            ? 'Click to type · Drag to move items · Scroll to browse'
            : 'Take control to interact.'}
        </p>
      )}
      <p className="browser-preview-meta">
        Private view · Closing returns control to the agent. Hiding this browser tab pauses control.
      </p>
    </Modal>
  );
}
