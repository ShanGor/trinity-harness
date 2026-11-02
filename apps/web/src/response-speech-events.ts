export type ResponseSpeechPhase = 'playing' | 'ended' | 'stopped';
export type ResponseSpeechEvent = { sessionId: string; phase: ResponseSpeechPhase };
const listeners = new Set<(event: ResponseSpeechEvent) => void>();
export function publishResponseSpeech(event: ResponseSpeechEvent): void {
  for (const listener of listeners) listener(event);
}
export function subscribeResponseSpeech(
  listener: (event: ResponseSpeechEvent) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
