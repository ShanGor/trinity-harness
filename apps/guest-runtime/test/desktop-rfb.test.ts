import { createServer, type Server, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DesktopRfb } from '../src/desktop-rfb.js';

let server: Server | undefined;
let directory: string | undefined;
let peer: Socket | undefined;
afterEach(async () => {
  peer?.destroy();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
  server = undefined;
  directory = undefined;
  peer = undefined;
});

async function fixture(options?: {
  incomplete?: boolean;
  disconnectOnInput?: boolean;
  bellsBeforeUpdate?: number;
}): Promise<{
  client: DesktopRfb;
  messages: Buffer[];
}> {
  directory = await mkdtemp(path.join(tmpdir(), 'desktop-rfb-test-'));
  const socketPath = path.join(directory, 'desktop.sock');
  const messages: Buffer[] = [];
  server = createServer((socket) => {
    peer = socket;
    let buffer = Buffer.alloc(0);
    let stage = 0;
    socket.write('RFB 003.008\n');
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const size =
          stage === 0
            ? 12
            : stage === 1 || stage === 2
              ? 1
              : stage === 3
                ? 20
                : stage === 4
                  ? 8
                  : buffer[0] === 3
                    ? 10
                    : buffer[0] === 4
                      ? 8
                      : buffer[0] === 5
                        ? 6
                        : 0;
        if (!size || buffer.length < size) break;
        const message = buffer.subarray(0, size);
        buffer = buffer.subarray(size);
        if (stage === 0) socket.write(Buffer.from([1, 1]));
        else if (stage === 1) socket.write(Buffer.alloc(4));
        else if (stage === 2) {
          const init = Buffer.alloc(24);
          init.writeUInt16BE(2, 0);
          init.writeUInt16BE(1, 2);
          socket.write(init);
        } else if (stage >= 5) {
          messages.push(Buffer.from(message));
          if (message[0] === 3) {
            if (options?.bellsBeforeUpdate)
              socket.write(Buffer.alloc(options.bellsBeforeUpdate, 2));
            const width = options?.incomplete ? 1 : message.readUInt16BE(6);
            const update = Buffer.alloc(4 + 12 + width * 4);
            update.writeUInt16BE(1, 2);
            update.writeUInt16BE(width, 8);
            update.writeUInt16BE(1, 10);
            update.set([3, 2, 1, 0], 16);
            if (width === 2) update.set([6, 5, 4, 0], 20);
            socket.write(update);
          } else if (options?.disconnectOnInput) socket.destroy();
        }
        if (stage < 5) stage++;
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
  const client = await DesktopRfb.connect(socketPath, AbortSignal.timeout(3000));
  return { client, messages };
}

it('decodes a complete desktop and sends only the bounded typed input', async () => {
  const { client, messages } = await fixture();
  try {
    expect([client.width, client.height]).toEqual([2, 1]);
    expect([...(await client.capture(AbortSignal.timeout(3000)))]).toEqual([
      1, 2, 3, 255, 4, 5, 6, 255,
    ]);
    await client.input({ type: 'key', key: 'Enter', modifiers: [] }, AbortSignal.timeout(3000));
    expect(messages.map((message) => message[0])).toEqual([3, 4, 4, 3]);
    expect(messages[1]!.readUInt32BE(4)).toBe(0xff0d);
    expect(messages[1]![1]).toBe(1);
    expect(messages[2]![1]).toBe(0);
    await expect(
      client.input(
        { type: 'click', point: { x: 2, y: 0 }, button: 'left', count: 1, modifiers: [] },
        AbortSignal.timeout(3000),
      ),
    ).rejects.toThrow('outside frame');
    expect(messages).toHaveLength(4);
  } finally {
    client.close();
  }
});

it('ignores asynchronous server bells before the input acknowledgement', async () => {
  const { client, messages } = await fixture({ bellsBeforeUpdate: 2 });
  try {
    await client.input(
      { type: 'click', point: { x: 1, y: 0 }, button: 'left', count: 1, modifiers: [] },
      AbortSignal.timeout(3000),
    );
    expect(messages.map((message) => message[0])).toEqual([5, 5, 3]);
    expect([...(await client.capture(AbortSignal.timeout(3000)))]).toEqual([
      1, 2, 3, 255, 4, 5, 6, 255,
    ]);
  } finally {
    client.close();
  }
});

it('rejects an unbounded stream of asynchronous bells', async () => {
  const { client } = await fixture({ bellsBeforeUpdate: 65 });
  try {
    await expect(client.capture(AbortSignal.timeout(3000))).rejects.toThrow(
      'Unsupported desktop message',
    );
  } finally {
    client.close();
  }
});

it('rejects an incomplete desktop picture', async () => {
  const { client } = await fixture({ incomplete: true });
  try {
    await expect(client.capture(AbortSignal.timeout(3000))).rejects.toThrow(
      'Incomplete desktop picture',
    );
  } finally {
    client.close();
  }
});

it('uses the last delivered pointer position for scroll and rejects unanchored scroll', async () => {
  const { client, messages } = await fixture();
  const signal = AbortSignal.timeout(3000);
  try {
    await expect(client.input({ type: 'scroll', dx: 0, dy: 100 }, signal)).rejects.toThrow(
      'pointer position',
    );
    expect(messages).toHaveLength(0);
    await client.input(
      {
        type: 'click',
        point: { x: 1, y: 0 },
        button: 'left',
        count: 1,
        modifiers: [],
      },
      signal,
    );
    await client.input({ type: 'scroll', dx: 0, dy: -100 }, signal);
    expect(messages.map((message) => message[0])).toEqual([5, 5, 3, 5, 5, 3]);
    expect(messages[3]![1]).toBe(8);
    expect(messages[3]!.readUInt16BE(2)).toBe(1);
    expect(messages[4]![1]).toBe(0);
  } finally {
    client.close();
  }
});

it('does not report success when the connection fails after input dispatch', async () => {
  const { client, messages } = await fixture({ disconnectOnInput: true });
  try {
    await expect(
      client.input({ type: 'key', key: 'Enter', modifiers: [] }, AbortSignal.timeout(3000)),
    ).rejects.toThrow();
    expect(messages.some((message) => message[0] === 4)).toBe(true);
    await expect(client.capture(AbortSignal.timeout(3000))).rejects.toThrow();
  } finally {
    client.close();
  }
});

it('rejects non-Unix endpoints before connecting', async () => {
  await expect(DesktopRfb.connect('127.0.0.1:5900', AbortSignal.timeout(1000))).rejects.toThrow(
    'Unix socket',
  );
});
