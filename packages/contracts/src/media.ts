import { z } from 'zod';

/**
 * WebRTC media-plane contracts (docs/webrtc-media-design.md). Phase delivered:
 * signaling message schemas, the media-gateway port the server relays to, and
 * the short-lived media-token port. The RTP-terminating gateway adapter and
 * the browser media client are NOT delivered — without an adapter the
 * signaling route answers 501 and calls keep using the streaming-ASR + SSE-TTS
 * path (docs/voice-call-design.md §8.1).
 */

/** Media token lifetime (docs/webrtc-media-design.md §4). */
export const MEDIA_TOKEN_TTL_SECONDS = 600;

const sdpSchema = z
  .string()
  .min(1)
  .max(64 * 1024);
const iceCandidateSchema = z.record(z.string(), z.unknown());

// ---- client → server ------------------------------------------------------

export const mediaHelloSchema = z.object({
  type: z.literal('media.hello'),
  /** Short-lived media token from POST /api/media/token (one-time use). */
  token: z.string().min(1).max(4096),
  /** Chat/Work session the phone call is bound to; must match the token. */
  sessionId: z.string().min(1),
});

export const mediaOfferSchema = z.object({
  type: z.literal('media.offer'),
  sdp: sdpSchema,
});

export const mediaIceSchema = z.object({
  type: z.literal('media.ice'),
  /** RTCIceCandidateInit; opaque at this layer, validated again by the adapter. */
  candidate: iceCandidateSchema,
});

export const mediaByeSchema = z.object({
  type: z.literal('media.bye'),
});

/** Start TTS downlink: the gateway synthesizes text and plays it on the peer connection. */
export const mediaSpeakSchema = z.object({
  type: z.literal('media.speak'),
  text: z.string().min(1).max(5_000),
});

/** Stop the current TTS downlink immediately (interruption). */
export const mediaStopSpeakingSchema = z.object({
  type: z.literal('media.stop_speaking'),
});

export const mediaClientMessageSchema = z.discriminatedUnion('type', [
  mediaHelloSchema,
  mediaOfferSchema,
  mediaIceSchema,
  mediaSpeakSchema,
  mediaStopSpeakingSchema,
  mediaByeSchema,
]);

export type MediaClientMessage = z.infer<typeof mediaClientMessageSchema>;
export type MediaHello = z.infer<typeof mediaHelloSchema>;

// ---- server → client ------------------------------------------------------

export const mediaErrorCodeSchema = z.enum([
  'token_expired',
  'token_revoked',
  'capacity',
  'quota',
  'invalid_session',
  'not_bound',
  'bad_message',
  'gateway_unavailable',
  'tts_unavailable',
]);

export type MediaErrorCode = z.infer<typeof mediaErrorCodeSchema>;

export const mediaReadySchema = z.object({
  type: z.literal('media.ready'),
  mediaSessionId: z.string().min(1),
  expiresAt: z.string().min(1),
});

export const mediaErrorSchema = z.object({
  type: z.literal('media.error'),
  code: mediaErrorCodeSchema,
  message: z.string().max(500),
});

export const mediaAnswerSchema = z.object({
  type: z.literal('media.answer'),
  sdp: sdpSchema,
});

export const mediaServerIceSchema = z.object({
  type: z.literal('media.ice'),
  candidate: iceCandidateSchema,
});

export const mediaAsrPartialSchema = z.object({
  type: z.literal('media.asr_partial'),
  text: z.string(),
});

export const mediaAsrFinalSchema = z.object({
  type: z.literal('media.asr_final'),
  text: z.string(),
});

/** The gateway finished playing a TTS downlink (natural end or stopped). */
export const mediaTtsEndedSchema = z.object({
  type: z.literal('media.tts_ended'),
});

export const mediaServerMessageSchema = z.discriminatedUnion('type', [
  mediaReadySchema,
  mediaErrorSchema,
  mediaAnswerSchema,
  mediaServerIceSchema,
  mediaAsrPartialSchema,
  mediaAsrFinalSchema,
  mediaTtsEndedSchema,
]);

export type MediaServerMessage = z.infer<typeof mediaServerMessageSchema>;

// ---- ports ----------------------------------------------------------------

/** What the token was issued for; consumed once at media.hello. */
export interface MediaTokenBinding {
  userId: string;
  tenantId: string;
  sessionId: string;
  /** Informational; enforcement is the backend TTL. */
  expiresAt: string;
}

/**
 * Short-lived media-token service (docs/webrtc-media-design.md §4): opaque,
 * revocable, one-time-use tokens scoped to one phone-call session. Fails
 * closed: `consume` returns null for anything invalid, expired, revoked or on
 * backend error; `issue` returns null when the backend cannot store.
 */
export interface MediaTokenPort {
  issue(identity: { userId: string; tenantId: string }, sessionId: string): Promise<string | null>;
  consume(token: string): Promise<MediaTokenBinding | null>;
  revoke(token: string): Promise<void>;
}

export interface MediaSessionRequest {
  tenantId: string;
  userId: string;
  sessionId: string;
}

export interface MediaSession {
  mediaSessionId: string;
  expiresAt: string;
}

export type MediaGatewayEvent =
  | { type: 'asr_partial'; mediaSessionId: string; text: string }
  | { type: 'asr_final'; mediaSessionId: string; text: string }
  /** A TTS downlink finished playing (natural end or stop). */
  | { type: 'tts_ended'; mediaSessionId: string }
  | { type: 'ended'; mediaSessionId: string; reason: string };

/**
 * Fetches a PCM stream for TTS downlink text. Provided per-speak by the
 * signaling server, which enforces tenant quota and owns upstream access;
 * returns null when quota or upstream rejects.
 */
export type MediaTtsFetch = (
  text: string,
  signal: AbortSignal,
) => Promise<{ sampleRate: number; chunks: AsyncIterable<Int16Array> } | null>;

/**
 * Media-gateway adapter (RTP termination; docs/webrtc-media-design.md §2).
 * The server relays signaling to one adapter instance; the adapter owns the
 * peer connection, upstream Fun-ASR/TTS pipes, and ASR result events.
 * `allocate` returning null means capacity or upstream unavailability.
 */
export interface MediaGatewayPort {
  allocate(request: MediaSessionRequest): Promise<MediaSession | null>;
  answerOffer(mediaSessionId: string, sdp: string): Promise<{ sdp: string } | null>;
  addIceCandidate(mediaSessionId: string, candidate: Record<string, unknown>): Promise<boolean>;
  /**
   * Start a TTS downlink: fetch PCM via `fetchPcm`, transcode to the
   * negotiated codec and pace it over the peer connection. False ⇒ the
   * downlink could not start (no peer/send track, or fetchPcm rejected).
   */
  speak(mediaSessionId: string, text: string, fetchPcm: MediaTtsFetch): Promise<boolean>;
  /** Stop the current downlink immediately (interruption). */
  stopSpeaking(mediaSessionId: string): Promise<void>;
  close(mediaSessionId: string): Promise<void>;
  /** Subscribe to ASR/TTS/ended events; returns an unsubscribe function. */
  onEvent(listener: (event: MediaGatewayEvent) => void): () => void;
}
