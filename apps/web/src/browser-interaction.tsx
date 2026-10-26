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
  const [address, setAddress] = useState('https://www.google.com/');
  const [textDraft, setTextDraft] = useState('');
  const [insertingText, setInsertingText] = useState(false);
  const draftVersion = useRef(0);
  const current = useRef(state),
    picture = useRef(frame);
  const queue = useRef<Queued[]>([]);
  const wake = useRef(new EventTarget());
  const image = useRef<HTMLImageElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const addressInput = useRef<InputRef>(null);
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
    frameId: string;
    generation: string;
    epoch: number;
  } | null>(null);
  const owns = state.mode === 'human' && state.controllerId === viewId;
  const enqueue = useCallback(
    (item: Queued): boolean => {
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
      if (item && 'action' in item && item.composerVersion !== undefined) {
        setInsertingText(false);
        if (result.input?.effect === 'applied' && draftVersion.current === item.composerVersion)
          setTextDraft('');
      }
      const old = current.current;
      current.current = result.state;
      setState(result.state);
      if (
        old.epoch !== result.state.epoch ||
        old.generation !== result.state.generation ||
        old.controllerId !== result.state.controllerId
      ) {
        queue.current = [];
        setInsertingText(false);
        keyboardId.current = undefined;
        composing.current = false;
        if (keyboard.current) keyboard.current.value = '';
        picture.current = null;
        setFrame(null);
      }
      if (result.keyboardId) keyboardId.current = result.keyboardId;
      if (result.input && !result.keyboardId) {
        keyboardId.current = undefined;
        if (!result.frame) {
          picture.current = null;
          queue.current = [];
          setInsertingText(false);
        }
      }
      if (result.frame) {
        picture.current = result.frame;
        setFrame(result.frame);
      } else if (
        result.error?.code === 'PRIVACY_BLOCKED' ||
        result.error?.code === 'NOT_AUTHORIZED'
      ) {
        picture.current = null;
        setFrame(null);
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
        if (document.visibilityState === 'hidden' && !queue.current.length) {
          await wait(controller.signal, wake.current, 60_000);
          continue;
        }
        // Briefly collect adjacent text commits; keys and pointer actions keep their order.
        const first = queue.current[0];
        if (first && 'action' in first && first.action.type === 'text')
          await wait(controller.signal, new EventTarget(), 35);
        if (controller.signal.aborted) break;
        const item = queue.current.shift();
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
            request = {
              sessionId,
              viewId,
              operation: initialized && control.available ? 'frame' : 'state',
            };
          if (item) setPending(true);
          const result = await client.interactBrowser(request, controller.signal);
          if (controller.signal.aborted) break;
          apply(result, item);
          initialized = true;
        } catch (error) {
          if (controller.signal.aborted) break;
          const status = error instanceof Error && 'status' in error ? error.status : undefined;
          if (status === 501) {
            onUnsupported();
            return;
          }
          initialized = false;
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
            status === 503
              ? 'Managed browser service is temporarily unavailable. Retrying the connection; input was not retried.'
              : 'Connection interrupted. Input was not retried; waiting for a fresh picture…',
          );
          retryDelay = 5000;
        } finally {
          if (!controller.signal.aborted) setPending(false);
        }
        if (!queue.current.length)
          await wait(
            controller.signal,
            wake.current,
            retryDelay || (current.current.mode === 'human' ? 250 : 1000),
          );
      }
    };
    const visible = (): void => {
      if (document.visibilityState === 'hidden') {
        queue.current = [];
        if (current.current.mode === 'human' && current.current.controllerId === viewId)
          enqueue({ operation: 'pause' });
      } else wake.current.dispatchEvent(new Event('change'));
    };
    document.addEventListener('visibilitychange', visible);
    void watch();
    return () => {
      controller.abort();
      queue.current = [];
      document.removeEventListener('visibilitychange', visible);
    };
  }, [client, sessionId, viewId, onUnsupported, enqueue]);
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
      enqueue({
        action: {
          type: 'scroll',
          dx: Math.max(-2000, Math.min(2000, Math.round(event.deltaX))),
          dy: Math.max(-2000, Math.min(2000, Math.round(event.deltaY))),
        },
      });
    };
    node?.addEventListener('wheel', wheel, { passive: false });
    return () => node?.removeEventListener('wheel', wheel);
  }, [enqueue, viewId]);
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
    <Modal title="Browser" open onCancel={onClose} footer={null} width={1120} destroyOnHidden>
      <Space wrap className="browser-control-toolbar">
        <Button disabled={pending} onClick={() => enqueue({ operation: 'state' })}>
          Retry connection
        </Button>
        <Button
          type={owns ? 'default' : 'primary'}
          disabled={pending || (state.mode === 'human' && !owns)}
          onClick={() => enqueue({ operation: 'take' })}
        >
          {state.available ? 'Take control' : 'Start browser'}
        </Button>
        <Button
          disabled={pending || !state.available || (state.mode === 'human' && !owns)}
          onClick={() => enqueue({ operation: 'release' })}
        >
          Return control to agent
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
      <p role="status" aria-live="polite">
        {pending ? 'Applying browser action…' : message}
      </p>
      <Input.Search
        ref={addressInput}
        aria-label="Browser address"
        value={address}
        disabled={!owns || pending}
        onChange={(event) => setAddress(event.target.value)}
        enterButton="Go"
        onSearch={() => {
          try {
            const url = new URL(address.includes('://') ? address : `https://${address}`);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
              throw new Error('invalid');
            enqueue({ action: { type: 'navigate', url: url.href } });
          } catch {
            setMessage('Enter an HTTP or HTTPS address without credentials.');
          }
        }}
      />
      <div
        ref={viewport}
        aria-busy={pending}
        data-input-sequence={state.nextSequence}
        className={`browser-interactive-viewport${owns ? ' browser-controlled' : ''}`}
      >
        {frame && (
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
              if (!owns || !picture.current) return;
              event.preventDefault();
              keyboard.current?.focus({ preventScroll: true });
              const point = mapBrowserPoint(
                event.currentTarget.getBoundingClientRect(),
                picture.current,
                event.clientX,
                event.clientY,
              );
              if (point)
                pointer.current = {
                  ...point,
                  frameId: picture.current.frameId,
                  generation: picture.current.generation,
                  epoch: picture.current.epoch,
                };
            }}
            onPointerCancel={() => {
              pointer.current = null;
            }}
            onPointerUp={(event) => {
              const from = pointer.current;
              pointer.current = null;
              if (!owns || !from || !picture.current) return;
              const point = mapBrowserPoint(
                event.currentTarget.getBoundingClientRect(),
                picture.current,
                event.clientX,
                event.clientY,
              );
              if (!point) return;
              const previous = lastClick.current;
              const isDrag = Math.hypot(point.x - from.x, point.y - from.y) > 4;
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
        )}
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
      {frame && (
        <p className="browser-preview-meta">
          Last picture{' '}
          <time dateTime={frame.capturedAt}>{new Date(frame.capturedAt).toLocaleTimeString()}</time>{' '}
          · {owns ? 'Click the picture, then type or scroll.' : 'Take control to interact.'}
        </p>
      )}
      <p className="browser-preview-meta">
        Pictures are for you only. Closing or hiding this view while you control the browser pauses
        agent browser actions. Return control explicitly when finished.
      </p>
    </Modal>
  );
}
