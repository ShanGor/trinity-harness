import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  parsePermissionPolicy,
  type LLMPort,
  type ToolDefinition,
  type SessionEvent,
} from '@trinity-harness/contracts';
import {
  AiSdkGateway,
  CoreAgentLoop,
  CoreToolRegistry,
  LocalSandbox,
  LocalBlobStore,
  MemorySessionStore,
  TrustedCdpBrowserAccess,
  createBrowserTool,
  createResearchTool,
} from '../src/index.js';
import { browserDeliveries, browserPromptIndex } from '../src/tools/browser-artifacts.js';
import { literalCommandArgv } from '../src/tools/command-prefix.js';
import { unwrapBrowserCliOutput } from '../src/tools/browser-cdp.js';

const tasks = [
  {
    name: 'article',
    question:
      'Quote the original Chinese evidence with its punctuation and intervening text. State the important species limitation; do not infer human efficacy.',
    html: `<article><h1>Semaglutide fixture</h1><p>论文标题：Late-life treatment 查看更多 期刊：Nature “原文” 😀</p>${'<p>Background discussion about study design and unrelated historical context.</p>'.repeat(130)}<p>Limitation: only aged mice; human benefit is unproven.</p></article>`,
    checks: [
      /论文标题：Late-life treatment 查看更多 期刊：Nature “原文” 😀/,
      /mice/i,
      /human.*(unproven|not|uncertain)|no.*human/i,
    ],
  },
  {
    name: 'table',
    question:
      'Distinguish MCP Apps UI hosting, MCP server tools and Agent Store distribution. Is a Teams interactive MCP Apps roadmap established by this evidence?',
    html: '<main><h1>Teams and MCP fixture</h1><table><tr><th>Product</th><th>Capability</th><th>Roadmap status</th></tr><tr><td>Microsoft 365 Copilot</td><td>Interactive MCP Apps UI hosting</td><td>Announced</td></tr><tr><td>Teams</td><td>MCP server tools</td><td>Available</td></tr><tr><td>Agent Store</td><td>Distribution to Teams</td><td>Distribution only</td></tr></table><p>These documents do not establish a Teams interactive MCP Apps UI roadmap. Absence here does not prove there are no plans.</p></main>',
    checks: [
      /Copilot/i,
      /server.*tool|tool.*server/i,
      /distribution/i,
      /not.*(establish|prove)|uncertain|unconfirmed/i,
    ],
  },
  {
    name: 'documentation',
    question:
      'Quote the exact code example, preserving indentation. Explain its default egress policy and the opt-in exception.',
    html: '<main><h1>Network configuration</h1><pre>const policy = {\n  egress: false,\n  allow: []\n};</pre><p>Outbound network is denied by default. An administrator may explicitly allow a task destination. A browser URL check alone is not a network firewall.</p></main>',
    checks: [
      /const policy = \{\n {2}egress: false,\n {2}allow: \[\]\n\};/,
      /denied|disabled|off/i,
      /administrator/i,
      /firewall/i,
    ],
  },
  {
    name: 'interaction',
    question:
      'Expand the study caveats before answering. Report the visible result AND the revealed caveat. Do not assume hidden content was read.',
    html: '<main><h1>Study</h1><p>Visible result: treatment improved the measured outcome.</p><button onclick="document.getElementById(\'caveat\').hidden=false">Show caveats</button><p id="caveat" hidden>Caveat: the trial excluded frail adults and does not establish safety for that group.</p></main>',
    checks: [/improv/i, /frail/i, /excluded/i, /safety/i],
  },
] as const;
const modes = ['legacy', 'capture', 'interaction'] as const;

/** Explicit opt-in live/model evaluation, separate from deterministic CI. */
it.skipIf(process.env['TRINITY_RUN_BROWSER_EVAL'] !== '1')(
  'compares fixed research tasks with the same configured model',
  async () => {
    const endpoint = process.env['TRINITY_TEST_CDP_ENDPOINT'];
    const model = process.env['MODEL'];
    if (!endpoint || !model) throw new Error('Set TRINITY_TEST_CDP_ENDPOINT and MODEL');
    const repeats = Number(process.env['TRINITY_BROWSER_EVAL_REPEATS'] ?? 2);
    if (!Number.isInteger(repeats) || repeats < 2 || repeats > 5)
      throw new Error('Use 2–5 repeats');
    const root = await mkdtemp(path.join(tmpdir(), 'trinity-browser-eval-'));
    const fixture = createServer((request, response) => {
      const task = tasks.find((t) => request.url === `/${t.name}`);
      response.writeHead(task ? 200 : 404, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      });
      response.end(
        `<!doctype html><title>Controlled ${task?.name ?? 'missing'} fixture</title>${task?.html ?? '<p>Missing</p>'}`,
      );
    });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('fixture unavailable');
    const origin = `http://127.0.0.1:${address.port}`;
    const extractor = await readFile(
      new URL('../../../skills/agent-browser/scripts/extract-page.js', import.meta.url),
      'utf8',
    );
    const results: Record<string, unknown>[] = [];
    const gateway = new AiSdkGateway(undefined, { thinkingType: 'adaptive' });
    try {
      const jobs = Array.from({ length: repeats }, (_, repeat) =>
        tasks
          .filter(
            (task) =>
              !process.env['TRINITY_BROWSER_EVAL_TASKS'] ||
              process.env['TRINITY_BROWSER_EVAL_TASKS']!.split(',').includes(task.name),
          )
          .flatMap((task) =>
            modes
              .filter(
                (mode) =>
                  !process.env['TRINITY_BROWSER_EVAL_MODES'] ||
                  process.env['TRINITY_BROWSER_EVAL_MODES']!.split(',').includes(mode),
              )
              .map((mode) => ({ repeat, task, mode })),
          ),
      ).flat();
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < jobs.length) {
          const { repeat, task, mode } = jobs[next++]!;
          const sessionId = crypto.randomUUID();
          const sandbox = new LocalSandbox(root);
          const store = new MemorySessionStore();
          const blobs = new LocalBlobStore(path.join(root, 'blobs'));
          const access = new TrustedCdpBrowserAccess({
            endpoint,
            sandbox,
            store,
            authorizeSession: async (id) => id === sessionId,
          });
          const binding = await access.authorize(sessionId, 'navigate', `${origin}/${task.name}`);
          const flags = ['--session', binding.cliSession, '--cdp', endpoint, '--pin-tab', '--json'];
          const cli = async (args: string[]): Promise<unknown> => {
            const result = await sandbox.execArgv('agent-browser', [...flags, ...args], {
              maxOutputBytes: 320 * 1024,
              timeoutMs: 15000,
            });
            if (result.exitCode !== 0 || result.outputOverflow)
              throw new Error('Controlled baseline CLI failure');
            return unwrapBrowserCliOutput(result.stdout);
          };
          const registry = new CoreToolRegistry(sandbox);
          if (mode === 'legacy') {
            const tool: ToolDefinition = {
              name: 'bash',
              description:
                'Controlled legacy Bash adapter for assigned localhost fixture only. Commands: agent-browser open <fixture-URL>; agent-browser eval trinity-research-page-v1 (runs the bundled fixed article extractor, full legacy dump); agent-browser snapshot -i; agent-browser click @eN. Open then eval to read. For hidden caveats snapshot then click then eval. Other commands are refused. Cite an eval call using exact URL/quote.',
              parameters: z.object({ command: z.string().max(10000) }),
              concurrency: 'exclusive',
              execute: async (raw): Promise<{ value: unknown; isError: boolean }> => {
                const args = literalCommandArgv((raw as { command: string }).command);
                if (!args || args[0] !== 'agent-browser')
                  return { value: { message: 'Invalid controlled command' }, isError: true };
                let value: unknown;
                if (
                  args[1] === 'open' &&
                  args.length === 3 &&
                  args[2] === `${origin}/${task.name}`
                ) {
                  value = await cli(['open', args[2]]);
                  await cli(['wait', '--load', 'domcontentloaded']);
                } else if (
                  args[1] === 'eval' &&
                  args.length === 3 &&
                  args[2] === 'trinity-research-page-v1'
                )
                  value = await cli(['eval', extractor]);
                else if (args[1] === 'snapshot' && args.length === 3 && args[2] === '-i')
                  value = await cli(['snapshot', '-i', '-c']);
                else if (args[1] === 'click' && args.length === 3 && /^@e\d+$/.test(args[2]!)) {
                  value = await cli(['click', args[2]!]);
                  await cli(['wait', '--text', 'Caveat:']);
                } else
                  return {
                    value: { message: 'Only documented controlled fixture commands are allowed' },
                    isError: true,
                  };
                return {
                  value: { stdout: JSON.stringify(value), stderr: '', exitCode: 0 },
                  isError: false,
                };
              },
            };
            registry.register(tool);
          } else {
            const tool = createBrowserTool({ store, blobs, access, now: () => new Date() });
            if (mode === 'capture')
              tool.parameters = z.object({
                operation: z.enum([
                  'navigate',
                  'get_page_text',
                  'read_page',
                  'read_observation',
                  'search_observation',
                ]),
                url: z.string().optional(),
                mode: z.enum(['article', 'documentation']).optional(),
                filter: z.enum(['interactive', 'all']).optional(),
                observationId: z.string().optional(),
                query: z.string().optional(),
                blockIds: z.array(z.string()).optional(),
                cursor: z.object({ blockId: z.string(), offset: z.number() }).optional(),
              });
            registry.register(tool);
          }
          registry.register(createResearchTool(store, blobs));
          let inputTokens = 0,
            outputTokens = 0,
            requestImageBytes = 0,
            requestTextBytes = 0;
          const llm: LLMPort = {
            stream: async (req) => {
              requestTextBytes += Buffer.byteLength(JSON.stringify(req.messages));
              for (const message of req.messages)
                for (const block of message.blocks ?? [])
                  if (block.kind === 'image')
                    requestImageBytes += (await blobs.getMeta(block.uri))?.size ?? 0;
              const stream = await gateway.stream(req);
              return (async function* () {
                for await (const chunk of stream) {
                  if (chunk.kind === 'usage') {
                    inputTokens += chunk.inputTokens;
                    outputTokens += chunk.outputTokens;
                  }
                  yield chunk;
                }
              })();
            },
          };
          const loop = new CoreAgentLoop({
            llm,
            model,
            tools: registry,
            store,
            workspaceRoot: root,
            maxSteps: 10,
            spill: { store: blobs },
            resolveBlob: async (uri) => {
              const bytes = await blobs.get(uri);
              if (!bytes) throw new Error('missing');
              return bytes;
            },
            systemPrompt: `You are evaluating controlled synthetic fixtures, not current-world facts. Read evidence before answering. Use the browser and record research notes once with exact observed sources, then give a concise grounded final answer. Preserve caveats and original quotes. ${mode === 'legacy' ? 'Use the controlled bash commands: open, eval trinity-research-page-v1, and snapshot/click for interaction. Legacy sources use url, quote, callId.' : 'Typed sources use observationId, blockId and optional code-point start/end. Use search_observation or focused reads when the overview does not expose a needed passage. Fresh snapshotId/refs are required for actions; a click may set readiness text to the expected revealed caveat. Screenshots are optional visual fallback.'}`,
          });
          const start = performance.now();
          try {
            const outcome = await loop.run(
              sessionId,
              `${task.question}\nFixture URL: ${origin}/${task.name}`,
              { emit: () => {} },
              {
                policy: parsePermissionPolicy('danger-full-access'),
                signal: AbortSignal.timeout(180000),
              },
            );
            const events = await store.load(sessionId);
            const final = events
              .filter(
                (e): e is Extract<SessionEvent, { type: 'message/assistant' }> =>
                  e.type === 'message/assistant' && e.phase === 'final',
              )
              .at(-1);
            const answer =
              final?.content
                .filter((b) => b.kind === 'text')
                .map((b) => b.text)
                .join('\n') ?? '';
            const calls = events.filter(
              (e): e is Extract<SessionEvent, { type: 'tool/call' }> => e.type === 'tool/call',
            );
            const browserIds = new Set(
              calls.filter((e) => e.name === 'browser' || e.name === 'bash').map((e) => e.callId),
            );
            const deliveries = browserDeliveries(events, sessionId, browserPromptIndex(events));
            const ranges = new Set(
              deliveries.flatMap((d) =>
                d.result.receipt.map(
                  (r) => `${d.result.observationId}/${r.blockId}/${r.start}/${r.end}`,
                ),
              ),
            );
            const record = {
              repeat,
              task: task.name,
              mode,
              model,
              ...outcome,
              inputTokens,
              outputTokens,
              requestTextBytes,
              requestImageBytes,
              browserCalls: browserIds.size,
              retrievalCalls: calls.filter((e) =>
                ['read_observation', 'search_observation'].includes(
                  (e.args as { operation?: string })?.operation ?? '',
                ),
              ).length,
              citationFailures: events.filter(
                (e) =>
                  e.type === 'tool/result' &&
                  e.isError &&
                  calls.some((c) => c.callId === e.callId && c.name === 'research'),
              ).length,
              deliveryBytes: events
                .filter(
                  (e): e is Extract<SessionEvent, { type: 'tool/result' }> =>
                    e.type === 'tool/result' && browserIds.has(e.callId),
                )
                .reduce((sum, e) => sum + Buffer.byteLength(JSON.stringify(e.value)), 0),
              uniqueExposedRanges: ranges.size,
              duplicateSuppressions: deliveries.filter((d) => d.result.duplicateSuppressed).length,
              imageBytes: deliveries.reduce((sum, d) => sum + (d.result.image?.bytes ?? 0), 0),
              latencyMs: Math.round(performance.now() - start),
              checks: task.checks.map((check) => ({
                check: check.source,
                passed: check.test(answer),
              })),
              answer,
              citations: final?.citationList ?? [],
              trace: calls.map((call) => ({
                name: call.name,
                args: call.args,
                error: events.find(
                  (e) => e.type === 'tool/result' && e.callId === call.callId && e.isError,
                ),
              })),
            };
            results.push(record);
            console.log(JSON.stringify({ ...record, answer: undefined, citations: undefined }));
            await writeFile(
              process.env['TRINITY_BROWSER_EVAL_REPORT'] ?? '/tmp/trinity-browser-evaluation.json',
              JSON.stringify(
                { model, endpoint: 'configured existing CDP', repeats, fixtureOnly: true, results },
                null,
                2,
              ),
            );
          } finally {
            await cli(['tab', 'close']);
          }
        }
      };
      const concurrency = Number(process.env['TRINITY_BROWSER_EVAL_CONCURRENCY'] ?? 1);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2)
        throw new Error('Use 1–2 workers');
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      expect(results).toHaveLength(jobs.length);
    } finally {
      fixture.closeAllConnections();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  3600000,
);
