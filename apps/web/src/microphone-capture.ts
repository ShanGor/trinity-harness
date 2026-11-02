/** Energy gate shared by phone recording and realtime speech activity. */
export const SPEECH_RMS_THRESHOLD = 0.02;

export function hasSpeechActivity(samples: Float32Array): boolean {
  if (!samples.length) return false;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length) >= SPEECH_RMS_THRESHOLD;
}

/** Event-driven local PCM tap; its output is silent and never plays microphone audio. */
export async function connectMicrophoneCapture(
  context: AudioContext,
  stream: MediaStream,
  onChunk: (samples: Float32Array) => void,
): Promise<() => void> {
  const source = context.createMediaStreamSource(stream);
  let node: AudioNode | null = null;
  try {
    if (context.audioWorklet) {
      const url = URL.createObjectURL(
        new Blob(
          [
            `
        class TrinityPcmCapture extends AudioWorkletProcessor {
          process(inputs) {
            const ch = inputs[0] && inputs[0][0];
            if (ch) this.port.postMessage(ch.slice(0));
            return true;
          }
        }
        registerProcessor('trinity-pcm-capture', TrinityPcmCapture);
      `,
          ],
          { type: 'application/javascript' },
        ),
      );
      try {
        await context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const worklet = new AudioWorkletNode(context, 'trinity-pcm-capture');
      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => onChunk(event.data);
      node = worklet;
    } else {
      const processor = context.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) =>
        onChunk(new Float32Array(event.inputBuffer.getChannelData(0)));
      node = processor;
    }
    source.connect(node);
    node.connect(context.destination);
  } catch (error) {
    source.disconnect();
    node?.disconnect();
    throw error;
  }
  return () => {
    source.disconnect();
    node?.disconnect();
  };
}
