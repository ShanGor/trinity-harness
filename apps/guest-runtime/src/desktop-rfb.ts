import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { browserHumanActionSchema, type BrowserHumanAction } from '@trinity-harness/contracts';

/**
 * Private RFB client for an operator-owned guest display. This is not an
 * authorization boundary: callers must fence every input before invoking it.
 * No server-provided address or client-provided RFB bytes are accepted.
 */
export class DesktopRfb {
  private readonly chunks: Buffer[] = [];
  private buffered = 0;
  private readonly changed = new EventTarget();
  private ended = false;
  private busy = false;
  private pointerPosition: { x: number; y: number } | undefined;
  private desktopWidth = 0;
  private desktopHeight = 0;
  get width(): number {
    return this.desktopWidth;
  }
  get height(): number {
    return this.desktopHeight;
  }
  private constructor(private readonly socket: Socket) {
    socket.on('data', this.receive);
    socket.on('close', this.closed);
    socket.on('error', this.closed);
  }
  private readonly receive = (chunk: Buffer): void => {
    if (this.buffered + chunk.length > 18 * 1024 * 1024) {
      this.socket.destroy();
      return;
    }
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    this.changed.dispatchEvent(new Event('change'));
  };
  private readonly closed = (): void => {
    this.ended = true;
    this.changed.dispatchEvent(new Event('change'));
  };
  private async read(size: number, signal: AbortSignal): Promise<Buffer> {
    signal.throwIfAborted();
    while (this.buffered < size) {
      signal.throwIfAborted();
      if (this.ended) throw new Error('Desktop disconnected');
      await new Promise<void>((resolve) => {
        const done = (): void => {
          this.changed.removeEventListener('change', done);
          signal.removeEventListener('abort', done);
          resolve();
        };
        this.changed.addEventListener('change', done, { once: true });
        signal.addEventListener('abort', done, { once: true });
        if (signal.aborted || this.ended || this.buffered >= size) done();
      });
    }
    signal.throwIfAborted();
    const result = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const chunk = this.chunks[0]!;
      const length = Math.min(size - offset, chunk.length);
      chunk.copy(result, offset, 0, length);
      if (length === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(length);
      offset += length;
    }
    this.buffered -= size;
    return result;
  }
  private send(bytes: Buffer, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.ended || this.socket.destroyed) throw new Error('Desktop disconnected');
    this.socket.write(bytes);
  }
  static async connect(socketPath: string, signal: AbortSignal): Promise<DesktopRfb> {
    if (!socketPath.startsWith('/') || socketPath.includes('\0'))
      throw new Error('Desktop requires an absolute Unix socket');
    // The request's signal bounds connection setup only. Passing it to
    // net.connect would also close a successfully established persistent
    // desktop when that request's timeout later expires.
    const socket = connect({ path: socketPath });
    // Install the reader before awaiting connect: the server can write immediately.
    const client = new DesktopRfb(socket);
    try {
      await once(socket, 'connect', { signal });
      const version = (await client.read(12, signal)).toString('ascii');
      if (!/^RFB 003\.00[38]\n$/.test(version)) throw new Error('Unsupported desktop protocol');
      client.send(Buffer.from('RFB 003.008\n'), signal);
      const count = (await client.read(1, signal))[0]!;
      if (!count || !(await client.read(count, signal)).includes(1))
        throw new Error('Unsupported desktop security');
      client.send(Buffer.from([1]), signal);
      if ((await client.read(4, signal)).readUInt32BE() !== 0)
        throw new Error('Desktop security negotiation failed');
      client.send(Buffer.from([1]), signal);
      const header = await client.read(24, signal);
      const width = header.readUInt16BE(0);
      const height = header.readUInt16BE(2);
      const nameLength = header.readUInt32BE(20);
      if (!width || !height || width > 2048 || height > 2048 || nameLength > 4096)
        throw new Error('Unsupported desktop dimensions');
      await client.read(nameLength, signal);
      // Request 32-bit little-endian true colour (B, G, R, padding).
      const format = Buffer.alloc(20);
      format[4] = 32;
      format[5] = 24;
      format[7] = 1;
      format.writeUInt16BE(255, 8);
      format.writeUInt16BE(255, 10);
      format.writeUInt16BE(255, 12);
      format[14] = 16;
      format[15] = 8;
      client.send(format, signal);
      // Raw rectangles only; no clipboard, resize or extension negotiation.
      client.send(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]), signal);
      client.desktopWidth = width;
      client.desktopHeight = height;
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }
  private async frame(signal: AbortSignal): Promise<Uint8Array> {
    const frameWidth = this.width;
    const frameHeight = this.height;
    const request = Buffer.alloc(10);
    request[0] = 3;
    request.writeUInt16BE(frameWidth, 6);
    request.writeUInt16BE(frameHeight, 8);
    this.send(request, signal);
    // Bells are one-byte asynchronous RFB server messages, and can arrive
    // between input and its framebuffer acknowledgement. They carry no input
    // authority and are ignored; other unsolicited messages remain unsupported.
    let bells = 0;
    for (;;) {
      const type = (await this.read(1, signal))[0]!;
      if (type === 0) break;
      if (type !== 2 || ++bells > 64) throw new Error('Unsupported desktop message');
    }
    const header = await this.read(3, signal);
    const rectangles = header.readUInt16BE(1);
    if (!rectangles || rectangles > 4096) throw new Error('Unsupported desktop message');
    const image = Buffer.alloc(frameWidth * frameHeight * 4);
    const covered = new Uint8Array(frameWidth * frameHeight);
    let count = 0;
    for (let i = 0; i < rectangles; i++) {
      const rect = await this.read(12, signal);
      const x = rect.readUInt16BE(0),
        y = rect.readUInt16BE(2);
      const width = rect.readUInt16BE(4),
        height = rect.readUInt16BE(6);
      if (
        !width ||
        !height ||
        rect.readInt32BE(8) !== 0 ||
        x + width > frameWidth ||
        y + height > frameHeight
      )
        throw new Error('Invalid desktop rectangle');
      const pixels = await this.read(width * height * 4, signal);
      for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
          const source = (row * width + col) * 4;
          const target = ((y + row) * frameWidth + x + col) * 4;
          const index = target / 4;
          if (covered[index]) throw new Error('Overlapping desktop rectangles');
          covered[index] = 1;
          count++;
          image[target] = pixels[source + 2]!;
          image[target + 1] = pixels[source + 1]!;
          image[target + 2] = pixels[source]!;
          image[target + 3] = 255;
        }
      }
    }
    if (count !== frameWidth * frameHeight) throw new Error('Incomplete desktop picture');
    return image;
  }
  async capture(signal: AbortSignal): Promise<Uint8Array> {
    if (this.busy) throw new Error('Desktop operation already in progress');
    this.busy = true;
    try {
      return await this.frame(signal);
    } catch (error) {
      this.close();
      throw error;
    } finally {
      this.busy = false;
    }
  }
  async input(
    action: Extract<BrowserHumanAction, { type: 'key' | 'text' | 'click' | 'drag' | 'scroll' }>,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.busy) throw new Error('Desktop operation already in progress');
    // The caller is trusted infrastructure, but still validate at this process
    // boundary before constructing any effectful protocol messages.
    action = browserHumanActionSchema.parse(action) as typeof action;
    const messages: Buffer[] = [];
    let position = this.pointerPosition;
    const key = (value: number, down: boolean): void => {
      const bytes = Buffer.alloc(8);
      bytes[0] = 4;
      bytes[1] = down ? 1 : 0;
      bytes.writeUInt32BE(value, 4);
      messages.push(bytes);
    };
    const pointer = (x: number, y: number, buttons: number): void => {
      if (
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        x < 0 ||
        y < 0 ||
        x >= this.width ||
        y >= this.height
      )
        throw new Error('Desktop point outside frame');
      const bytes = Buffer.alloc(6);
      bytes[0] = 5;
      bytes[1] = buttons;
      bytes.writeUInt16BE(x, 2);
      bytes.writeUInt16BE(y, 4);
      messages.push(bytes);
      position = { x, y };
    };
    const keys: Record<string, number> = {
      Enter: 0xff0d,
      Tab: 0xff09,
      Escape: 0xff1b,
      Backspace: 0xff08,
      Delete: 0xffff,
      ArrowUp: 0xff52,
      ArrowDown: 0xff54,
      ArrowLeft: 0xff51,
      ArrowRight: 0xff53,
      Home: 0xff50,
      End: 0xff57,
      PageUp: 0xff55,
      PageDown: 0xff56,
      Space: 0x20,
    };
    const mods: Record<string, number> = { shift: 0xffe1, ctrl: 0xffe3, alt: 0xffe9, meta: 0xffe7 };
    const symbol = (value: string): number => {
      const code = value.codePointAt(0);
      if (keys[value] !== undefined) return keys[value]!;
      if (code === undefined || Array.from(value).length !== 1 || code < 0x20 || code === 0x7f)
        throw new Error('Unsupported desktop key');
      return code <= 0xff ? code : 0x01000000 + code;
    };
    if (action.type === 'text') {
      for (const char of action.text) {
        const k = symbol(char);
        key(k, true);
        key(k, false);
      }
    } else if (action.type === 'key') {
      for (const mod of action.modifiers) key(mods[mod]!, true);
      const k = symbol(action.key);
      key(k, true);
      key(k, false);
      for (const mod of [...action.modifiers].reverse()) key(mods[mod]!, false);
    } else if (action.type === 'click') {
      for (const mod of action.modifiers) key(mods[mod]!, true);
      const button = action.button === 'left' ? 1 : action.button === 'middle' ? 2 : 4;
      for (let i = 0; i < action.count; i++) {
        pointer(action.point.x, action.point.y, button);
        pointer(action.point.x, action.point.y, 0);
      }
      for (const mod of [...action.modifiers].reverse()) key(mods[mod]!, false);
    } else if (action.type === 'drag') {
      pointer(action.from.x, action.from.y, 1);
      pointer(action.to.x, action.to.y, 1);
      pointer(action.to.x, action.to.y, 0);
    } else {
      if (action.point) pointer(action.point.x, action.point.y, 0);
      if (!position || (!action.dx && !action.dy))
        throw new Error('Desktop scroll requires a pointer position and direction');
      const { x, y } = position;
      for (const [delta, negative, positive] of [
        [action.dy, 8, 16],
        [action.dx, 32, 64],
      ] as const) {
        for (let i = 0; i < Math.ceil(Math.abs(delta) / 100); i++) {
          pointer(x, y, delta < 0 ? negative : positive);
          pointer(x, y, 0);
        }
      }
    }
    this.busy = true;
    try {
      this.send(Buffer.concat(messages), signal);
      // This ordered request acknowledges protocol delivery. A failure after
      // dispatch is an unknown effect and must never be retried.
      await this.frame(signal);
      signal.throwIfAborted();
      this.pointerPosition = position;
    } catch (error) {
      this.close();
      throw error;
    } finally {
      this.busy = false;
    }
  }
  close(): void {
    this.socket.destroy();
  }
}
