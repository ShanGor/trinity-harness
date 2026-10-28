import { describe, expect, it } from 'vitest';

import { speechSynthesisEventsToPcm } from '../src/speech.js';

function streamOf(text: string, chunkSize = Number.POSITIVE_INFINITY): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

describe('speech synthesis SSE client', () => {
  it('reassembles PCM audio across arbitrary network chunk boundaries', async () => {
    const events =
      'event: speech.start\r\ndata: {"sampleRate":24000,"format":"pcm16le"}\r\n\r\n' +
      ': keepalive\n\n' +
      'event: speech.audio_chunk\ndata: {"audio":"AQAC"}\n\n' +
      'event: speech.audio_chunk\ndata: {"audio":"AwQ="}\n\n' +
      'event: speech.complete\ndata: {}\n\n';

    const pcm = await readAll(speechSynthesisEventsToPcm(streamOf(events, 7)));
    expect([...pcm]).toEqual([1, 0, 2, 3, 4]);
  });

  it('surfaces an upstream speech error event', async () => {
    const stream = speechSynthesisEventsToPcm(
      streamOf('event: speech.error\ndata: {"error":"synthesis unavailable"}\n\n'),
    );
    await expect(readAll(stream)).rejects.toThrow('synthesis unavailable');
  });

  it('rejects a truncated stream that has no completion event', async () => {
    const stream = speechSynthesisEventsToPcm(
      streamOf('event: speech.audio_chunk\ndata: {"audio":"AQAC"}\n\n'),
    );
    await expect(readAll(stream)).rejects.toThrow('before its completion event');
  });
});
