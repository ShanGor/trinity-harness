import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalSandbox } from '@trinity-harness/core';
import { GuestDesktop } from '../src/desktop.js';

describe.skipIf(process.env['DESKTOP_INTEGRATION'] !== '1')('real desktop bell handling', () => {
  let root: string;
  let sandbox: LocalSandbox;
  let desktop: GuestDesktop;
  const signal = AbortSignal.timeout(30_000);
  beforeAll(async () => {
    const xvfb = process.env['DESKTOP_XVFB'];
    const x11vnc = process.env['DESKTOP_X11VNC'];
    const xdotool = process.env['DESKTOP_XDOTOOL'];
    const xwd = process.env['DESKTOP_XWD'];
    const xclip = process.env['DESKTOP_XCLIP'];
    if (
      !xvfb ||
      !x11vnc ||
      !xdotool ||
      !xwd ||
      !xclip ||
      ![xvfb, x11vnc, xdotool, xwd, xclip].every(path.isAbsolute)
    )
      throw new Error('Desktop fixture binaries must be absolute');
    root = await mkdtemp(path.join(os.tmpdir(), 'trinity-desktop-bell-'));
    sandbox = new LocalSandbox(root);
    const manager = path.join(root, 'window-manager');
    const wrapper = path.join(root, 'x11vnc-with-bell');
    await writeFile(manager, '#!/bin/sh\nexec /bin/sleep 60\n');
    // Enable bells deliberately so the real server exercises the client's
    // asynchronous message parser, despite the production -nobell setting.
    await writeFile(
      wrapper,
      `#!/bin/bash\nargs=()\nfor arg in "$@"; do [[ "$arg" == -nobell ]] || args+=("$arg"); done\nexec "$DESKTOP_X11VNC" "\${args[@]}"\n`,
    );
    await chmod(manager, 0o700);
    await chmod(wrapper, 0o700);
    await writeFile(
      path.join(root, 'bell.c'),
      '#include <X11/Xlib.h>\nint main(void){Display*d=XOpenDisplay(0);if(!d)return 1;XBell(d,0);XSync(d,False);XCloseDisplay(d);return 0;}\n',
    );
    const compiled = await sandbox.execArgv('/usr/bin/cc', ['bell.c', '-o', 'bell', '-lX11'], {
      signal,
      maxOutputBytes: 4096,
    });
    expect(compiled.exitCode).toBe(0);
    desktop = await GuestDesktop.launch(
      sandbox,
      {
        runtimeDirectory: root,
        xvfb,
        x11vnc: wrapper,
        windowManager: manager,
        xdotool,
        xwd,
        xclip,
        env: {
          DESKTOP_X11VNC: x11vnc,
          ...(process.env['LD_LIBRARY_PATH']
            ? { LD_LIBRARY_PATH: process.env['LD_LIBRARY_PATH'] }
            : {}),
        },
      },
      signal,
    );
  });
  afterAll(async () => {
    await desktop?.dispose();
    if (root) await rm(root, { recursive: true, force: true });
  });
  it('accepts a pointer action after the X server emits a bell', async () => {
    const frame = await desktop.capture(signal);
    const bell = await sandbox.execArgv(path.join(root, 'bell'), [], {
      env: desktop.environment(),
      signal,
      maxOutputBytes: 1024,
    });
    expect(bell.exitCode).toBe(0);
    const wait = AbortSignal.timeout(500);
    await new Promise<void>((resolve) =>
      wait.addEventListener('abort', () => resolve(), { once: true }),
    );
    expect(
      await desktop.input(
        { type: 'click', point: { x: 40, y: 40 }, button: 'left', count: 1, modifiers: [] },
        {
          width: frame.width,
          height: frame.height,
          ...(frame.focusRevision ? { focusRevision: frame.focusRevision } : {}),
        },
        signal,
      ),
    ).toBe('applied');
  });
});
