import { memo, useEffect, useState, type ReactElement } from 'react';
import { Button, Modal } from 'antd';
import type { AcpClient } from '@trinity-harness/client-acp';
import type { BrowserPreview } from '@trinity-harness/shared';

type PreviewClient = Pick<AcpClient, 'getBrowserPreview'>;
type ViewState = BrowserPreview | { state: 'connecting' | 'disconnected' };

/** Cancellable cadence; every request finishes before the next one begins. */
function waitForNext(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const wake = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
    if (wake.aborted) resolve();
    else wake.addEventListener('abort', () => resolve(), { once: true });
  });
}

export const BrowserActivity = memo(function BrowserActivity({
  client,
  sessionId,
  running,
}: {
  client: PreviewClient;
  sessionId: string;
  running: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  const [view, setView] = useState<ViewState>({ state: 'connecting' });
  useEffect(() => {
    const update = (): void => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  useEffect(() => {
    if (!open || !visible) return;
    const controller = new AbortController();
    setView({ state: 'connecting' });
    const watch = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        try {
          const frame = await client.getBrowserPreview(sessionId, controller.signal);
          if (!controller.signal.aborted) setView(frame);
        } catch {
          if (!controller.signal.aborted) setView({ state: 'disconnected' });
        }
        if (!controller.signal.aborted) await waitForNext(controller.signal);
      }
    };
    void watch();
    return () => controller.abort();
  }, [client, sessionId, open, visible]);
  const status = !visible
    ? 'Viewing paused while this tab is hidden'
    : {
        connecting: 'Connecting to browser',
        disconnected: 'Connection interrupted. Retrying…',
        unavailable: 'No active browser available. Viewing does not start a browser.',
        runtime_unavailable:
          'Managed browser service is unavailable. Please contact your administrator.',
        busy: 'Browser is working. Waiting for a fresh picture…',
        privacy_blocked: 'Preview hidden to protect private page information.',
        frame: 'Read-only preview · refreshes between browser operations',
      }[view.state];
  return (
    <section className="browser-activity" aria-label="Browser activity">
      <div>
        <strong>Browser</strong>
        <span>{running ? 'Agent is browsing' : 'Browser activity recorded'}</span>
      </div>
      <Button size="small" onClick={() => setOpen(true)}>
        Open browser
      </Button>
      <Modal
        title="Browser · read-only"
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        width={960}
        destroyOnHidden
      >
        <p role="status">{status}</p>
        {visible && view.state === 'frame' && (
          <>
            <p className="browser-preview-meta">
              Captured{' '}
              <time dateTime={view.capturedAt}>
                {new Date(view.capturedAt).toLocaleTimeString()}
              </time>
              {' · '}
              {view.securityMode === 'trusted-managed'
                ? 'Trusted managed browser'
                : 'Trusted shared browser'}
            </p>
            <img
              className="browser-preview-image"
              alt="Current read-only browser preview"
              width={view.width}
              height={view.height}
              src={`data:image/png;base64,${view.png}`}
            />
          </>
        )}
        <p className="browser-preview-meta">
          Closing this view lets the task continue. Task progress and Stop remain in the
          conversation.
        </p>
      </Modal>
    </section>
  );
});
