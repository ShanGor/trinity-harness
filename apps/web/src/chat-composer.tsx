import { memo, useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { App as AntdApp, Button, Flex } from 'antd';
import { AudioOutlined, PhoneOutlined, StopOutlined } from '@ant-design/icons';
import { Sender } from '@ant-design/x';
import { PretextTextArea } from './pretext-textarea';

const senderComponents = { input: PretextTextArea };

/**
 * Energy-based voice activity detection: recording stops by itself once the
 * microphone has been silent for this long (mirrors the VAD split of the
 * Fun-ASR service, FUNASR_VAD_SPLIT_SILENCE_MS).
 */
const SILENCE_TIMEOUT_MS = 2_000;
/** RMS level below which the input counts as silence (16-bit full scale ≈ 1). */
const SILENCE_RMS = 0.02;
/** Hard cap so a stuck VAD state cannot record forever. */
const MAX_RECORDING_MS = 60_000;
const VAD_POLL_MS = 150;

export const ChatComposer = memo(function ChatComposer({
  busy,
  draftKey = 'new',
  canQueue = false,
  draftStore,
  draftOwner,
  placeholder = 'Ask anything…',
  resetVersion,
  voiceTranscribe,
  onStartVoiceCall,
  voiceCallDisabled = false,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  draftKey?: string;
  canQueue?: boolean;
  draftStore?: Map<string, string>;
  draftOwner?: string;
  placeholder?: string;
  resetVersion: number;
  /**
   * Voice input (docs/design.md §10): when provided, a mic button is shown.
   * Click to record; recording stops on a second click, after 2 s of
   * silence (VAD), or after a hard duration cap. The transcript is appended
   * to the draft so the user can review/edit before sending.
   */
  voiceTranscribe?: (blob: Blob) => Promise<string>;
  onStartVoiceCall?: () => void;
  voiceCallDisabled?: boolean;
  onSubmit: (text: string) => void | Promise<boolean | void>;
  onCancel: () => void;
}): ReactElement {
  const [input, setInput] = useState('');
  const submitting = useRef(false);
  const drafts = useRef(draftStore ?? new Map<string, string>());
  const currentKey = useRef(draftKey);
  currentKey.current = draftKey;
  const { message } = AntdApp.useApp();

  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const vadRef = useRef<{ context: AudioContext; timer: ReturnType<typeof setInterval> } | null>(
    null,
  );
  const lastVoiceAtRef = useRef(0);
  const recordingStartedAtRef = useRef(0);

  const persistDraft = useCallback(
    (key: string, value: string) => {
      drafts.current.set(key, value);
      if (draftOwner) sessionStorage.setItem(`trinity.draft:${draftOwner}:${key}`, value);
    },
    [draftOwner],
  );

  useEffect(() => {
    const saved =
      drafts.current.get(draftKey) ??
      (draftOwner ? sessionStorage.getItem(`trinity.draft:${draftOwner}:${draftKey}`) : null) ??
      '';
    drafts.current.set(draftKey, saved);
    setInput(saved);
  }, [draftKey, draftOwner]);

  useEffect(() => {
    setInput('');
  }, [resetVersion]);

  const stopVad = useCallback(() => {
    const vad = vadRef.current;
    vadRef.current = null;
    if (!vad) return;
    clearInterval(vad.timer);
    void vad.context.close();
  }, []);

  // Drop any in-flight recording when the composer unmounts.
  useEffect(
    () => () => {
      stopVad();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    },
    [stopVad],
  );

  const stopVoiceRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    setIsRecording(false);
    stopVad();
    if (!recorder) return;
    const stopped = new Promise<void>((resolve) =>
      recorder.addEventListener('stop', () => resolve(), { once: true }),
    );
    if (recorder.state !== 'inactive') recorder.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    await stopped;
    const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
    chunksRef.current = [];
    if (blob.size === 0 || !voiceTranscribe) return;
    setIsTranscribing(true);
    try {
      const transcript = (await voiceTranscribe(blob)).trim();
      if (transcript) {
        setInput((previous) => {
          const next = previous.trim() ? `${previous.trimEnd()} ${transcript}` : transcript;
          persistDraft(currentKey.current, next);
          return next;
        });
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Speech transcription failed.');
    } finally {
      setIsTranscribing(false);
    }
  }, [voiceTranscribe, message, persistDraft, stopVad]);

  const startVoiceRecording = useCallback(async () => {
    if (!voiceTranscribe || recorderRef.current || isTranscribing) return;
    if (!window.isSecureContext) {
      // getUserMedia/MediaRecorder are secure-context-only APIs: they are
      // hidden on plain-HTTP origins other than localhost, which surfaces as
      // "unsupported" — say so instead of blaming the browser.
      message.error(
        'Voice input requires a secure context: open Trinity via https:// or localhost.',
      );
      return;
    }
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      message.error('This browser does not support microphone recording.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : undefined;
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      });
      recorderRef.current = recorder;
      streamRef.current = stream;
      recordingStartedAtRef.current = Date.now();
      lastVoiceAtRef.current = Date.now();
      recorder.start();

      // VAD: poll the microphone level; auto-stop after sustained silence.
      const context = new AudioContext();
      void context.resume();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const levels = new Uint8Array(analyser.fftSize);
      const timer = setInterval(() => {
        analyser.getByteTimeDomainData(levels);
        let sum = 0;
        for (const level of levels) {
          const centered = (level - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / levels.length);
        const now = Date.now();
        if (rms >= SILENCE_RMS) lastVoiceAtRef.current = now;
        if (
          now - lastVoiceAtRef.current >= SILENCE_TIMEOUT_MS ||
          now - recordingStartedAtRef.current >= MAX_RECORDING_MS
        ) {
          void stopVoiceRecording();
        }
      }, VAD_POLL_MS);
      vadRef.current = { context, timer };
      setIsRecording(true);
    } catch {
      message.error('Microphone access was denied.');
    }
  }, [voiceTranscribe, isTranscribing, message, stopVoiceRecording]);

  return (
    <Flex gap={8} align="center">
      <div className="chat-composer-sender">
        <Sender
          components={senderComponents}
          value={input}
          onChange={(value) => {
            persistDraft(draftKey, value);
            setInput(value);
          }}
          onSubmit={(text) => {
            if ((busy && !canQueue) || submitting.current) return;
            submitting.current = true;
            const key = draftKey;
            void Promise.resolve(onSubmit(text))
              .then((accepted) => {
                if (accepted === false) return;
                if (drafts.current.get(key) === text) {
                  drafts.current.delete(key);
                  if (draftOwner) sessionStorage.removeItem(`trinity.draft:${draftOwner}:${key}`);
                }
                if (currentKey.current === key) setInput((value) => (value === text ? '' : value));
              })
              .finally(() => {
                submitting.current = false;
              });
          }}
          onCancel={onCancel}
          loading={busy && !canQueue}
          placeholder={placeholder}
        />
      </div>
      {onStartVoiceCall && (
        <Button
          className="composer-call-button"
          shape="circle"
          type="text"
          icon={<PhoneOutlined />}
          onClick={onStartVoiceCall}
          disabled={voiceCallDisabled || isRecording || isTranscribing}
          aria-label="Start voice call"
          title="Start voice call"
        />
      )}
      {voiceTranscribe && (
        <Button
          className="composer-mic-button"
          shape="circle"
          type={isRecording ? 'primary' : 'text'}
          danger={isRecording}
          icon={isRecording ? <StopOutlined /> : <AudioOutlined />}
          onClick={() => (isRecording ? void stopVoiceRecording() : void startVoiceRecording())}
          disabled={isTranscribing}
          aria-label={isRecording ? 'Stop recording' : 'Record voice message'}
          title={isRecording ? 'Stop recording' : 'Record voice message'}
        />
      )}
    </Flex>
  );
});
