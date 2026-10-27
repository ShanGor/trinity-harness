import { randomBytes } from 'node:crypto';
import { watch } from 'node:fs';
import { chmod, chown, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  BrowserHumanAction,
  GuestEnvelope,
  GuestValue,
  LongRunningProcess,
  SandboxPort,
} from '@trinity-harness/contracts';
import { DesktopRfb } from './desktop-rfb.js';
import { encodeDesktopPng } from './desktop-png.js';
import { decodeDesktopXwd } from './desktop-xwd.js';

type DesktopAction = Extract<
  BrowserHumanAction,
  { type: 'click' | 'drag' | 'scroll' | 'key' | 'text' }
>;
type DesktopTarget = Extract<GuestEnvelope['operation'], { kind: 'desktopInput' }>['target'];

function authority(): Buffer {
  const name = Buffer.from('MIT-MAGIC-COOKIE-1');
  const cookie = randomBytes(16);
  const word = (n: number): Buffer => {
    const bytes = Buffer.alloc(2);
    bytes.writeUInt16BE(n);
    return bytes;
  };
  return Buffer.concat([
    word(0xffff),
    word(0),
    word(0),
    word(name.length),
    name,
    word(cookie.length),
    cookie,
  ]);
}
async function waitForSocket(
  directory: string,
  target: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let checking = false;
    let finished = false;
    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      watcher.close();
      signal.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve();
    };
    const check = (): void => {
      if (checking || finished) return;
      checking = true;
      void lstat(target).then(
        (stat) => {
          checking = false;
          if (!stat.isSocket()) finish(new Error('Invalid desktop socket'));
          else finish();
        },
        (error: unknown) => {
          checking = false;
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
            finish(new Error('Desktop socket unavailable'));
        },
      );
    };
    const aborted = (): void => finish(new Error('Desktop socket unavailable'));
    const watcher = watch(directory, check);
    watcher.on('error', finish);
    signal.addEventListener('abort', aborted, { once: true });
    check();
    if (signal.aborted) aborted();
  });
}
async function displayName(child: LongRunningProcess, signal: AbortSignal): Promise<string> {
  const iterator = child.chunks()[Symbol.asyncIterator]();
  let text = '';
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, value?: IteratorResult<Uint8Array>): void => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', abort);
          if (error) reject(error);
          else resolve(value!);
        };
        const abort = (): void => finish(new Error('Display startup cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        void child.exited.then(() => finish(new Error('Display exited')));
        void iterator.next().then(
          (value) => finish(undefined, value),
          () => finish(new Error('Display output failed')),
        );
        if (signal.aborted) abort();
      });
      if (next.done) throw new Error('Display exited');
      text += Buffer.from(next.value).toString('ascii');
      if (text.length > 16) throw new Error('Invalid display number');
      if (text.includes('\n')) {
        const number = text.trim();
        if (!/^\d{1,5}$/.test(number)) throw new Error('Invalid display number');
        void (async () => {
          for (;;) {
            if ((await iterator.next()).done) break;
          }
        })().catch(() => undefined);
        return `:${number}`;
      }
    }
  } catch (error) {
    child.kill();
    throw error;
  }
}

/** Isolated guest display infrastructure; it does not authorize browser input. */
export class GuestDesktop {
  private readonly lost = new AbortController();
  private readonly children: LongRunningProcess[] = [];
  private client: DesktopRfb | undefined;
  private closing = false;
  private closed: Promise<void> | undefined;
  private busy = false;
  private directory = '';
  private socketPath = '';
  private display = '';
  private auth = '';
  private constructor(
    private readonly sandbox: SandboxPort,
    private readonly env: Record<string, string>,
    private readonly xdotool: string,
    private readonly xwd: string,
    private readonly xclip: string,
  ) {}
  static async launch(
    sandbox: SandboxPort,
    config: {
      runtimeDirectory: string;
      xvfb: string;
      x11vnc: string;
      windowManager: string;
      xdotool: string;
      xwd: string;
      xclip: string;
      chromeGid?: number;
      env?: Record<string, string>;
    },
    signal: AbortSignal,
  ): Promise<GuestDesktop> {
    if (
      ![
        config.runtimeDirectory,
        config.xvfb,
        config.x11vnc,
        config.windowManager,
        config.xdotool,
        config.xwd,
        config.xclip,
      ].every(path.isAbsolute)
    )
      throw new Error('Desktop paths must be operator-owned absolute paths');
    const desktop = new GuestDesktop(
      sandbox,
      config.env ?? {},
      config.xdotool,
      config.xwd,
      config.xclip,
    );
    try {
      desktop.directory = await mkdtemp(path.join(config.runtimeDirectory, 'display-'));
      desktop.auth = path.join(desktop.directory, 'Xauthority');
      desktop.socketPath = path.join(desktop.directory, 'rfb.sock');
      await writeFile(desktop.auth, authority(), { mode: 0o600 });
      if (config.chromeGid !== undefined) {
        const uid = process.getuid?.();
        if (uid === undefined || !Number.isInteger(config.chromeGid) || config.chromeGid < 1)
          throw new Error('Desktop identity unavailable');
        await chown(desktop.directory, uid, config.chromeGid);
        await chmod(desktop.directory, 0o710);
        await chown(desktop.auth, uid, config.chromeGid);
        await chmod(desktop.auth, 0o640);
      }
      const startup = AbortSignal.any([signal, desktop.lost.signal, AbortSignal.timeout(20_000)]);
      const display = desktop.start(config.xvfb, [
        '-displayfd',
        '1',
        '-screen',
        '0',
        '1920x1080x24',
        '-nolisten',
        'tcp',
        '-auth',
        desktop.auth,
      ]);
      desktop.display = await displayName(display, startup);
      const env = desktop.environment();
      desktop.start(config.windowManager, [], env, true);
      desktop.start(
        config.x11vnc,
        [
          '-display',
          desktop.display,
          '-auth',
          desktop.auth,
          '-unixsock',
          desktop.socketPath,
          '-rfbport',
          '0',
          '-no6',
          '-nopw',
          '-forever',
          '-noxdamage',
          '-nobell',
          '-nosel',
          '-xkb',
        ],
        env,
        true,
      );
      await waitForSocket(desktop.directory, desktop.socketPath, startup);
      if (config.chromeGid !== undefined) {
        const stat = await lstat(desktop.socketPath);
        if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
          throw new Error('Desktop socket permissions are unsafe');
      }
      desktop.client = await DesktopRfb.connect(desktop.socketPath, startup);
      startup.throwIfAborted();
      return desktop;
    } catch (error) {
      await desktop.dispose();
      throw error;
    }
  }
  private start(
    binary: string,
    args: string[],
    env?: Record<string, string>,
    drain = false,
  ): LongRunningProcess {
    const child = this.sandbox.openProcess(binary, args, {
      processGroup: true,
      env: { ...this.env, ...env },
    });
    this.children.push(child);
    void child.exited.then(() => {
      if (!this.closing) this.lost.abort();
    });
    if (drain)
      void (async () => {
        let bytes = 0;
        for await (const chunk of child.chunks()) {
          bytes += chunk.byteLength;
          if (bytes > 1024 * 1024) {
            child.kill();
            break;
          }
        }
      })().catch(() => child.kill());
    return child;
  }
  environment(): Record<string, string> {
    return { DISPLAY: this.display, XAUTHORITY: this.auth };
  }
  get signal(): AbortSignal {
    return this.lost.signal;
  }
  private async connection(signal: AbortSignal): Promise<DesktopRfb> {
    this.lost.signal.throwIfAborted();
    this.client ??= await DesktopRfb.connect(this.socketPath, signal);
    return this.client;
  }
  private async focus(signal: AbortSignal): Promise<string | undefined> {
    if (!this.sandbox.execArgv) throw new Error('Desktop focus inspection unavailable');
    const result = await this.sandbox.execArgv(this.xdotool, ['getwindowfocus'], {
      env: { ...this.env, ...this.environment() },
      signal,
      timeoutMs: 2000,
      maxOutputBytes: 64,
    });
    if (result.exitCode !== 0 || result.outputOverflow) return undefined;
    const focus = result.stdout.trim();
    return /^[0-9]{1,20}$/.test(focus) ? focus : undefined;
  }
  private async framebuffer(signal: AbortSignal): Promise<ReturnType<typeof decodeDesktopXwd>> {
    const child = this.sandbox.openProcess(this.xwd, ['-root', '-silent'], {
      env: { ...this.env, ...this.environment() },
      processGroup: true,
      signal,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of child.chunks()) {
        size += chunk.byteLength;
        if (size > 2048 * 2048 * 4 + 8192) throw new Error('Desktop framebuffer overflow');
        chunks.push(Buffer.from(chunk));
      }
      const exit = await child.exited;
      signal.throwIfAborted();
      if (exit !== 0) throw new Error('Desktop framebuffer unavailable');
      return decodeDesktopXwd(Buffer.concat(chunks));
    } finally {
      child.kill();
      await child.exited;
    }
  }
  private async pasteText(
    client: DesktopRfb,
    text: string,
    focus: string,
    signal: AbortSignal,
  ): Promise<void> {
    signal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const file = path.join(this.directory, `text-${randomBytes(16).toString('hex')}`);
    let child: LongRunningProcess | undefined;
    try {
      await writeFile(file, text, { mode: 0o600, flag: 'wx' });
      // xclip reports selection ownership on stderr; route only its fixed
      // diagnostic stream to stdout without interpolating the input or path.
      child = this.sandbox.openProcess(
        '/bin/sh',
        [
          '-c',
          'exec "$@" 2>&1',
          'desktop-text',
          this.xclip,
          '-selection',
          'clipboard',
          '-loops',
          '1',
          '-verbose',
          file,
        ],
        {
          env: { ...this.env, ...this.environment() },
          processGroup: true,
          signal,
        },
      );
      const iterator = child.chunks()[Symbol.asyncIterator]();
      let output = '';
      for (;;) {
        signal.throwIfAborted();
        const next = await iterator.next();
        if (next.done) throw new Error('Desktop text transfer unavailable');
        output += Buffer.from(next.value).toString('utf8');
        if (output.length > 4096) throw new Error('Invalid desktop text transfer');
        if (output.includes('Waiting for one selection request.')) break;
      }
      await rm(file, { force: true });
      if ((await this.focus(signal)) !== focus) throw new Error('Desktop focus changed');
      await client.input({ type: 'key', key: 'v', modifiers: ['ctrl'] }, signal);
      if ((await child.exited) !== 0) throw new Error('Desktop text transfer failed');
      signal.throwIfAborted();
    } finally {
      child?.kill();
      if (child) await child.exited;
      await rm(file, { force: true });
    }
  }
  async capture(signal: AbortSignal): Promise<Extract<GuestValue, { kind: 'desktopFrame' }>> {
    if (this.busy) throw new Error('Desktop operation busy');
    this.busy = true;
    const active = AbortSignal.any([signal, this.lost.signal]);
    try {
      const capturedAt = new Date().toISOString();
      const picture = await this.framebuffer(active);
      const focusRevision = await this.focus(active);
      const png = encodeDesktopPng(picture.rgba, picture.width, picture.height).toString('base64');
      active.throwIfAborted();
      return {
        kind: 'desktopFrame',
        width: picture.width,
        height: picture.height,
        capturedAt,
        ...(focusRevision ? { focusRevision } : {}),
        png,
      };
    } finally {
      this.busy = false;
    }
  }
  async input(
    action: DesktopAction,
    target: DesktopTarget,
    signal: AbortSignal,
  ): Promise<'applied' | 'none'> {
    if (this.busy) throw new Error('Desktop operation busy');
    this.busy = true;
    const active = AbortSignal.any([signal, this.lost.signal]);
    try {
      const client = await this.connection(active);
      try {
        if (client.width !== target.width || client.height !== target.height) return 'none';
        if (action.type === 'key' || action.type === 'text') {
          if (!target.focusRevision || (await this.focus(active)) !== target.focusRevision)
            return 'none';
        }
        if (action.type === 'text' && /[^\x20-\x7e]/u.test(action.text)) {
          await this.pasteText(client, action.text, target.focusRevision!, active);
        } else if (action.type === 'key' && /[^\x20-\x7e]/u.test(action.key)) {
          if (action.modifiers.length) throw new Error('Unsupported modified desktop key');
          await this.pasteText(client, action.key, target.focusRevision!, active);
        } else {
          await client.input(action, active);
        }
        return 'applied';
      } catch (error) {
        client.close();
        if (this.client === client) this.client = undefined;
        throw error;
      }
    } finally {
      this.busy = false;
    }
  }
  async dispose(): Promise<void> {
    this.closed ??= (async () => {
      this.closing = true;
      this.lost.abort();
      this.client?.close();
      for (const child of this.children) child.kill();
      await Promise.all(this.children.map((child) => child.exited));
      if (this.directory) await rm(this.directory, { recursive: true, force: true });
    })();
    await this.closed;
  }
}
