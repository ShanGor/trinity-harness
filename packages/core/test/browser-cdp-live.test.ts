import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { browserResultSchema } from '@trinity-harness/contracts';
import {
  CoreToolRegistry,
  LocalBlobStore,
  LocalSandbox,
  MemorySessionStore,
  TrustedCdpBrowserAccess,
  createBrowserTool,
  createResearchTool,
} from '../src/index.js';

/** Explicit opt-in only: local controlled fixture, existing user-owned CDP, no public sites. */
it.skipIf(!process.env['TRINITY_TEST_CDP_ENDPOINT'])(
  'captures and cites a controlled fixture through existing CDP Chrome',
  async () => {
    const endpoint = process.env['TRINITY_TEST_CDP_ENDPOINT']!;
    const fixture = createServer((_request, response) => {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      });
      response.end(
        '<!doctype html><title>Trinity CDP fixture</title><main><h1>Primary evidence</h1><p>论文标题：Example 查看更多 期刊：Nature “原文” 😀</p><p hidden>HIDDEN</p><pre>code\n  indentation</pre><a href="/source">Source</a><button onclick="document.getElementById(\'more\').hidden=false">Expand</button><p id="more" hidden>Expanded evidence.</p><input aria-label="Search"></main>' +
          '<button>Additional interaction target with a long accessible name</button>'.repeat(100),
      );
    });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('fixture address unavailable');
    const url = `http://127.0.0.1:${address.port}/fixture`;
    const root = await mkdtemp(path.join(tmpdir(), 'trinity-cdp-fixture-'));
    const sandbox = new LocalSandbox(root);
    const store = new MemorySessionStore();
    const sessionId = crypto.randomUUID();
    const blobs = new LocalBlobStore(path.join(root, 'blobs'));
    const access = new TrustedCdpBrowserAccess({
      endpoint,
      sandbox,
      store,
      authorizeSession: async (id) => id === sessionId,
    });
    const registry = new CoreToolRegistry(sandbox);
    registry.register(
      createBrowserTool({ store, blobs, access, now: () => new Date('2026-01-01T00:00:00.000Z') }),
    );
    registry.register(createResearchTool(store, blobs));
    const meta = () => ({ eventId: crypto.randomUUID(), at: '2026-01-01T00:00:00.000Z' });
    const run = async (id: string, name: string, args: unknown) => {
      await store.append(sessionId, [{ ...meta(), type: 'tool/call', callId: id, name, args }]);
      const result = await registry.execute(
        { id, name, args },
        { sessionId, workspaceRoot: root, permissionGranted: true },
      );
      await store.append(sessionId, [{ ...meta(), type: 'tool/result', callId: id, ...result }]);
      return result;
    };
    let cliSession: string | undefined;
    try {
      await store.append(sessionId, [
        {
          ...meta(),
          type: 'message/user',
          surfaceOp: 'append',
          content: [{ kind: 'text', text: 'Read the controlled fixture' }],
        },
      ]);
      cliSession = (await access.authorize(sessionId, 'navigate', url)).cliSession;
      const navigation = await run('navigate', 'browser', { operation: 'navigate', url });
      expect(navigation.isError, JSON.stringify(navigation.value)).toBe(false);
      const value = browserResultSchema.parse(navigation.value);
      expect(value.securityMode).toBe('trusted-cdp');
      expect(value.snapshot!.truncated).toBe(true);
      expect(value.snapshot!.targets.length).toBeLessThan(100);
      expect(value.url).toBe(url);
      expect(value.blocks.map((b) => b.text).join('\n')).toContain(
        '论文标题：Example 查看更多 期刊：Nature “原文” 😀',
      );
      expect(value.blocks.map((b) => b.text).join('\n')).not.toContain('HIDDEN');
      const paragraph = value.blocks.find((b) => b.kind === 'paragraph')!;
      expect(
        await run('notes', 'research', {
          action: 'record',
          notes: {
            question: 'What does the fixture say?',
            findings: [
              {
                claim: 'The fixture preserves original punctuation.',
                relation: 'context',
                sources: [{ observationId: value.observationId, blockId: paragraph.id }],
              },
            ],
            openQuestions: [],
            readyToAnswer: true,
          },
        }),
      ).toMatchObject({ isError: false });
      const snapshot = browserResultSchema.parse(
        (await run('snapshot', 'browser', { operation: 'read_page' })).value,
      );
      const expand = snapshot.snapshot!.targets.find((t) => t.name === 'Expand')!;
      const clicked = await run('click', 'browser', {
        operation: 'click',
        snapshotId: snapshot.observationId,
        ref: expand.ref,
        readiness: { text: 'Expanded evidence.', timeoutMs: 3000 },
      });
      expect(clicked.isError, JSON.stringify(clicked.value)).toBe(false);
      const after = browserResultSchema.parse(clicked.value);
      expect(after.blocks.map((b) => b.text).join('\n'), JSON.stringify(after)).toContain(
        'Expanded evidence.',
      );
      const input = after.snapshot!.targets.find((t) => t.name === 'Search')!;
      const filled = await run('fill', 'browser', {
        operation: 'fill',
        snapshotId: after.observationId,
        ref: input.ref,
        text: 'fixture query',
      });
      expect(filled.isError, JSON.stringify(filled.value)).toBe(false);
      const shot = await run('shot', 'browser', {
        operation: 'screenshot',
        crop: { x: 0, y: 0, width: 300, height: 200 },
      });
      expect(shot.isError, JSON.stringify(shot.value)).toBe(false);
      expect(browserResultSchema.parse(shot.value).image).toMatchObject({
        width: 300,
        height: 200,
      });
      expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(6144);
    } finally {
      // Close only the task-owned pinned tab. Never close the attached browser/other tabs.
      if (cliSession)
        await sandbox.execArgv(
          'agent-browser',
          ['--session', cliSession, '--cdp', endpoint, '--pin-tab', '--json', 'tab', 'close'],
          { maxOutputBytes: 4096, timeoutMs: 10_000 },
        );
      fixture.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        fixture.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
