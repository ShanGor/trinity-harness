import {
  AudioMutedOutlined,
  AudioOutlined,
  MessageOutlined,
  MinusOutlined,
  PhoneOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { Button, Typography } from 'antd';
import { useEffect, useState, type ReactElement } from 'react';

import type { VoiceCallSnapshot, VoiceCallStatus } from './voice-call-controller';

const STATUS_LABELS: Record<VoiceCallStatus, string> = {
  idle: 'Voice call',
  connecting: 'Connecting…',
  listening: 'Listening…',
  transcribing: 'Recognizing speech…',
  thinking: 'Trinity is thinking…',
  speaking: 'Trinity is speaking…',
  error: 'Voice call interrupted',
};

function statusLabel(call: VoiceCallSnapshot): string {
  if (call.muted && call.status === 'listening') return 'Microphone muted';
  return STATUS_LABELS[call.status];
}

function elapsed(startedAt: number | null, now: number): string {
  if (!startedAt) return '00:00';
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function VoiceCallPanel({
  call,
  minimized,
  onMinimize,
  onOpen,
  onShowText,
  onToggleMute,
  onInterrupt,
  onRetry,
  onEnd,
}: {
  call: VoiceCallSnapshot;
  minimized: boolean;
  onMinimize(): void;
  onOpen(): void;
  onShowText(): void;
  onToggleMute(): void;
  onInterrupt(): Promise<void>;
  onRetry(): Promise<void>;
  onEnd(): void;
}): ReactElement | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!call.active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [call.active]);
  if (!call.active) return null;

  if (minimized) {
    return (
      <div className="voice-call-mini" role="region" aria-label="Active voice call">
        <span className={`voice-call-dot voice-call-dot--${call.status}`} aria-hidden="true" />
        <Button
          type="text"
          onClick={onOpen}
          className="voice-call-mini-open"
          aria-label="Open voice call"
        >
          {statusLabel(call)} · {elapsed(call.startedAt, now)}
        </Button>
        <Button
          type="text"
          shape="circle"
          icon={<AudioOutlined />}
          onClick={onShowText}
          aria-label="Show voice call transcript"
        />
        <Button
          type="text"
          shape="circle"
          danger
          icon={<PhoneOutlined rotate={135} />}
          onClick={onEnd}
          aria-label="End voice call"
        />
      </div>
    );
  }

  return (
    <div className="voice-call-overlay">
      <section className="voice-call-panel" role="dialog" aria-label="Trinity voice call">
        <header className="voice-call-header">
          <div>
            <Typography.Text strong>Trinity Voice</Typography.Text>
            <span className="voice-call-time">{elapsed(call.startedAt, now)}</span>
          </div>
          <Button
            type="text"
            shape="circle"
            icon={<MinusOutlined />}
            onClick={onMinimize}
            aria-label="Minimize voice call"
          />
        </header>

        <div className={`voice-call-orb voice-call-orb--${call.status}`} aria-hidden="true">
          <AudioOutlined />
        </div>
        <Typography.Title level={3} className="voice-call-status">
          {statusLabel(call)}
        </Typography.Title>

        <div className="voice-call-captions" aria-live="polite">
          {call.error ? (
            <Typography.Text type="danger">{call.error}</Typography.Text>
          ) : (
            <>
              {call.userText && (
                <p>
                  <strong>You</strong>
                  <span>{call.userText}</span>
                </p>
              )}
              {call.assistantText && (
                <p>
                  <strong>Trinity</strong>
                  <span>{call.assistantText}</span>
                </p>
              )}
              {!call.userText && !call.assistantText && (
                <Typography.Text type="secondary">
                  Speak naturally. Your conversation will also appear in the chat.
                </Typography.Text>
              )}
            </>
          )}
        </div>

        {call.status === 'error' && (
          <Button type="primary" onClick={() => void onRetry()}>
            Reconnect voice call
          </Button>
        )}
        <div className="voice-call-controls">
          <div>
            <Button
              shape="circle"
              icon={call.muted ? <AudioMutedOutlined /> : <AudioOutlined />}
              onClick={onToggleMute}
              disabled={call.status === 'error' || call.status === 'connecting'}
              aria-label={call.muted ? 'Unmute microphone' : 'Mute microphone'}
            />
            <span>{call.muted ? 'Unmute' : 'Mute'}</span>
          </div>
          <div>
            <Button
              shape="circle"
              icon={<StopOutlined />}
              onClick={() => void onInterrupt()}
              disabled={
                call.status === 'error' ||
                call.status === 'connecting' ||
                call.status === 'listening' ||
                call.status === 'transcribing'
              }
              aria-label="Interrupt Trinity"
            />
            <span>Interrupt</span>
          </div>
          <div>
            <Button
              shape="circle"
              icon={<MessageOutlined />}
              onClick={onShowText}
              aria-label="View text conversation"
            />
            <span>Text</span>
          </div>
          <div>
            <Button
              shape="circle"
              danger
              type="primary"
              icon={<PhoneOutlined rotate={135} />}
              onClick={onEnd}
              aria-label="End voice call"
            />
            <span>End</span>
          </div>
        </div>
        <Typography.Text className="voice-call-note" type="secondary">
          Turn-taking mode · playback pauses voice capture
        </Typography.Text>
      </section>
    </div>
  );
}
