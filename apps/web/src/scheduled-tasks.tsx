import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Alert, Button, Form, Input, InputNumber, List, Modal, Select, Typography } from 'antd';
import type { AcpClient, SessionSummary } from '@trinity-harness/client-acp';
import {
  newId,
  nextScheduleInstant,
  type ScheduleRecord,
  type InboxItem,
} from '@trinity-harness/shared';

export function ScheduledTasks({
  client,
  sessions,
  onOpen,
}: {
  client: AcpClient;
  sessions: SessionSummary[];
  onOpen: (id: string) => void;
}): ReactElement {
  const [available, setAvailable] = useState(false);
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const operation = useRef(newId());
  const [form] = Form.useForm<{
    title: string;
    request: string;
    sourceSessionId: string;
    hour: number;
    minute: number;
    timezone: string;
  }>();
  const hour = Form.useWatch('hour', form),
    minute = Form.useWatch('minute', form),
    timezone = Form.useWatch('timezone', form);
  const nextRun = useMemo(() => {
    if (typeof hour !== 'number' || typeof minute !== 'number' || !timezone) return null;
    try {
      return nextScheduleInstant(
        {
          title: 'Preview',
          request: 'Preview',
          sourceSessionId: '00000000-0000-7000-8000-000000000001',
          timezone,
          timing: { kind: 'daily', hour, minute, weekdays: [0, 1, 2, 3, 4, 5, 6] },
        },
        new Date(),
      );
    } catch {
      return null;
    }
  }, [hour, minute, timezone]);
  const load = useCallback(async (): Promise<void> => {
    try {
      const [result, notices] = await Promise.all([client.getSchedules(), client.getInbox()]);
      setAvailable(result.available);
      setSchedules(result.schedules);
      setInbox(notices.items);
      setError('');
    } catch {
      setError('Could not load scheduled tasks. Try refreshing.');
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);
  const change = async (schedule: ScheduleRecord): Promise<void> => {
    try {
      await client.setScheduleEnabled(schedule, !schedule.enabled);
      await load();
    } catch {
      setError('The schedule changed or has no future occurrence. Refresh and try again.');
    }
  };
  return (
    <section className="scheduled-page" aria-labelledby="scheduled-title">
      <Typography.Title id="scheduled-title" level={2}>
        Scheduled tasks
      </Typography.Title>
      {error && <Alert type="error" message={error} />}
      {!available ? (
        <Typography.Paragraph>
          Scheduling isn’t available yet in this deployment.
        </Typography.Paragraph>
      ) : (
        <>
          <Typography.Paragraph>
            Daily delegations run in the selected personal workspace, even when you close this page.
            Missed and overlapping runs are skipped. Actions still require the task’s normal
            permissions and approvals.
          </Typography.Paragraph>
          <Button
            type="primary"
            onClick={() => {
              operation.current = newId();
              setCreating(true);
            }}
          >
            New schedule
          </Button>
          <Button onClick={() => void load()}>Refresh</Button>
          <List
            dataSource={schedules}
            locale={{ emptyText: 'No scheduled tasks' }}
            renderItem={(schedule) => (
              <List.Item
                actions={[
                  <Button key="toggle" onClick={() => void change(schedule)}>
                    {schedule.enabled ? 'Pause' : 'Resume'}
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={schedule.title}
                  description={
                    <>
                      <p>{schedule.request}</p>
                      <span>
                        {schedule.enabled ? 'Enabled' : 'Paused'} · {schedule.timezone} · Next:{' '}
                        {schedule.nextFireAt
                          ? new Date(schedule.nextFireAt).toLocaleString(undefined, {
                              timeZone: schedule.timezone,
                            })
                          : 'none'}
                      </span>
                    </>
                  }
                />
              </List.Item>
            )}
          />
          <Typography.Title level={3}>Updates</Typography.Title>
          <List
            dataSource={inbox}
            locale={{ emptyText: 'Task updates will appear here' }}
            renderItem={(item) => (
              <List.Item
                actions={[
                  ...(item.sessionId
                    ? [
                        <Button
                          key="open"
                          onClick={() => {
                            void client.acknowledgeNotification(item.id).then(load);
                            onOpen(item.sessionId!);
                          }}
                        >
                          Open task
                        </Button>,
                      ]
                    : []),
                  ...(!item.readAt
                    ? [
                        <Button
                          key="read"
                          onClick={() => void client.acknowledgeNotification(item.id).then(load)}
                        >
                          Mark read
                        </Button>,
                      ]
                    : []),
                ]}
              >
                <List.Item.Meta
                  title={`${item.readAt ? '' : '● '}${item.title}`}
                  description={`${item.status} · ${item.reason ?? ''} · ${new Date(item.at).toLocaleString()}`}
                />
              </List.Item>
            )}
          />
        </>
      )}
      <Modal
        title="Create daily schedule"
        open={creating}
        confirmLoading={saving}
        onCancel={() => setCreating(false)}
        onOk={() => form.submit()}
        okText="Enable schedule"
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            hour: 9,
            minute: 0,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }}
          onFinish={async (values) => {
            setSaving(true);
            try {
              await client.createSchedule({
                title: values.title,
                request: values.request,
                sourceSessionId: values.sourceSessionId,
                timezone: values.timezone,
                operationId: operation.current,
                timing: {
                  kind: 'daily',
                  hour: values.hour,
                  minute: values.minute,
                  weekdays: [0, 1, 2, 3, 4, 5, 6],
                },
              });
              setCreating(false);
              form.resetFields();
              await load();
            } catch {
              setError(
                'Could not create this schedule. Check its timezone and personal Work source.',
              );
            } finally {
              setSaving(false);
            }
          }}
        >
          <Form.Item name="title" label="Name" rules={[{ required: true, max: 200 }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="request"
            label="What should your assistant do?"
            rules={[{ required: true, max: 20_000 }]}
          >
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item
            name="sourceSessionId"
            label="Personal Work workspace and permissions"
            rules={[{ required: true }]}
          >
            <Select
              options={sessions
                .filter((s) => s.kind === 'work' && s.scope === 'personal')
                .map((s) => ({ value: s.sessionId, label: s.title }))}
            />
          </Form.Item>
          <Form.Item name="hour" label="Hour (0–23)" rules={[{ required: true }]}>
            <InputNumber min={0} max={23} />
          </Form.Item>
          <Form.Item name="minute" label="Minute" rules={[{ required: true }]}>
            <InputNumber min={0} max={59} />
          </Form.Item>
          <Form.Item name="timezone" label="Timezone" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          {nextRun && (
            <Typography.Paragraph>
              Next run: {nextRun.toLocaleString(undefined, { timeZone: timezone })} ({timezone})
            </Typography.Paragraph>
          )}
          <Typography.Paragraph type="secondary">
            Enabling authorizes this request to run daily at the selected local time. Each run
            appears as a separate task. Pausing prevents future runs; use Stop inside a task to
            cancel an active run.
          </Typography.Paragraph>
        </Form>
      </Modal>
    </section>
  );
}
