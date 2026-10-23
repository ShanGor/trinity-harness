import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createServer as createViteServer } from 'vite';
import { expect, it } from 'vitest';
import config from '../vite.config.js';

it('closes a proxied SSE response when the backend connection is interrupted', async () => {
  let upstream: ServerResponse | undefined;
  let nextSeq = 7;
  let lastUrl: string | undefined;
  const backend = createServer((request, response) => {
    lastUrl = request.url;
    if (request.url === '/api/health') {
      response.end('ok');
      return;
    }
    upstream = response;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`id: ${nextSeq++}\ndata: message\n\n`);
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const backendAddress = backend.address();
  if (!backendAddress || typeof backendAddress === 'string') throw new Error('Missing port');
  const configuredProxy = config.server!.proxy!['/api'];
  const vite = await createViteServer({
    configFile: false,
    server: {
      host: '127.0.0.1',
      port: 0,
      hmr: false,
      watch: null,
      proxy: {
        '/api': {
          ...(typeof configuredProxy === 'string' ? {} : configuredProxy),
          target: `http://127.0.0.1:${backendAddress.port}`,
        },
      },
    },
    logLevel: 'silent',
  });
  const controller = new AbortController();
  const deadline = AbortSignal.timeout(3000);
  try {
    await vite.listen();
    const address = vite.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('Missing proxy port');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const signal = AbortSignal.any([controller.signal, deadline]);
    expect(await (await fetch(`${baseUrl}/api/health`, { signal })).text()).toBe('ok');
    const response = await fetch(`${baseUrl}/api/sessions/test/events`, {
      signal,
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('id: 7');
    const closed = reader.read().then(
      ({ done }) => done,
      () => true,
    );
    upstream!.destroy();
    await expect(closed).resolves.toBe(true);
    expect(deadline.aborted).toBe(false);
    const resumed = await fetch(`${baseUrl}/api/sessions/test/events?afterSeq=7`, { signal });
    const resumedReader = resumed.body!.getReader();
    expect(new TextDecoder().decode((await resumedReader.read()).value)).toContain('id: 8');
    expect(lastUrl).toBe('/api/sessions/test/events?afterSeq=7');
    await resumedReader.cancel();
  } finally {
    controller.abort();
    backend.closeAllConnections();
    await Promise.all([
      vite.close(),
      new Promise<void>((resolve) => backend.close(() => resolve())),
    ]);
  }
}, 5000);
