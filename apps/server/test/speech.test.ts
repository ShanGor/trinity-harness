import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { MemorySessionStore } from '@trinity-harness/core';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../src/index.js';

const WS_DIR = mkdtempSync(path.join(tmpdir(), 'trinity-speech-'));

interface FakeUpstream {
  server: HttpServer;
  url: string;
  /** Raw request bodies received, in arrival order. */
  requests: Buffer[];
}

function fakeUpstream(
  handler: (req: IncomingMessage, body: Buffer, res: ServerResponse) => void,
): Promise<FakeUpstream> {
  const requests: Buffer[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push(body);
      handler(req, body, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, requests });
    });
  });
}

describe('speech proxy routes (docs/design.md §10)', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let asr: FakeUpstream;
  let tts: FakeUpstream;

  beforeAll(async () => {
    asr = await fakeUpstream((req, body, res) => {
      if (req.url !== '/v1/audio/transcriptions') {
        res.writeHead(404).end();
        return;
      }
      // Emulate Fun-ASR: OpenAI-compatible multipart in, JSON out.
      if (!String(req.headers['content-type']).startsWith('multipart/form-data')) {
        res.writeHead(415).end();
        return;
      }
      if (!body.includes('voice-bytes')) {
        res.writeHead(422).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          task: 'transcribe',
          language: 'auto',
          duration: 1.2,
          text: '  hello world  ',
        }),
      );
    });
    tts = await fakeUpstream((req, body, res) => {
      if (req.url !== '/tts/stream') {
        res.writeHead(404).end();
        return;
      }
      const parsed = JSON.parse(body.toString()) as { text?: string };
      if (parsed.text === 'boom') {
        res.writeHead(500).end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'x-sample-rate': '24000',
        'x-format': 'pcm16le',
      });
      res.write(Buffer.from([1, 0, 2, 0]));
      res.end(Buffer.from([3, 0]));
    });
    app = await buildServer({
      store: new MemorySessionStore(),
      workspaceRoot: WS_DIR,
      speech: { asrUrl: asr.url, ttsUrl: tts.url },
    });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address;
  });

  afterAll(async () => {
    await app.close();
    asr.server.close();
    tts.server.close();
    rmSync(WS_DIR, { recursive: true, force: true });
  });

  it('transcribes an audio upload via the ASR service', async () => {
    const res = await fetch(`${baseUrl}/api/speech/transcriptions?mime=audio/webm`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from('voice-bytes'),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'hello world' });
    // The audio reached the ASR service as a multipart file field.
    const upstream = asr.requests[0]!.toString();
    expect(upstream).toContain('name="file"');
    expect(upstream).toContain('filename="audio.webm"');
  });

  it('rejects a non-audio mime type', async () => {
    const res = await fetch(`${baseUrl}/api/speech/transcriptions?mime=text/plain`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from('voice-bytes'),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a missing or empty body', async () => {
    const res = await fetch(`${baseUrl}/api/speech/transcriptions?mime=audio/webm`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(0),
    });
    expect(res.status).toBe(400);
  });

  it('streams synthesized PCM as realtime SSE audio events', async () => {
    const res = await fetch(`${baseUrl}/api/speech/synthesis/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Say this.' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('x-sample-rate')).toBe('24000');
    expect(res.headers.get('x-format')).toBe('pcm16le');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(res.headers.get('cache-control')).toContain('no-transform');
    const events = await res.text();
    expect(events).toContain(
      'event: speech.start\ndata: {"sampleRate":24000,"format":"pcm16le"}\n\n',
    );
    expect(events.endsWith('event: speech.complete\ndata: {}\n\n')).toBe(true);
    const audio = [...events.matchAll(/event: speech\.audio_chunk\ndata: (.*)\n\n/g)].map(
      (match) => JSON.parse(match[1]!) as { audio: string },
    );
    expect(audio.length).toBeGreaterThan(0);
    const bytes = Buffer.concat(audio.map(({ audio }) => Buffer.from(audio, 'base64')));
    expect([...bytes]).toEqual([1, 0, 2, 0, 3, 0]);
    // The text and detected language were forwarded to the TTS service.
    expect(JSON.parse(tts.requests[0]!.toString())).toEqual({
      text: 'Say this.',
      language: 'Auto',
    });
  });

  it('maps an upstream TTS failure to 502', async () => {
    const res = await fetch(`${baseUrl}/api/speech/synthesis/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'boom' }),
    });
    expect(res.status).toBe(502);
  });

  it('rejects an invalid synthesis payload', async () => {
    const res = await fetch(`${baseUrl}/api/speech/synthesis/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('speech routes when unconfigured', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    app = await buildServer({
      store: new MemorySessionStore(),
      workspaceRoot: WS_DIR,
    });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address;
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 501 without speech service configuration', async () => {
    const res = await fetch(`${baseUrl}/api/speech/transcriptions?mime=audio/webm`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from('voice-bytes'),
    });
    expect(res.status).toBe(501);
  });
});
