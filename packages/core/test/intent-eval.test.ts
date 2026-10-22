import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { DEFAULT_SYSTEM_PROMPT } from '@trinity-harness/shared';
import {
  AiSdkGateway,
  CoreAgentLoop,
  CoreToolRegistry,
  MemorySessionStore,
  createTaskTool,
  readFileTool,
} from '../src/index.js';
import { loadModelPricingConfig } from '../src/llm/model-pricing-config.js';
import { FakeSandbox } from '../src/testing/fake-sandbox.js';
import { intentCases } from './fixtures/intent-cases.js';
import { intentRuntime } from './fixtures/intent-runtime.js';

/** Real-model evaluation is opt-in; rubric judgments remain separate from CI assertions. */
it.skipIf(process.env['TRINITY_RUN_INTENT_EVAL'] !== '1')(
  'records controlled intent tasks for comparative human review',
  async () => {
    const model = process.env['MODEL'];
    const label = process.env['TRINITY_INTENT_EVAL_LABEL'];
    const reportPath = process.env['TRINITY_INTENT_EVAL_REPORT'];
    if (!model || !label || !reportPath)
      throw new Error('Set MODEL, TRINITY_INTENT_EVAL_LABEL and TRINITY_INTENT_EVAL_REPORT');
    const repeats = Number(process.env['TRINITY_INTENT_EVAL_REPEATS'] ?? 2);
    if (!Number.isInteger(repeats) || repeats < 2 || repeats > 5)
      throw new Error('Use 2–5 repeats');
    const split = process.env['TRINITY_INTENT_EVAL_SPLIT'] ?? 'development';
    if (!['development', 'holdout', 'all'].includes(split)) throw new Error('Invalid split');
    const runtime = process.env['TRINITY_INTENT_EVAL_RUNTIME'] ?? 'personal';
    if (!['minimal', 'personal'].includes(runtime)) throw new Error('Invalid evaluation runtime');
    const selected = process.env['TRINITY_INTENT_EVAL_CASES']?.split(',');
    if (selected?.some((id) => !intentCases.some((task) => task.id === id)))
      throw new Error('Unknown TRINITY_INTENT_EVAL_CASES entry');
    const cases = intentCases.filter(
      (task) =>
        (split === 'all' || task.split === split) &&
        (!selected || selected.includes(task.id)) &&
        (runtime === 'personal' ||
          !(
            'localHistory' in task ||
            'pages' in task ||
            task.id === 'scoped-configuration-change'
          )),
    );
    if (!cases.length) throw new Error('No evaluation cases selected');
    const pricing = loadModelPricingConfig(new URL('../../../config/models.yaml', import.meta.url));
    const gateway = new AiSdkGateway();
    const sourcePaths = [
      '../src/loop/agent-loop.ts',
      '../src/tools/task.ts',
      '../src/loop/task-verification.ts',
      '../src/loop/to-model-messages.ts',
      '../../contracts/src/task.ts',
      '../../shared/src/env.ts',
      '../src/llm/ai-sdk-gateway.ts',
      './intent-eval.test.ts',
      './fixtures/intent-cases.ts',
      './fixtures/intent-runtime.ts',
      '../src/personal-assistant/memory.ts',
      '../src/personal-assistant/recall-tool.ts',
      '../src/loop/model-context.ts',
      '../../contracts/src/execution-context.ts',
      '../../contracts/src/personal-assistant.ts',
      '../src/context/context-manager.ts',
      '../src/tool-registry.ts',
      '../src/tools/browser.ts',
    ];
    const sources = await Promise.all(
      sourcePaths.map(async (source) => ({
        source,
        sha256: createHash('sha256')
          .update(await readFile(new URL(source, import.meta.url)))
          .digest('hex'),
      })),
    );
    const results: Record<string, unknown>[] = [];
    const report = async (): Promise<void> => {
      await writeFile(
        reportPath,
        JSON.stringify(
          {
            label,
            model,
            repeats,
            split,
            caseIds: cases.map((task) => task.id),
            sources,
            systemPrompt: DEFAULT_SYSTEM_PROMPT,
            conditions: {
              runtime,
              verification: true,
              maxSteps: runtime === 'personal' ? 24 : 12,
              maxOutputTokens: 4096,
              turnTimeoutMs: runtime === 'personal' ? 120000 : 90000,
              gatewayOptions: 'default',
              tools:
                runtime === 'personal'
                  ? [
                      'read_file',
                      'write_file',
                      'edit_file',
                      'task',
                      'recall',
                      'browser only for fixtures with pages',
                    ]
                  : ['read_file', 'task'],
              adapters:
                'in-memory synthetic sandbox, memory/index and fixed browser driver; no HTTP server, queue or live browser',
            },
            fixtureOnly: true,
            semanticScoring: 'manual; no automatic quality verdict',
            results,
          },
          null,
          2,
        ),
      );
    };
    for (let repeat = 0; repeat < repeats; repeat++) {
      for (const task of cases) {
        const personal = runtime === 'personal' ? await intentRuntime(task) : undefined;
        const store = personal?.store ?? new MemorySessionStore();
        const sandbox = personal?.sandbox ?? new FakeSandbox();
        for (const [name, text] of Object.entries(task.files)) sandbox.files.set(name, text);
        const tools = personal?.tools ?? new CoreToolRegistry(sandbox);
        if (!personal) {
          tools.register(readFileTool);
          tools.register(createTaskTool(store));
        }
        const loop = new CoreAgentLoop({
          llm: gateway,
          model,
          pricing,
          tools,
          store,
          workspaceRoot: '/fixture',
          systemPrompt: DEFAULT_SYSTEM_PROMPT,
          verification: true,
          maxSteps: personal ? 24 : 12,
          maxOutputTokens: 4096,
          ...(personal
            ? {
                personalContext: personal.personalContext,
                sessionMetas: personal.metas,
                spill: { store: personal.blobs },
              }
            : {}),
        });
        const sessionId = personal?.owner.id ?? crypto.randomUUID();
        const startingSeq = (await store.load(sessionId)).length;
        const start = performance.now();
        const outcomes = [];
        for (const prompt of task.prompts)
          outcomes.push(
            await loop.run(
              sessionId,
              `${prompt}\n\nAvailable fixture files (complete list): ${Object.keys(task.files).join(', ') || 'none'}.` +
                ('pages' in task
                  ? `\nAvailable synthetic browser pages: ${Object.keys(task.pages).join(', ')}`
                  : ''),
              { emit: () => undefined },
              {
                signal: AbortSignal.timeout(personal ? 120_000 : 90_000),
              },
            ),
          );
        const events = await store.load(sessionId);
        const usages = events.flatMap((event) =>
          event.type === 'model/usage' ? [event.usage] : [],
        );
        results.push({
          task: task.id,
          repeat,
          runtime,
          startingSeq,
          finalWorkspace: Object.fromEntries(sandbox.files),
          requestManifests: events.filter((event) => event.type === 'model/context'),
          prompts: task.prompts,
          rubric: task.rubric,
          latencyMs: Math.round(performance.now() - start),
          outcomes,
          requests: usages.length,
          usages,
          terminalEvents: events.filter((event) => event.type === 'turn/end'),
          // Synthetic inputs only. Exclude provider reasoning and transport details.
          transcript: events.flatMap<Record<string, unknown>>((event) => {
            if (event.type === 'message/user' || event.type === 'message/assistant')
              return [
                {
                  type: event.type,
                  text: event.content
                    .filter((b) => b.kind === 'text')
                    .map((b) => b.text)
                    .join('\n'),
                  ...(event.type === 'message/assistant' ? { phase: event.phase } : {}),
                },
              ];
            if (
              [
                'memory/selection',
                'response/candidate',
                'task/plan',
                'task/recovery',
                'task/assessment',
                'task/outcome',
                'task/completion',
              ].includes(event.type)
            )
              return [{ ...event }];
            if (event.type === 'tool/call')
              return [
                { type: event.type, callId: event.callId, name: event.name, args: event.args },
              ];
            if (event.type === 'tool/result')
              return [
                {
                  type: event.type,
                  callId: event.callId,
                  isError: event.isError,
                  value: event.value,
                },
              ];
            return [];
          }),
        });
        await report();
        console.log(
          JSON.stringify({ label, task: task.id, repeat, outcomes, requests: usages.length }),
        );
      }
    }
    expect(results).toHaveLength(cases.length * repeats);
  },
  3_600_000,
);
