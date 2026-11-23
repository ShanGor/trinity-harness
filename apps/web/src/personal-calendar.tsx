import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Flex,
  Input,
  InputNumber,
  List,
  Modal,
  Select,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { AcpClient } from '@trinity-harness/client-acp';
import {
  calendarDefinitionSchema,
  calendarOccurrences,
  calendarOccurrenceDate,
  calendarDateLabel,
  calendarLocalParts,
  calendarDateToGregorian,
  chineseDate,
  newId,
  nextCalendarDefinitionInstant,
  type CalendarDefinition,
  type CalendarRecord,
  type CalendarPreferences,
  type CalendarSnapshot,
  type CalendarReminder,
  type SessionSummary,
} from '@trinity-harness/shared';
import './personal-calendar.css';

type CalendarClient = Pick<
  AcpClient,
  | 'getCalendar'
  | 'saveCalendar'
  | 'saveCalendarPreferences'
  | 'calendarReminderAction'
  | 'subscribeCalendarPush'
>;

function timeLabel(at: string, timezone: string): string {
  return new Date(at).toLocaleString(undefined, {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function CalendarReminderList({
  reminders,
  client,
  onRefresh,
}: {
  reminders: CalendarReminder[];
  client: Pick<AcpClient, 'calendarReminderAction'>;
  onRefresh: () => Promise<void>;
}): ReactElement {
  const [error, setError] = useState('');
  const act = async (id: string, action: 'read' | 'dismiss' | 'snooze'): Promise<void> => {
    try {
      await client.calendarReminderAction(id, {
        action,
        ...(action === 'snooze' ? { minutes: 10 } : {}),
      });
      setError('');
      await onRefresh();
    } catch {
      setError(
        'The reminder changed or its event has passed. Refresh to review its current status.',
      );
    }
  };
  return (
    <section aria-label="Calendar reminders">
      {error && <Alert type="error" message={error} />}
      <List
        dataSource={reminders}
        locale={{ emptyText: 'No calendar reminders' }}
        renderItem={(reminder) => (
          <List.Item
            actions={
              ['delivered', 'missed'].includes(reminder.status)
                ? [
                    ...(!reminder.readAt
                      ? [
                          <Button key="read" onClick={() => void act(reminder.id, 'read')}>
                            Mark read
                          </Button>,
                        ]
                      : []),
                    ...(reminder.status === 'delivered'
                      ? [
                          <Button key="snooze" onClick={() => void act(reminder.id, 'snooze')}>
                            Snooze 10 min
                          </Button>,
                          <Button key="dismiss" onClick={() => void act(reminder.id, 'dismiss')}>
                            Dismiss
                          </Button>,
                        ]
                      : []),
                  ]
                : []
            }
          >
            <List.Item.Meta
              title={
                <>
                  {reminder.title} <Tag>{reminder.status}</Tag>
                </>
              }
              description={
                <>
                  Event: {new Date(reminder.eventAt).toLocaleString()} · Push: {reminder.pushStatus}
                  {reminder.readAt ? ' · Read' : ''}
                </>
              }
            />
          </List.Item>
        )}
      />
    </section>
  );
}

/** Existing Updates destination includes reminders without adding a chat response or new SSE channel. */
export function CalendarUpdates({ client }: { client: CalendarClient }): ReactElement | null {
  const [snapshot, setSnapshot] = useState<CalendarSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async (): Promise<void> => {
    try {
      setSnapshot(await client.getCalendar());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [client]);
  useEffect(() => {
    const cancel = new AbortController();
    void client
      .getCalendar(cancel.signal)
      .then((s) => {
        if (!cancel.signal.aborted) setSnapshot(s);
      })
      .catch(() => {
        if (!cancel.signal.aborted) setFailed(true);
      });
    return () => cancel.abort();
  }, [client]);
  if (failed)
    return (
      <Alert
        type="warning"
        message="Calendar reminders could not be loaded."
        action={<Button onClick={() => void load()}>Refresh reminders</Button>}
      />
    );
  if (!snapshot?.available) return null;
  return (
    <>
      <Typography.Title level={3}>Calendar reminders</Typography.Title>
      <CalendarReminderList client={client} reminders={snapshot.reminders} onRefresh={load} />
    </>
  );
}

function emptyDefinition(preferences: CalendarPreferences): CalendarDefinition {
  const date = calendarLocalParts(new Date(), preferences.timezone).date.split('-').map(Number);
  const definition = calendarDefinitionSchema.parse({
    title: 'New event',
    kind: 'event',
    notes: '',
    timing: {
      date: {
        calendar: 'gregorian',
        year: date[0],
        month: date[1],
        day: date[2],
        leapMonth: false,
      },
      timezone: preferences.timezone,
      hour: 9,
      minute: 0,
      recurrence: 'once',
    },
    reminderMinutes: preferences.defaultReminderMinutes,
  });
  definition.title = '';
  return definition;
}

export function PersonalCalendar({
  client,
  sessions,
  onOpen,
  onOpenScheduled,
}: {
  client: CalendarClient;
  sessions: SessionSummary[];
  onOpen: (id: string) => void;
  onOpenScheduled: () => void;
}): ReactElement {
  const [snapshot, setSnapshot] = useState<CalendarSnapshot | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<{
    original: CalendarRecord | null;
    definition: CalendarDefinition;
    id: string;
    operationId: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [preferences, setPreferences] = useState<CalendarPreferences | null>(null);
  const [reminderDraft, setReminderDraft] = useState('');
  const [defaultReminderDraft, setDefaultReminderDraft] = useState('');
  useEffect(() => {
    setReminderDraft(editing?.definition.reminderMinutes.join(',') ?? '');
  }, [editing?.operationId]);
  useEffect(() => {
    if (preferences) setDefaultReminderDraft(preferences.defaultReminderMinutes.join(','));
  }, [!!preferences]);
  const load = useCallback(async (): Promise<void> => {
    const result = await client.getCalendar();
    setSnapshot(result);
    setError('');
  }, [client]);
  useEffect(() => {
    const cancel = new AbortController();
    void client
      .getCalendar(cancel.signal)
      .then((result) => {
        if (!cancel.signal.aborted) setSnapshot(result);
      })
      .catch(() => {
        if (!cancel.signal.aborted) setError('Could not load your calendar.');
      });
    return () => cancel.abort();
  }, [client]);
  const refresh = async (): Promise<void> => {
    try {
      await load();
    } catch {
      setError('Could not refresh your calendar.');
    }
  };
  const zone = snapshot?.preferences.timezone ?? 'UTC';
  const monthStart = `${month}-01`;
  const [year, monthNumber] = month.split('-').map(Number);
  const nextMonth = new Date(Date.UTC(year!, monthNumber!, 1)).toISOString().slice(0, 10);
  const from = new Date(`${monthStart}T00:00:00Z`);
  const projected = useMemo(
    () =>
      calendarOccurrences(
        snapshot?.items ?? [],
        new Date(from.getTime() - 86400000),
        new Date(`${nextMonth}T23:59:59Z`),
      ),
    [snapshot, monthStart, nextMonth],
  );
  const occurrences = projected.occurrences.filter((o) =>
    calendarOccurrenceDate(o, zone).startsWith(month),
  );
  const conflictIds = new Set(
    occurrences
      .filter(
        (a, i) =>
          a.item.definition.kind === 'event' &&
          !a.item.definition.timing.allDay &&
          occurrences.some(
            (b, j) =>
              i !== j &&
              b.item.definition.kind === 'event' &&
              !b.item.definition.timing.allDay &&
              (a.at === b.at || (a.at < b.endAt && a.endAt > b.at)),
          ),
      )
      .map((o) => o.item.id),
  );
  const act = async (item: CalendarRecord, status: CalendarRecord['status']): Promise<void> => {
    setSaving(true);
    try {
      await client.saveCalendar({
        operationId: newId(),
        id: item.id,
        expectedRevision: item.revision,
        definition: item.definition,
        status,
      });
      await load();
    } catch {
      setError(
        'The calendar item changed or has no future occurrence. Refresh and review before trying again.',
      );
    } finally {
      setSaving(false);
    }
  };
  const patch = (change: Partial<CalendarDefinition>): void =>
    setEditing((e) => (e ? { ...e, definition: { ...e.definition, ...change } } : e));
  const timing = (change: Partial<CalendarDefinition['timing']>): void =>
    setEditing((e) =>
      e
        ? { ...e, definition: { ...e.definition, timing: { ...e.definition.timing, ...change } } }
        : e,
    );
  const begin = (): void => {
    if (!snapshot) return;
    const date = calendarLocalParts(new Date(), zone).date.split('-').map(Number);
    // A blank title is an editor draft; validate only on Save.
    const definition = emptyDefinition({ ...snapshot.preferences });
    definition.timing.date = {
      calendar: 'gregorian',
      year: date[0]!,
      month: date[1]!,
      day: date[2]!,
      leapMonth: false,
    };
    setEditing({ original: null, definition, id: newId(), operationId: newId() });
  };
  const push = async (): Promise<void> => {
    try {
      if (!snapshot?.pushPublicKey || !('serviceWorker' in navigator) || !('PushManager' in window))
        throw new Error('unavailable');
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('permission');
      const registration = await navigator.serviceWorker.register('/calendar-sw.js', {
        scope: '/',
      });
      await navigator.serviceWorker.ready;
      const bytes = Uint8Array.from(
        atob(snapshot.pushPublicKey.replace(/-/g, '+').replace(/_/g, '/')),
        (c) => c.charCodeAt(0),
      );
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: bytes,
        }));
      const json = subscription.toJSON();
      await client.subscribeCalendarPush({
        endpoint: subscription.endpoint,
        keys: { p256dh: json.keys!['p256dh']!, auth: json.keys!['auth']! },
      });
      const savedPreferences = await client.saveCalendarPreferences({
        ...snapshot.preferences,
        pushEnabled: true,
      });
      setPreferences((draft) =>
        draft
          ? { ...draft, pushEnabled: true, revision: savedPreferences.revision }
          : savedPreferences,
      );
      await load();
    } catch {
      setError(
        'Could not enable closed-app notifications. Check browser permission and server Web Push configuration.',
      );
    }
  };
  const record = (item: CalendarRecord): ReactElement => (
    <List.Item
      key={item.id}
      actions={[
        <Button
          key="edit"
          onClick={() =>
            setEditing({
              original: item,
              definition: structuredClone(item.definition),
              id: item.id,
              operationId: newId(),
            })
          }
        >
          Edit
        </Button>,
        ...(item.status === 'suggested'
          ? [
              <Button key="accept" disabled={saving} onClick={() => void act(item, 'active')}>
                {item.definition.kind === 'task' ? 'Accept and enable task' : 'Accept'}
              </Button>,
            ]
          : []),
        ...(['active', 'paused'].includes(item.status)
          ? [
              <Button
                key="pause"
                disabled={saving}
                onClick={() => void act(item, item.status === 'paused' ? 'active' : 'paused')}
              >
                {item.status === 'paused' ? 'Resume' : 'Pause'}
              </Button>,
              <Button key="complete" disabled={saving} onClick={() => void act(item, 'completed')}>
                {item.definition.timing.recurrence === 'once' ? 'Complete' : 'Complete series'}
              </Button>,
            ]
          : []),
        ...(!['cancelled', 'completed'].includes(item.status)
          ? [
              <Button key="cancel" disabled={saving} onClick={() => void act(item, 'cancelled')}>
                {item.status === 'suggested' ? 'Dismiss suggestion' : 'Cancel item'}
              </Button>,
            ]
          : []),
      ]}
    >
      <List.Item.Meta
        title={
          <>
            {item.definition.title} <Tag>{item.definition.kind}</Tag>
            <Tag>{item.status}</Tag>
            {conflictIds.has(item.id) && <Tag color="warning">Time conflict</Tag>}
          </>
        }
        description={
          <>
            <div>
              {calendarDateLabel(item.definition.timing.date)} · {item.definition.timing.recurrence}{' '}
              · {item.definition.timing.timezone}
              {item.definition.timing.allDay ? ' · All day' : ''}
            </div>
            {item.nextAt && (
              <div>Next: {timeLabel(item.nextAt, item.definition.timing.timezone)}</div>
            )}
            {item.definition.timing.date.calendar === 'chinese' && (
              <div>
                Leap month: {item.definition.timing.leapMonthPolicy} · Missing day:{' '}
                {item.definition.timing.missingDay}
              </div>
            )}
            <div>{item.definition.notes}</div>
            {item.source ? (
              <>
                <Button type="link" onClick={() => onOpen(item.source!.sessionId)}>
                  Source conversation · {item.source.capture}
                </Button>
                <blockquote>{item.source.quote}</blockquote>
              </>
            ) : (
              <span>Added in Calendar</span>
            )}
            {item.scheduleId && (
              <Button type="link" onClick={onOpenScheduled}>
                Scheduled task and run history
              </Button>
            )}
          </>
        }
      />
    </List.Item>
  );
  const draft = editing?.definition;
  let nextPreview: Date | null = null;
  if (draft) {
    const parsed = calendarDefinitionSchema.safeParse(draft);
    if (parsed.success) nextPreview = nextCalendarDefinitionInstant(parsed.data, new Date());
  }
  return (
    <section className="personal-calendar" aria-label="Personal calendar">
      <Flex justify="space-between" wrap gap={8}>
        <Typography.Title level={2}>Calendar</Typography.Title>
        <Flex gap={8} wrap>
          <Button onClick={() => void refresh()}>Refresh calendar</Button>
          <Button onClick={onOpenScheduled}>Scheduled tasks</Button>
          <Button
            onClick={() => setPreferences(snapshot?.preferences ?? null)}
            disabled={!snapshot?.available}
          >
            Preferences
          </Button>
          <Button type="primary" onClick={begin} disabled={!snapshot?.available}>
            Add calendar item
          </Button>
        </Flex>
      </Flex>
      {error && <Alert type="error" message={error} closable onClose={() => setError('')} />}
      {snapshot && !snapshot.available && (
        <Alert type="info" message="Calendar is unavailable in this deployment." />
      )}
      {snapshot?.available && (
        <>
          <Flex gap={12} align="center" wrap>
            <label>
              Month{' '}
              <Input
                aria-label="Calendar month"
                type="month"
                value={month}
                min="1901-01"
                max="2100-12"
                onChange={(e) => {
                  if (
                    /^\d{4}-\d{2}$/.test(e.target.value) &&
                    e.target.value >= '1901-01' &&
                    e.target.value <= '2100-12'
                  )
                    setMonth(e.target.value);
                }}
              />
            </label>
            <span>
              {zone} · Automatic capture {snapshot.preferences.automaticCapture ? 'on' : 'off'} ·
              Closed-app push{' '}
              {snapshot.pushAvailable
                ? snapshot.preferences.pushEnabled
                  ? 'enabled'
                  : 'available'
                : 'unavailable'}
            </span>
          </Flex>
          {projected.truncated && (
            <Alert
              type="warning"
              message="This month exceeds the display limit. Some occurrences are omitted."
            />
          )}
          <Tabs
            items={[
              {
                key: 'agenda',
                label: 'Agenda',
                children: (
                  <List
                    dataSource={occurrences}
                    locale={{ emptyText: 'No commitments this month' }}
                    renderItem={(o) => (
                      <List.Item key={`${o.item.id}:${o.at}`}>
                        <List.Item.Meta
                          title={o.item.definition.title}
                          description={`${o.item.definition.timing.allDay ? calendarOccurrenceDate(o, zone) + ' · All day' : timeLabel(o.at, zone)} · ${o.item.definition.kind} · ${o.item.status}`}
                        />
                        <Button
                          onClick={() =>
                            setEditing({
                              original: o.item,
                              definition: structuredClone(o.item.definition),
                              id: o.item.id,
                              operationId: newId(),
                            })
                          }
                        >
                          Open item
                        </Button>
                      </List.Item>
                    )}
                  />
                ),
              },
              {
                key: 'month',
                label: 'Month',
                children: (
                  <div className="calendar-grid" role="table" aria-label="Calendar month grid">
                    <div className="calendar-row" role="row">
                      {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                        <div key={day} role="columnheader">
                          {day}
                        </div>
                      ))}
                    </div>
                    {Array.from(
                      {
                        length: Math.ceil(
                          (from.getUTCDay() +
                            new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate()) /
                            7,
                        ),
                      },
                      (_, week) => (
                        <div className="calendar-row" role="row" key={week}>
                          {Array.from({ length: 7 }, (_, weekday) => {
                            const day = week * 7 + weekday - from.getUTCDay() + 1;
                            if (
                              day < 1 ||
                              day > new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate()
                            )
                              return <div role="cell" key={weekday} className="calendar-empty" />;
                            const date = `${month}-${String(day).padStart(2, '0')}`;
                            const lunar = snapshot.preferences.showLunar ? chineseDate(date) : null;
                            return (
                              <div key={weekday} role="cell" aria-label={date}>
                                <strong>{day}</strong>
                                {lunar && (
                                  <small>
                                    {lunar.leapMonth ? '閏' : ''}
                                    {lunar.month}月{lunar.day}日
                                  </small>
                                )}
                                {occurrences
                                  .filter((o) => calendarOccurrenceDate(o, zone) === date)
                                  .map((o) => (
                                    <button
                                      title={o.item.definition.title}
                                      key={`${o.item.id}:${o.at}`}
                                      onClick={() =>
                                        setEditing({
                                          original: o.item,
                                          definition: structuredClone(o.item.definition),
                                          id: o.item.id,
                                          operationId: newId(),
                                        })
                                      }
                                    >
                                      {o.item.definition.title}
                                    </button>
                                  ))}
                              </div>
                            );
                          })}
                        </div>
                      ),
                    )}
                  </div>
                ),
              },
              {
                key: 'items',
                label: 'All items and suggestions',
                children: (
                  <List
                    dataSource={snapshot.items}
                    renderItem={record}
                    locale={{ emptyText: 'No calendar items yet' }}
                  />
                ),
              },
              {
                key: 'reminders',
                label: `Reminders (${snapshot.reminders.filter((r) => r.status === 'delivered' && !r.readAt).length})`,
                children: (
                  <CalendarReminderList
                    client={client}
                    reminders={snapshot.reminders}
                    onRefresh={load}
                  />
                ),
              },
            ]}
          />
        </>
      )}
      <Modal
        title={editing?.original ? 'Edit calendar item' : 'Add calendar item'}
        open={!!editing}
        onCancel={() => setEditing(null)}
        confirmLoading={saving}
        okText="Save calendar item"
        onOk={() =>
          void (async () => {
            if (!editing) return;
            const parsed = calendarDefinitionSchema.safeParse({
              ...editing.definition,
              reminderMinutes: reminderDraft.trim()
                ? reminderDraft.split(',').map((v) => Number(v.trim()))
                : [],
            });
            if (!parsed.success) {
              setError('Check the title, date, recurrence and task workspace.');
              return;
            }
            setSaving(true);
            try {
              await client.saveCalendar({
                operationId: editing.operationId,
                id: editing.id,
                expectedRevision: editing.original?.revision ?? 0,
                definition: parsed.data,
                status: editing.original?.status ?? 'active',
              });
              setEditing(null);
              await load();
            } catch {
              setError(
                'Could not save. The item may have changed or the date has no future occurrence. Your draft is preserved.',
              );
            } finally {
              setSaving(false);
            }
          })()
        }
      >
        {draft && (
          <div className="calendar-form">
            <label>
              Title
              <Input
                aria-label="Calendar title"
                value={draft.title}
                maxLength={200}
                onChange={(e) => patch({ title: e.target.value })}
              />
            </label>
            <label>
              Type
              <Select
                aria-label="Calendar item type"
                value={draft.kind}
                options={['event', 'deadline', 'reminder', 'task'].map((value) => ({
                  value,
                  label: value === 'task' ? 'Agent task' : value,
                }))}
                onChange={(kind) =>
                  patch({
                    kind,
                    task:
                      kind === 'task'
                        ? {
                            request: '',
                            sourceSessionId:
                              sessions.find((s) => s.scope === 'personal' && !s.scheduledRun)
                                ?.sessionId ?? '',
                          }
                        : undefined,
                  })
                }
              />
            </label>
            <label>
              Calendar system
              <Select
                aria-label="Calendar system"
                disabled={!!draft.task?.relatedItemId}
                value={draft.timing.date.calendar}
                options={[
                  { value: 'gregorian', label: 'Gregorian 公曆' },
                  { value: 'chinese', label: 'Chinese lunar 農曆' },
                ]}
                onChange={(calendar) => {
                  const converted = calendarDateToGregorian(draft.timing.date);
                  const date =
                    calendar === 'chinese' && converted
                      ? chineseDate(converted)
                      : converted
                        ? {
                            calendar: 'gregorian' as const,
                            year: Number(converted.slice(0, 4)),
                            month: Number(converted.slice(5, 7)),
                            day: Number(converted.slice(8, 10)),
                            leapMonth: false,
                          }
                        : { ...draft.timing.date, calendar, leapMonth: false };
                  timing({
                    date,
                    recurrence:
                      calendar === 'chinese' &&
                      !['once', 'yearly'].includes(draft.timing.recurrence)
                        ? 'yearly'
                        : draft.timing.recurrence,
                  });
                }}
              />
            </label>
            <Flex gap={8} wrap>
              {(['year', 'month', 'day'] as const).map((part) => (
                <label key={part}>
                  {part}
                  <InputNumber
                    aria-label={`Calendar ${part}`}
                    disabled={!!draft.task?.relatedItemId}
                    min={part === 'year' ? 1901 : 1}
                    max={
                      part === 'year'
                        ? 2100
                        : part === 'month'
                          ? 12
                          : draft.timing.date.calendar === 'chinese'
                            ? 30
                            : 31
                    }
                    value={draft.timing.date[part]}
                    onChange={(value) =>
                      timing({
                        date: { ...draft.timing.date, [part]: value ?? draft.timing.date[part] },
                      })
                    }
                  />
                </label>
              ))}
            </Flex>
            {draft.timing.date.calendar === 'chinese' && (
              <>
                <Checkbox
                  disabled={!!draft.task?.relatedItemId}
                  checked={draft.timing.date.leapMonth}
                  onChange={(e) =>
                    timing({ date: { ...draft.timing.date, leapMonth: e.target.checked } })
                  }
                >
                  Leap lunar month 閏月
                </Checkbox>
                <label>
                  Leap-month recurrence
                  <Select
                    aria-label="Leap month policy"
                    disabled={!!draft.task?.relatedItemId}
                    value={draft.timing.leapMonthPolicy}
                    options={[
                      { value: 'strict', label: 'Only the specified regular or leap month' },
                      {
                        value: 'regular_if_absent',
                        label: 'Use regular month when leap month is absent',
                      },
                      { value: 'both', label: 'Both regular and leap months' },
                    ]}
                    onChange={(leapMonthPolicy) => timing({ leapMonthPolicy })}
                  />
                </label>
              </>
            )}
            <label>
              Timezone
              <Input
                aria-label="Calendar timezone"
                disabled={!!draft.task?.relatedItemId}
                value={draft.timing.timezone}
                onChange={(e) => timing({ timezone: e.target.value })}
              />
            </label>
            <Checkbox
              disabled={draft.kind === 'task'}
              checked={draft.timing.allDay}
              onChange={(e) => timing({ allDay: e.target.checked })}
            >
              All day
            </Checkbox>
            <label>
              {draft.timing.allDay ? 'Reminder time on this date' : 'Start time'}
              <Input
                aria-label="Calendar time"
                disabled={!!draft.task?.relatedItemId}
                type="time"
                value={`${String(draft.timing.hour).padStart(2, '0')}:${String(draft.timing.minute).padStart(2, '0')}`}
                onChange={(e) => {
                  const [hour, minute] = e.target.value.split(':').map(Number);
                  if (Number.isInteger(hour) && Number.isInteger(minute)) timing({ hour, minute });
                }}
              />
            </label>
            <label>
              Duration in minutes
              <InputNumber
                aria-label="Calendar duration"
                min={0}
                max={10080}
                value={draft.timing.durationMinutes}
                onChange={(value) => timing({ durationMinutes: value ?? 0 })}
              />
            </label>
            <label>
              Repeat
              <Select
                aria-label="Calendar repeat"
                disabled={!!draft.task?.relatedItemId}
                value={draft.timing.recurrence}
                options={(draft.timing.date.calendar === 'chinese'
                  ? ['once', 'yearly']
                  : ['once', 'daily', 'weekly', 'monthly', 'yearly']
                ).map((value) => ({ value, label: value }))}
                onChange={(recurrence) => timing({ recurrence })}
              />
            </label>
            {draft.timing.recurrence === 'weekly' && (
              <label>
                Weekdays
                <Select
                  mode="multiple"
                  aria-label="Calendar weekdays"
                  disabled={!!draft.task?.relatedItemId}
                  value={draft.timing.weekdays}
                  options={['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(
                    (label, value) => ({ value, label }),
                  )}
                  onChange={(weekdays) => timing({ weekdays })}
                />
              </label>
            )}
            {draft.timing.recurrence !== 'once' && (
              <>
                <label>
                  Repeat until (optional)
                  <Input
                    aria-label="Calendar recurrence end"
                    disabled={!!draft.task?.relatedItemId}
                    type="date"
                    value={draft.timing.until ?? ''}
                    onChange={(e) => timing({ until: e.target.value || undefined })}
                  />
                </label>
                <label>
                  Missing day
                  <Select
                    aria-label="Missing day policy"
                    disabled={!!draft.task?.relatedItemId}
                    value={draft.timing.missingDay}
                    options={[
                      { value: 'skip', label: 'Skip this occurrence' },
                      { value: 'last_day', label: 'Use the last day of the month' },
                    ]}
                    onChange={(missingDay) => timing({ missingDay })}
                  />
                </label>
              </>
            )}
            <label>
              Reminders before start (minutes, comma separated)
              <Input
                aria-label="Calendar reminder offsets"
                value={reminderDraft}
                onChange={(e) => setReminderDraft(e.target.value)}
              />
            </label>
            <label>
              Notes
              <Input.TextArea
                aria-label="Calendar notes"
                maxLength={4000}
                value={draft.notes}
                onChange={(e) => patch({ notes: e.target.value })}
              />
            </label>
            {draft.task && (
              <>
                <Alert
                  type="info"
                  message="Saving an active agent task authorizes its scheduled request under normal execution permissions and approvals. Linked tasks follow the commitment’s recorded time; for all-day items this is the reminder time."
                />
                <label>
                  Related event or deadline (optional)
                  <Select
                    aria-label="Related calendar item"
                    allowClear
                    value={draft.task.relatedItemId}
                    options={snapshot?.items
                      .filter(
                        (i) =>
                          i.status === 'active' &&
                          i.definition.kind !== 'task' &&
                          i.id !== editing?.original?.id,
                      )
                      .map((i) => ({ value: i.id, label: i.definition.title }))}
                    onChange={(relatedItemId) => {
                      const related = snapshot?.items.find((i) => i.id === relatedItemId);
                      patch({
                        task: {
                          ...draft.task!,
                          relatedItemId,
                          startBeforeMinutes: relatedItemId
                            ? (draft.task?.startBeforeMinutes ?? 0)
                            : undefined,
                        },
                        ...(related
                          ? {
                              timing: {
                                ...related.definition.timing,
                                allDay: false,
                                durationMinutes: draft.timing.durationMinutes,
                              },
                            }
                          : {}),
                      });
                    }}
                  />
                </label>
                {draft.task.relatedItemId && (
                  <label>
                    Start minutes before the related commitment
                    <InputNumber
                      aria-label="Preparation lead time"
                      min={0}
                      max={527040}
                      value={draft.task.startBeforeMinutes ?? 0}
                      onChange={(value) =>
                        patch({ task: { ...draft.task!, startBeforeMinutes: value ?? 0 } })
                      }
                    />
                  </label>
                )}
                <label>
                  Task request
                  <Input.TextArea
                    aria-label="Calendar task request"
                    value={draft.task.request}
                    onChange={(e) => patch({ task: { ...draft.task!, request: e.target.value } })}
                  />
                </label>
                <label>
                  Task workspace
                  <Select
                    aria-label="Calendar task workspace"
                    value={draft.task.sourceSessionId || undefined}
                    options={sessions
                      .filter((s) => s.scope === 'personal' && !s.scheduledRun)
                      .map((s) => ({ value: s.sessionId, label: s.title || s.sessionId }))}
                    onChange={(sourceSessionId) =>
                      patch({ task: { ...draft.task!, sourceSessionId } })
                    }
                  />
                </label>
              </>
            )}
            <Alert
              type={nextPreview ? 'info' : 'warning'}
              message={
                nextPreview
                  ? `Next: ${timeLabel(nextPreview.toISOString(), draft.timing.timezone)} · ${draft.timing.timezone}`
                  : 'No valid future occurrence. Check the date and time.'
              }
              description={
                draft.timing.date.calendar === 'chinese'
                  ? `${calendarDateLabel(draft.timing.date)} · Gregorian: ${calendarDateToGregorian(draft.timing.date) ?? (draft.timing.recurrence === 'yearly' ? 'No matching date in the starting year; the recurrence policy selects future dates.' : 'invalid lunar date')}`
                  : undefined
              }
            />
          </div>
        )}
      </Modal>
      <Modal
        title="Calendar preferences"
        open={!!preferences}
        onCancel={() => setPreferences(null)}
        okText="Save preferences"
        onOk={() =>
          void (async () => {
            if (!preferences) return;
            try {
              await client.saveCalendarPreferences({
                ...preferences,
                defaultReminderMinutes: defaultReminderDraft.trim()
                  ? defaultReminderDraft.split(',').map((v) => Number(v.trim()))
                  : [],
              });
              setPreferences(null);
              await load();
            } catch {
              setError('Could not save preferences. Refresh to review the current revision.');
            }
          })()
        }
      >
        {preferences && (
          <div className="calendar-form">
            <Checkbox
              checked={preferences.automaticCapture}
              onChange={(e) =>
                setPreferences({ ...preferences, automaticCapture: e.target.checked })
              }
            >
              Automatically capture definite commitments
            </Checkbox>
            <p>
              Capture records commitments and reminders. Agent work still requires explicit
              delegation.
            </p>
            <Checkbox
              checked={preferences.showLunar}
              onChange={(e) => setPreferences({ ...preferences, showLunar: e.target.checked })}
            >
              Show Chinese lunar dates 農曆
            </Checkbox>
            <label>
              Default timezone
              <Input
                aria-label="Default calendar timezone"
                value={preferences.timezone}
                onChange={(e) => setPreferences({ ...preferences, timezone: e.target.value })}
              />
            </label>
            <label>
              Default reminders (minutes before)
              <Input
                aria-label="Default calendar reminders"
                value={defaultReminderDraft}
                onChange={(e) => setDefaultReminderDraft(e.target.value)}
              />
            </label>
            <Checkbox
              checked={!!preferences.quietHours}
              onChange={(e) =>
                setPreferences({
                  ...preferences,
                  quietHours: e.target.checked ? { startHour: 22, endHour: 8 } : null,
                })
              }
            >
              Quiet hours for external notifications
            </Checkbox>
            {preferences.quietHours && (
              <Flex gap={8}>
                <label>
                  Start hour
                  <InputNumber
                    min={0}
                    max={23}
                    value={preferences.quietHours.startHour}
                    onChange={(v) =>
                      setPreferences({
                        ...preferences,
                        quietHours: { ...preferences.quietHours!, startHour: v ?? 22 },
                      })
                    }
                  />
                </label>
                <label>
                  End hour
                  <InputNumber
                    min={0}
                    max={23}
                    value={preferences.quietHours.endHour}
                    onChange={(v) =>
                      setPreferences({
                        ...preferences,
                        quietHours: { ...preferences.quietHours!, endHour: v ?? 8 },
                      })
                    }
                  />
                </label>
              </Flex>
            )}
            <p>
              {snapshot?.pushAvailable
                ? 'Web Push is configured. This browser needs notification permission.'
                : 'Closed-app Web Push is unavailable. Reminders remain in Updates.'}
            </p>
            <Button disabled={!snapshot?.pushAvailable} onClick={() => void push()}>
              Enable notifications on this device
            </Button>
            {preferences.pushEnabled && (
              <Button
                onClick={() =>
                  void (async () => {
                    try {
                      await client.subscribeCalendarPush(null);
                      const refreshed = await client.getCalendar();
                      setSnapshot(refreshed);
                      setPreferences((draft) =>
                        draft
                          ? {
                              ...draft,
                              pushEnabled: false,
                              revision: refreshed.preferences.revision,
                            }
                          : refreshed.preferences,
                      );
                    } catch {
                      setError('Could not disconnect notifications.');
                    }
                  })()
                }
              >
                Disconnect notifications
              </Button>
            )}
          </div>
        )}
      </Modal>
    </section>
  );
}
