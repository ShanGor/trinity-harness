import { newId } from '@trinity-harness/shared';

import type { ChatItem } from './chat-items';
import { markdownToSpeechText } from './markdown-to-speech';
import { PcmPlayer } from './pcm-player';
import {
  openSpeechSynthesisStream,
  transcribeSpeechAudio,
  type SpeechSynthesisStream,
} from './speech';
import { segmentSpeechText, stableMarkdownPrefix } from './voice-call-text';

const SAMPLE_RATE = 24_000;
const SILENCE_TIMEOUT_MS = 900;
const SILENCE_RMS = 0.02;
const MAX_RECORDING_MS = 60_000;
const VAD_POLL_MS = 150;

export type VoiceCallStatus =
  'idle' | 'connecting' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error';

export interface VoiceCallSnapshot {
  active: boolean;
  status: VoiceCallStatus;
  muted: boolean;
  startedAt: number | null;
  userText: string;
  assistantText: string;
  error: string | null;
}

const IDLE_SNAPSHOT: VoiceCallSnapshot = {
  active: false,
  status: 'idle',
  muted: false,
  startedAt: null,
  userText: '',
  assistantText: '',
  error: null,
};

export interface VoiceCallPlayer {
  readonly sampleRate: number;
  resume(): Promise<void>;
  append(chunk: Uint8Array): void;
  finish(): void;
  stop(): void;
}

export interface VoiceCallDependencies {
  getSessionId(): string | null;
  submit(text: string, onPromptId: (promptId: string) => void): Promise<boolean | void>;
  /** Resolves true only when the turn was already terminal at cancellation. */
  cancelTurn(): Promise<boolean | void>;
  onError(message: string): void;
  transcribe(blob: Blob, signal: AbortSignal): Promise<string>;
  synthesize(text: string, signal: AbortSignal): Promise<SpeechSynthesisStream>;
  createPlayer(sampleRate: number, onEnded: () => void, context: AudioContext): VoiceCallPlayer;
}

interface CallState {
  id: string;
  sessionId: string | null;
  stream: MediaStream | null;
  audioContext: AudioContext | null;
  responseEpoch: number;
}

interface RecordingState {
  id: string;
  call: CallState;
  recorder: MediaRecorder;
  chunks: Blob[];
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  timer: ReturnType<typeof setInterval> | null;
  startedAt: number;
  lastVoiceAt: number;
  heardSpeech: boolean;
  discard: boolean;
}

interface PendingSubmission {
  call: CallState;
  utteranceId: string;
  transcript: string;
}

interface ResponseState extends PendingSubmission {
  promptId: string | null;
  anchorKey: string | null;
  responseKey: string | null;
  spokenText: string;
  final: boolean;
  invalidated: boolean;
  submissionInFlight: boolean;
  cancelRequested: boolean;
}

interface PlaybackState {
  call: CallState;
  epoch: number;
  abort: AbortController;
  player: VoiceCallPlayer;
  resolve: () => void;
}

/**
 * Turn-taking phone-mode state machine (docs/voice-call-design.md).
 *
 * Final prompts and answers continue through the ordinary session event log.
 * This controller owns only ephemeral microphone, ASR, TTS and playback state.
 * Every async completion is fenced by its call/utterance/response identity so
 * a late result cannot cross a hangup, mute, interruption or session switch.
 */
export class VoiceCallController {
  private snapshot: VoiceCallSnapshot = IDLE_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private call: CallState | null = null;
  private recording: RecordingState | null = null;
  private asr: { id: string; call: CallState; abort: AbortController } | null = null;
  private pending: PendingSubmission | null = null;
  private response: ResponseState | null = null;
  private speechQueue: { call: CallState; epoch: number; text: string }[] = [];
  private playback: PlaybackState | null = null;
  private pumpCall: CallState | null = null;
  private cancelWaiting: {
    call: CallState;
    sessionId: string;
    promptId: string | null;
  } | null = null;
  private items: ChatItem[] = [];
  private busy = false;
  private approvalPending = false;

  constructor(private readonly deps: VoiceCallDependencies) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): VoiceCallSnapshot => this.snapshot;

  /** Reacts to the same message projection used by the visible transcript. */
  update(items: ChatItem[], busy: boolean, approvalPending: boolean): void {
    this.items = items;
    this.busy = busy;
    this.approvalPending = approvalPending;
    const call = this.call;
    if (!call || !this.snapshot.active || this.snapshot.status === 'error') return;
    const currentSessionId = this.deps.getSessionId();
    if (
      (call.sessionId && currentSessionId !== call.sessionId) ||
      (!call.sessionId && currentSessionId !== null && !this.response && !this.pending)
    ) {
      this.stop();
      return;
    }
    if (this.cancelWaiting) {
      this.cancelRecording();
      this.setStatus('thinking');
      return;
    }

    if (this.pending && !busy && !approvalPending) void this.submitPending(this.pending);
    if (this.response) this.updateResponse(this.response);

    if (!this.response && !this.pending && (busy || approvalPending)) {
      this.cancelRecording();
      this.setStatus('thinking');
      return;
    }
    if (
      !this.response &&
      !this.pending &&
      !this.recording &&
      !this.asr &&
      !this.playback &&
      !busy &&
      !approvalPending &&
      !this.snapshot.muted
    ) {
      this.beginRecording(call);
    }
  }

  /** Starts a new call and unlocks playback synchronously from the click gesture. */
  async start(): Promise<void> {
    this.stop();
    const call: CallState = {
      id: newId(),
      sessionId: this.deps.getSessionId(),
      stream: null,
      audioContext: null,
      responseEpoch: 0,
    };
    this.call = call;
    this.setSnapshot({
      ...IDLE_SNAPSHOT,
      active: true,
      status: 'connecting',
      startedAt: Date.now(),
    });

    try {
      if (!window.isSecureContext) {
        throw new Error('Voice calls require HTTPS or localhost.');
      }
      if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('This browser does not support microphone recording.');
      }
      const context = new AudioContext({ sampleRate: SAMPLE_RATE });
      call.audioContext = context;
      await context.resume();
      if (!this.isCurrent(call)) return;
      if (context.state !== 'running') {
        throw new Error('Audio playback is blocked by the browser. Please try again.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (!this.isCurrent(call)) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      call.stream = stream;
      this.beginRecording(call);
    } catch (error) {
      this.fail(call, error);
    }
  }

  /** Hangs up voice resources only; it deliberately does not cancel Agent work. */
  readonly stop = (): void => {
    const call = this.call;
    if (call) call.responseEpoch += 1;
    this.call = null;
    this.pending = null;
    this.response = null;
    this.speechQueue = [];
    this.pumpCall = null;
    this.cancelWaiting = null;
    this.cancelUtterance();
    // A stopped call must not let its asynchronously ending recorder block a
    // brand-new call. The old stop event remains fenced by CallState identity.
    this.recording = null;
    this.stopPlayback();
    if (call?.stream) call.stream.getTracks().forEach((track) => track.stop());
    if (call?.audioContext) void call.audioContext.close();
    this.setSnapshot(IDLE_SNAPSHOT);
  };

  dispose(): void {
    this.stop();
    this.listeners.clear();
  }

  toggleMute(): void {
    const call = this.call;
    if (!call || !this.snapshot.active || this.snapshot.status === 'error') return;
    const muted = !this.snapshot.muted;
    this.setSnapshot({ ...this.snapshot, muted });
    call.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
    if (muted) {
      this.pending = null;
      this.cancelUtterance();
      if (!this.response && !this.playback) {
        this.setStatus(this.busy || this.approvalPending ? 'thinking' : 'listening');
      }
      return;
    }
    if (!this.response && !this.pending && !this.busy && !this.approvalPending) {
      this.beginRecording(call);
    } else if (this.busy || this.approvalPending) {
      this.setStatus('thinking');
    }
  }

  /** Stops audio immediately, then requests ordinary turn cancellation if needed. */
  async interrupt(): Promise<void> {
    const call = this.call;
    if (!call || !this.snapshot.active || this.snapshot.status === 'error') return;
    const response = this.response;
    call.responseEpoch += 1;
    this.speechQueue = [];
    this.stopPlayback();
    this.pending = null;
    this.cancelUtterance();
    if (response?.submissionInFlight) {
      // Cancelling before the prompt exists cannot cancel it. Keep this local
      // response as a fence and cancel exactly once when submission settles.
      response.cancelRequested = true;
      response.invalidated = true;
      this.setStatus('thinking');
      return;
    }
    this.response = null;
    if (response || this.busy) {
      await this.requestCancellation(call, response?.promptId ?? null);
      return;
    }
    if (!this.busy && !this.approvalPending && !this.snapshot.muted) this.beginRecording(call);
  }

  /** App forwards the actual terminal event; a local cancel request is not proof. */
  onTurnTerminal(sessionId: string, promptId?: string): void {
    const waiting = this.cancelWaiting;
    if (
      !waiting ||
      waiting.sessionId !== sessionId ||
      (promptId && waiting.promptId && promptId !== waiting.promptId) ||
      !this.isCurrent(waiting.call)
    ) {
      return;
    }
    this.cancelWaiting = null;
    if (!this.response && !this.pending && !this.snapshot.muted) {
      this.beginRecording(waiting.call);
    }
  }

  private async requestCancellation(call: CallState, promptId: string | null): Promise<void> {
    const sessionId = call.sessionId ?? this.deps.getSessionId();
    if (!sessionId) return;
    this.response = null;
    this.cancelWaiting = { call, sessionId, promptId };
    this.setStatus('thinking');
    try {
      const alreadyTerminal = await this.deps.cancelTurn();
      if (!this.isCurrent(call)) return;
      if (alreadyTerminal === true) this.cancelWaiting = null;
    } catch (error) {
      if (this.isCurrent(call)) {
        this.cancelWaiting = null;
        this.fail(call, error);
      }
      return;
    }
    if (!this.cancelWaiting && !this.busy && !this.approvalPending && !this.snapshot.muted) {
      this.beginRecording(call);
    }
  }

  private setSnapshot(snapshot: VoiceCallSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private setStatus(status: VoiceCallStatus): void {
    if (!this.snapshot.active || this.snapshot.status === status) return;
    this.setSnapshot({ ...this.snapshot, status });
  }

  private isCurrent(call: CallState): boolean {
    return this.call === call && this.snapshot.active;
  }

  private fail(call: CallState, error: unknown): void {
    if (!this.isCurrent(call)) return;
    const startedAt = this.snapshot.startedAt;
    const detail = error instanceof Error ? error.message : String(error);
    this.call = null;
    this.pending = null;
    this.response = null;
    this.speechQueue = [];
    this.pumpCall = null;
    this.cancelWaiting = null;
    this.cancelUtterance();
    // A stopped call must not let its asynchronously ending recorder block a
    // brand-new call. The old stop event remains fenced by CallState identity.
    this.recording = null;
    this.stopPlayback();
    call.stream?.getTracks().forEach((track) => track.stop());
    if (call.audioContext) void call.audioContext.close();
    this.setSnapshot({
      ...IDLE_SNAPSHOT,
      active: true,
      status: 'error',
      startedAt,
      error: detail || 'Voice call failed.',
    });
  }

  private beginRecording(call: CallState): void {
    if (
      !this.isCurrent(call) ||
      !call.stream ||
      !call.audioContext ||
      this.snapshot.muted ||
      this.recording ||
      this.asr ||
      this.response ||
      this.pending ||
      this.cancelWaiting ||
      this.playback ||
      this.busy ||
      this.approvalPending
    ) {
      return;
    }
    try {
      const stream = call.stream;
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : undefined;
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      const context = call.audioContext;
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const recording: RecordingState = {
        id: newId(),
        call,
        recorder,
        chunks: [],
        source,
        analyser,
        timer: null,
        startedAt: Date.now(),
        lastVoiceAt: 0,
        heardSpeech: false,
        discard: false,
      };
      this.recording = recording;
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0 && !recording.discard) recording.chunks.push(event.data);
      });
      recorder.addEventListener('stop', () => void this.finishRecording(recording), { once: true });

      const levels = new Uint8Array(analyser.fftSize);
      recording.timer = setInterval(() => {
        if (this.recording !== recording) return;
        analyser.getByteTimeDomainData(levels);
        let sum = 0;
        for (const level of levels) {
          const centered = (level - 128) / 128;
          sum += centered * centered;
        }
        const now = Date.now();
        if (Math.sqrt(sum / levels.length) >= SILENCE_RMS) {
          recording.heardSpeech = true;
          recording.lastVoiceAt = now;
        }
        if (
          (recording.heardSpeech && now - recording.lastVoiceAt >= SILENCE_TIMEOUT_MS) ||
          now - recording.startedAt >= MAX_RECORDING_MS
        ) {
          this.stopRecording(recording, false);
        }
      }, VAD_POLL_MS);
      recorder.start();
      this.setSnapshot({ ...this.snapshot, status: 'listening', error: null });
    } catch (error) {
      this.cancelRecording();
      this.fail(call, error);
    }
  }

  private stopRecording(recording: RecordingState, discard: boolean): void {
    // Keep the stopping recorder attached until its stop event. Clearing it
    // here would let update() start a second recorder in that async window.
    recording.discard ||= discard;
    if (recording.timer) clearInterval(recording.timer);
    recording.source.disconnect();
    recording.analyser.disconnect();
    if (recording.recorder.state !== 'inactive') recording.recorder.stop();
  }

  private cancelRecording(): void {
    if (this.recording) this.stopRecording(this.recording, true);
  }

  private cancelUtterance(): void {
    this.cancelRecording();
    this.asr?.abort.abort();
    this.asr = null;
  }

  private async finishRecording(recording: RecordingState): Promise<void> {
    // Clear the stopping ref only after the browser/device stop event. The
    // active stopRecording path intentionally retains it until this point.
    if (this.recording === recording) {
      this.recording = null;
      if (recording.timer) clearInterval(recording.timer);
      recording.source.disconnect();
      recording.analyser.disconnect();
    }
    const { call, id } = recording;
    const blob = new Blob(recording.chunks, {
      type: recording.recorder.mimeType || 'audio/webm',
    });
    if (!this.isCurrent(call) || this.snapshot.muted) return;
    if (recording.discard) {
      this.beginRecording(call);
      return;
    }
    if (blob.size === 0) {
      this.beginRecording(call);
      return;
    }
    const abort = new AbortController();
    this.asr = { id, call, abort };
    this.setStatus('transcribing');
    try {
      const transcript = (await this.deps.transcribe(blob, abort.signal)).trim();
      if (this.asr?.id === id) this.asr = null;
      if (!this.isCurrent(call) || abort.signal.aborted || this.snapshot.muted) return;
      if (!transcript) {
        this.beginRecording(call);
        return;
      }
      this.setSnapshot({ ...this.snapshot, userText: transcript, assistantText: '' });
      this.pending = { call, utteranceId: id, transcript };
      if (this.busy || this.approvalPending) this.setStatus('thinking');
      else void this.submitPending(this.pending);
    } catch (error) {
      if (this.asr?.id === id) this.asr = null;
      if (!abort.signal.aborted) this.fail(call, error);
    }
  }

  private async submitPending(pending: PendingSubmission): Promise<void> {
    if (this.pending !== pending || !this.isCurrent(pending.call)) return;
    if (this.busy || this.approvalPending || this.snapshot.muted) return;
    this.pending = null;
    pending.call.responseEpoch += 1;
    const response: ResponseState = {
      ...pending,
      promptId: null,
      anchorKey: this.items.at(-1)?.key ?? null,
      responseKey: null,
      spokenText: '',
      final: false,
      invalidated: false,
      submissionInFlight: true,
      cancelRequested: false,
    };
    this.response = response;
    this.setStatus('thinking');
    try {
      const accepted = await this.deps.submit(pending.transcript, (promptId) => {
        if (this.isCurrent(pending.call) && this.response === response) {
          response.promptId = promptId;
        }
      });
      if (!this.isCurrent(pending.call) || this.response !== response) return;
      response.submissionInFlight = false;
      pending.call.sessionId = this.deps.getSessionId() ?? pending.call.sessionId;
      if (accepted === false && !(response.cancelRequested && pending.call.sessionId)) {
        throw new Error('The voice message was not sent. Please try again.');
      }
      if (response.cancelRequested) {
        await this.requestCancellation(pending.call, response.promptId);
        return;
      }
      this.updateResponse(response);
    } catch (error) {
      this.fail(pending.call, error);
    }
  }

  private updateResponse(response: ResponseState): void {
    if (this.response !== response || response.cancelRequested || !this.isCurrent(response.call)) {
      return;
    }
    const item = this.findResponseItem(response);
    if (!item) return;
    response.responseKey = item.key;
    if (item.removed) {
      // Deletion/retry detaches this local response. Never flush its remaining
      // sentences or automatically bind a replacement prompt by matching text.
      response.final = true;
      response.invalidated = true;
      response.call.responseEpoch += 1;
      this.speechQueue = [];
      this.stopPlayback();
      this.setSnapshot({ ...this.snapshot, assistantText: '' });
      this.maybeFinishResponse(response);
      return;
    }
    const final = item.final || item.stopped || item.error || (!this.busy && !item.streaming);
    response.final = final;
    const plain = markdownToSpeechText(stableMarkdownPrefix(item.content, final));
    this.setSnapshot({ ...this.snapshot, assistantText: markdownToSpeechText(item.content) });

    // A non-append-only streaming revision pauses speech until final rather
    // than permanently silencing the corrected answer.
    if (response.invalidated && final) {
      response.invalidated = false;
      response.spokenText = '';
    }
    if (!response.invalidated && !plain.startsWith(response.spokenText)) {
      // A tool-boundary commit archives provisional progress into Execution
      // details and resets the main response. That reset must not silence the
      // eventual final answer; an unrelated text replacement is different.
      const archived = item.activity?.some((entry) => {
        const activityText = markdownToSpeechText(entry.content);
        return activityText.length > 0 && activityText.startsWith(response.spokenText);
      });
      response.call.responseEpoch += 1;
      this.speechQueue = [];
      this.stopPlayback();
      response.spokenText = '';
      if (!archived) response.invalidated = !final;
    }
    if (!response.invalidated) {
      const pendingText = plain.slice(response.spokenText.length);
      const segmented = segmentSpeechText(pendingText, final);
      response.spokenText += pendingText.slice(0, segmented.consumed);
      if (segmented.segments.length > 0) {
        this.speechQueue.push(
          ...segmented.segments.map((text) => ({
            call: response.call,
            epoch: response.call.responseEpoch,
            text,
          })),
        );
        void this.pumpSpeech(response.call);
      }
    }
    this.maybeFinishResponse(response);
  }

  private findResponseItem(response: ResponseState): ChatItem | undefined {
    const assistantAfter = (userIndex: number): ChatItem | undefined => {
      for (let index = userIndex + 1; index < this.items.length; index += 1) {
        const item = this.items[index]!;
        if (item.role === 'user') return undefined;
        if (item.role === 'assistant') return item;
      }
      return undefined;
    };
    if (response.promptId) {
      const userIndex = this.items.findIndex(
        (item) => item.role === 'user' && item.messageId === response.promptId,
      );
      return userIndex < 0 ? undefined : assistantAfter(userIndex);
    }
    if (response.responseKey) {
      const existing = this.items.find((item) => item.key === response.responseKey);
      if (existing) return existing;
    }
    const anchorIndex = response.anchorKey
      ? this.items.findIndex((item) => item.key === response.anchorKey)
      : -1;
    // Losing an anchor during historical reprojection must not turn an older
    // same-text prompt into this call's response. Wait for the server promptId.
    if (response.anchorKey && anchorIndex < 0) return undefined;
    const userIndex = this.items.findIndex(
      (item, index) =>
        index > anchorIndex && item.role === 'user' && item.content === response.transcript,
    );
    return userIndex < 0 ? undefined : assistantAfter(userIndex);
  }

  private async pumpSpeech(call: CallState): Promise<void> {
    if (this.pumpCall || !this.isCurrent(call)) return;
    this.pumpCall = call;
    try {
      while (this.isCurrent(call) && this.speechQueue.length > 0) {
        const next = this.speechQueue.shift()!;
        if (next.call !== call || next.epoch !== call.responseEpoch) continue;
        this.setStatus('speaking');
        const played = await this.playSegment(call, next.epoch, next.text);
        if (!played) break;
      }
    } finally {
      if (this.pumpCall === call) this.pumpCall = null;
    }
    if (!this.isCurrent(call)) return;
    // An archived/replaced response can enqueue a new epoch while the old
    // playback promise is unwinding. Hand the queued epoch to a fresh pump.
    if (this.speechQueue.length > 0) {
      void this.pumpSpeech(call);
      return;
    }
    if (this.response) {
      if (!this.maybeFinishResponse(this.response)) this.setStatus('thinking');
    }
  }

  /** Returns false for cancellation/failure; failed synthesis is never retried blindly. */
  private async playSegment(call: CallState, epoch: number, text: string): Promise<boolean> {
    const context = call.audioContext;
    if (!context || !this.isCurrent(call) || epoch !== call.responseEpoch) return false;
    const abort = new AbortController();
    let resolvePlayback!: () => void;
    const played = new Promise<void>((resolve) => {
      resolvePlayback = resolve;
    });
    const player = this.deps.createPlayer(SAMPLE_RATE, resolvePlayback, context);
    const playback: PlaybackState = {
      call,
      epoch,
      abort,
      player,
      resolve: resolvePlayback,
    };
    this.playback = playback;
    try {
      await player.resume();
      const { sampleRate, stream } = await this.deps.synthesize(text, abort.signal);
      if (sampleRate !== player.sampleRate) {
        throw new Error(`Unsupported speech sample rate (${sampleRate} Hz).`);
      }
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (abort.signal.aborted || !this.isCurrent(call) || epoch !== call.responseEpoch) {
            await reader.cancel();
            return false;
          }
          player.append(value);
        }
      } finally {
        reader.releaseLock();
      }
      player.finish();
      await played;
      return !abort.signal.aborted && this.isCurrent(call) && epoch === call.responseEpoch;
    } catch (error) {
      if (!abort.signal.aborted && this.isCurrent(call) && epoch === call.responseEpoch) {
        this.deps.onError(error instanceof Error ? error.message : String(error));
        if (this.response?.call === call) this.response.invalidated = true;
        this.speechQueue = [];
      }
      return false;
    } finally {
      if (this.playback === playback) this.playback = null;
      player.stop();
      resolvePlayback();
    }
  }

  private stopPlayback(): void {
    const playback = this.playback;
    this.playback = null;
    if (!playback) return;
    playback.abort.abort();
    playback.player.stop();
    playback.resolve();
  }

  private maybeFinishResponse(response: ResponseState): boolean {
    if (
      this.response !== response ||
      !response.final ||
      this.pumpCall ||
      this.playback ||
      this.speechQueue.length > 0
    ) {
      return false;
    }
    this.response = null;
    if (this.busy || this.approvalPending) {
      this.setStatus('thinking');
    } else if (!this.snapshot.muted) {
      this.beginRecording(response.call);
    }
    return true;
  }
}

export const defaultVoiceCallDependencies = {
  transcribe: transcribeSpeechAudio,
  synthesize: openSpeechSynthesisStream,
  createPlayer: (sampleRate: number, onEnded: () => void, context: AudioContext): VoiceCallPlayer =>
    new PcmPlayer(sampleRate, onEnded, context),
};
