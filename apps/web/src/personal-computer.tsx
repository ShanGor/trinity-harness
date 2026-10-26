import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Button, Popconfirm, Select, Space, Typography } from 'antd';
import type { AcpClient, SessionSummary } from '@trinity-harness/client-acp';
import { BrowserActivity } from './browser-activity.js';

type ComputerClient = Pick<
  AcpClient,
  'getEnvironment' | 'changeEnvironment' | 'getBrowserPreview' | 'interactBrowser'
>;
export function PersonalComputer({
  client,
  sessions,
  userId,
  mainSessionId,
  preferredSessionId,
  readOnly,
}: {
  client: ComputerClient;
  sessions: SessionSummary[];
  userId: string;
  mainSessionId: string | null;
  preferredSessionId?: string | null;
  readOnly: boolean;
}): ReactElement {
  const personal = sessions.filter(
    (session) => session.scope === 'personal' && session.userId === userId,
  );
  const [selection, setSelection] = useState<string | undefined>();
  const selected =
    personal.find((session) => session.sessionId === selection)?.sessionId ??
    personal.find((session) => session.sessionId === preferredSessionId)?.sessionId ??
    personal.find((session) => session.sessionId === mainSessionId)?.sessionId ??
    personal[0]?.sessionId;
  const [environment, setEnvironment] = useState<Awaited<
    ReturnType<AcpClient['getEnvironment']>
  > | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const load = useCallback(
    async (action?: 'wake' | 'suspend'): Promise<void> => {
      operation.current?.abort();
      const controller = new AbortController();
      operation.current = controller;
      setPending(true);
      setError('');
      try {
        const result = action
          ? await client.changeEnvironment(action, controller.signal)
          : await client.getEnvironment(controller.signal);
        if (!controller.signal.aborted) setEnvironment(result);
      } catch {
        if (!controller.signal.aborted) {
          setEnvironment(null);
          setError(
            action
              ? 'VM action could not be confirmed. Refresh its status before trying again.'
              : 'Could not load VM status. Try refreshing.',
          );
        }
      } finally {
        if (!controller.signal.aborted) setPending(false);
      }
    },
    [client],
  );
  useEffect(() => {
    void load();
    return () => operation.current?.abort();
  }, [load]);
  return (
    <section className="personal-computer-page" aria-labelledby="computer-title">
      <Typography.Title id="computer-title" level={2}>
        Browser / VM
      </Typography.Title>
      <Typography.Title level={3}>Browser</Typography.Title>
      <p>
        Choose a personal session to open its browser. Your conversation stays where you left it.
      </p>
      <Select
        aria-label="Browser session"
        style={{ minWidth: 260 }}
        value={selected}
        onChange={setSelection}
        options={personal.map((session) => ({
          value: session.sessionId,
          label:
            session.title ||
            (session.sessionId === mainSessionId ? 'Main chat' : 'Untitled session'),
        }))}
      />
      {selected ? (
        <BrowserActivity
          key={selected}
          client={client}
          sessionId={selected}
          running={false}
          standalone
        />
      ) : (
        <p>No personal session is available. Create a Chat or personal Work session first.</p>
      )}
      <Typography.Title level={3}>Virtual machine</Typography.Title>
      <p role="status">
        {error ||
          (environment
            ? !environment.available
              ? 'Personal VMs are unavailable in this deployment.'
              : `VM state: ${environment.environment?.state ?? 'not created'}`
            : 'Loading VM status…')}
      </p>
      {environment?.environment && (
        <p>
          {environment.environment.vcpus} vCPUs · {environment.environment.memoryMiB} MiB memory
        </p>
      )}
      <Space wrap>
        <Button disabled={pending} onClick={() => void load()}>
          Refresh VM status
        </Button>
        <Button
          disabled={
            pending ||
            readOnly ||
            !environment?.available ||
            (!!environment.environment && environment.environment.state !== 'stopped')
          }
          onClick={() => void load('wake')}
        >
          Wake VM
        </Button>
        <Popconfirm
          title="Suspend your VM?"
          description="This stops running commands and the browser. Saved workspace data is retained."
          onConfirm={() => load('suspend')}
        >
          <Button
            disabled={
              pending ||
              readOnly ||
              !environment?.available ||
              !environment.environment ||
              environment.environment.state === 'stopped'
            }
          >
            Suspend VM
          </Button>
        </Popconfirm>
      </Space>
      <p>VM state shows power status. Full VM desktop viewing is not available yet.</p>
    </section>
  );
}
