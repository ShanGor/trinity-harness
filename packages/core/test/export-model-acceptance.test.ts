import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DEFAULT_SYSTEM_PROMPT } from '@trinity-harness/shared';
import {
  browserCaptureSchema,
  browserDocumentGraphSchema,
  type BrowserDriverPort,
} from '@trinity-harness/contracts';
import {
  AiSdkGateway,
  CoreAgentLoop,
  CoreToolRegistry,
  LocalSandbox,
  LocalBlobStore,
  MemorySessionStore,
  createTaskTool,
  createBrowserTool,
  readFileTool,
  globTool,
  bashTool,
} from '../src/index.js';
import { loadModelPricingConfig } from '../src/llm/model-pricing-config.js';

/** Paid, opt-in model evaluation with synthetic browser data and real offline export. */
it.skipIf(process.env['TRINITY_RUN_EXPORT_EVAL'] !== '1')(
  'records model-directed export acceptance without claiming live-browser coverage',
  async () => {
    const model = process.env['MODEL'];
    const reportPath = process.env['TRINITY_EXPORT_EVAL_REPORT'];
    if (!model || !reportPath) throw Error('Set MODEL and TRINITY_EXPORT_EVAL_REPORT');
    const sourcePaths = [
      '../src/loop/task-verification.ts',
      '../src/tools/browser.ts',
      '../src/tools/browser-document-export.ts',
      '../src/tools/browser-html-markdown.ts',
      '../src/tools/workspace-copy.ts',
      '../../contracts/src/task.ts',
      '../../contracts/src/browser.ts',
      '../src/tools/task.ts',
      '../src/loop/to-model-messages.ts',
      '../../../skills/agent-browser/SKILL.md',
      './export-model-acceptance.test.ts',
    ];
    const sources = await Promise.all(
      sourcePaths.map(async (source) => ({
        source,
        sha256: createHash('sha256')
          .update(await readFile(new URL(source, import.meta.url)))
          .digest('hex'),
      })),
    );
    const skill = await readFile(
      new URL('../../../skills/agent-browser/SKILL.md', import.meta.url),
      'utf8',
    );
    const results: Record<string, unknown>[] = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      const directory = await mkdtemp(join(tmpdir(), 'export-model-'));
      const workspace = join(directory, 'workspace');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(workspace);
      try {
        const sandbox = new LocalSandbox(workspace);
        const store = new MemorySessionStore();
        const blobs = new LocalBlobStore(join(directory, 'blobs'));
        const url = 'https://export-fixture.example/report';
        const graph = browserDocumentGraphSchema.parse({
          protocol: 'rendered-document-v1',
          buildId: 'trinity-document-v1',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          omittedFrames: 0,
          stability: 'checked-interval',
          documents: [
            {
              documentId: 'd0',
              parentDocumentId: null,
              ownerNodeId: null,
              url,
              title: '导出测试报告',
              revision: 'rev',
              presentationVersion: 1,
              nodes: [
                { id: 'root', parentId: null, tag: 'body', path: [] },
                { id: 'heading', parentId: 'root', tag: 'h1', path: [0] },
                {
                  id: 'title',
                  parentId: 'heading',
                  tag: 'text',
                  text: '导出测试报告',
                  path: [0, 0],
                },
                {
                  id: 'grid',
                  parentId: 'root',
                  tag: 'div',
                  path: [1],
                  presentation: { display: 'grid', 'grid-template-columns': '100px 100px' },
                },
                ...['服务', '状态', '搜索', '可用'].flatMap((text, i) => [
                  {
                    id: 'cell' + i,
                    parentId: 'grid',
                    tag: 'span',
                    path: [1, i],
                    presentation: { display: 'block' },
                  },
                  { id: 'text' + i, parentId: 'cell' + i, tag: 'text', path: [1, i, 0], text },
                ]),
                {
                  id: 'svg',
                  parentId: 'root',
                  tag: 'svg',
                  path: [2],
                  resourceId: 'vector',
                  vector: { viewBox: '0 0 8 8' },
                },
                {
                  id: 'vector-path',
                  parentId: 'svg',
                  tag: 'path',
                  path: [2, 0],
                  vector: { d: 'M0 0L8 8' },
                },
                {
                  id: 'image',
                  parentId: 'root',
                  tag: 'img',
                  path: [3],
                  resourceId: 'raster',
                  alt: '示例图片',
                },
              ],
              resources: [
                { id: 'vector', nodeId: 'svg', role: 'svg', state: 'inline' },
                {
                  id: 'raster',
                  nodeId: 'image',
                  role: 'image',
                  state: 'captured',
                  url: 'https://export-fixture.example/figure.png',
                  mimeType: 'image/png',
                  width: 1,
                  height: 1,
                  data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
                },
              ],
              exclusions: [],
              truncated: false,
            },
          ],
        });
        const unsupported = async (): Promise<never> => {
          throw Error('Unsupported synthetic fixture operation');
        };
        const driver: BrowserDriverPort = {
          verify: async () => undefined,
          navigate: async (_binding, target) => {
            if (target !== url) throw Error('Unknown fixture URL');
          },
          captureDocument: async () => structuredClone(graph),
          capture: async () =>
            browserCaptureSchema.parse({
              schemaVersion: 1,
              extractorVersion: 'semantic-v1',
              url,
              title: '导出测试报告',
              publishedAt: null,
              readiness: 'ready',
              representation: 'article',
              scope: 'article',
              exclusions: [],
              captureTruncated: false,
              blocks: [
                { id: 'b0', kind: 'heading', sectionId: null, text: '导出测试报告', links: [] },
              ],
            }),
          surface: async () => ({
            context: {
              width: 800,
              height: 600,
              scrollX: 0,
              scrollY: 0,
              devicePixelRatio: 1,
              locale: 'zh-CN',
              timezone: 'UTC',
            },
            targets: [],
            truncated: false,
            privacyDenied: false,
          }),
          accessibility: async () => '导出测试报告',
          act: unsupported,
          pointAllowed: unsupported,
          readiness: unsupported,
          paint: unsupported,
          screenshot: unsupported,
        };
        const tools = new CoreToolRegistry(sandbox);
        for (const tool of [
          createTaskTool(store),
          readFileTool,
          globTool,
          bashTool,
          createBrowserTool({
            store,
            blobs,
            driver,
            access: {
              authorize: async (_session, _operation, target) => {
                if (target && target !== url) throw Error('Unknown fixture URL');
                return {
                  bindingId: 'fixture',
                  tabId: 'tab',
                  documentRevision: 'rev',
                  cliVersion: 'fixture',
                  browserVersion: 'fixture',
                  cliSession: 'fixture',
                };
              },
            },
            now: () => new Date(),
          }),
        ])
          tools.register(tool);
        const loop = new CoreAgentLoop({
          llm: new AiSdkGateway(),
          model,
          pricing: loadModelPricingConfig(new URL('../../../config/models.yaml', import.meta.url)),
          tools,
          store,
          workspaceRoot: workspace,
          systemPrompt:
            DEFAULT_SYSTEM_PROMPT +
            '\n\nPreloaded browser skill (synthetic driver, real offline export):\n' +
            skill,
          verification: true,
          maxSteps: 24,
          maxOutputTokens: 4096,
        });
        const sessionId = randomUUID();
        const started = performance.now();
        const outcome = await loop.run(
          sessionId,
          `请用浏览器打开 ${url}，把完整文字和图片保存成 Markdown，保留配套文件。`,
          { emit: () => undefined },
          {
            signal: AbortSignal.timeout(120000),
            policy: { tools: {}, onAsk: 'ask', allowWorkspaceInternalBash: true },
          },
        );
        const events = await store.load(sessionId);
        const calls = events.filter((event) => event.type === 'tool/call');
        const outputs = [];
        for (const event of events)
          if (event.type === 'tool/result' && !event.isError) {
            const value = event.value as { kind?: string; path?: string; bundlePath?: string };
            if (value?.kind === 'browser-markdown-export' && value.path && value.bundlePath)
              outputs.push({
                receipt: value,
                markdown: await readFile(join(workspace, value.path), 'utf8'),
                manifest: JSON.parse(
                  await readFile(join(workspace, value.bundlePath, 'manifest.json'), 'utf8'),
                ),
              });
          }
        results.push({
          repeat,
          outcome,
          latencyMs: Math.round(performance.now() - started),
          requests: events.filter((event) => event.type === 'model/usage').length,
          usage: events.filter((event) => event.type === 'model/usage'),
          captures: calls.filter(
            (event) => (event.args as { operation?: string }).operation === 'capture_document',
          ).length,
          exports: outputs.length,
          approvals: events.filter((event) => event.type === 'approval/requested').length,
          outputs,
          transcript: events
            .filter(
              (event) =>
                event.type === 'tool/call' ||
                event.type === 'tool/result' ||
                event.type === 'task/plan' ||
                event.type === 'task/check' ||
                event.type === 'turn/end' ||
                event.type === 'message/assistant',
            )
            .map((event) =>
              event.type === 'message/assistant'
                ? { ...event, content: event.content.filter((block) => block.kind === 'text') }
                : event,
            ),
        });
        await writeFile(
          reportPath,
          JSON.stringify(
            {
              model,
              sources,
              conditions:
                'two repeats; fixed synthetic browser; real Sandbox/Turndown; no live browser/guest; manual semantic review required',
              results,
            },
            null,
            2,
          ),
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    expect(results).toHaveLength(2);
  },
  260000,
);
