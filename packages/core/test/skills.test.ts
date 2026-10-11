import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  browserCdpEndpointSchema,
  sessionEventSchema,
  skillDirectoriesEnvSchema,
  type SessionEvent,
} from '@trinity-harness/contracts';

import {
  bashTool,
  CoreAgentLoop,
  CoreToolRegistry,
  createSkillTool,
  createBrowserTool,
  FileSkillCatalog,
  LocalBlobStore,
  MemorySessionStore,
  SkillRuntime,
  toModelMessages,
} from '../src/index.js';
import { FakeLLM, textChunks, toolCallThenFinish } from '../src/testing/fake-llm.js';
import { FakeSandbox } from '../src/testing/fake-sandbox.js';

const meta = () => ({ eventId: crypto.randomUUID(), at: '2026-01-01T00:00:00.000Z' });
let root: string;
async function put(relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}
function markdown(name = 'browser', body = 'PRIVATE INSTRUCTIONS', extra = ''): string {
  return `---\nname: ${name}\ndescription: Browse websites\n${extra}---\n${body}\n`;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'trinity-skills-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('FileSkillCatalog', () => {
  it('discovers summaries, loads bodies/resources, and resolves deterministic precedence', async () => {
    await put('.agents/skills/a/SKILL.md', markdown('browser', 'workspace'));
    await put('.trinity/skills/a/SKILL.md', markdown('browser', 'preferred'));
    await put('configured/a/SKILL.md', markdown('browser', 'configured'));
    await put('bundled/a/SKILL.md', markdown('browser', 'bundled'));
    await put('bundled/b/SKILL.md', markdown('second'));
    await put('.trinity/skills/a/references/guide.md', 'reference text');
    const catalog = new FileSkillCatalog({
      configuredDirectories: [path.join(root, 'configured')],
      bundledDirectories: [path.join(root, 'bundled')],
    });
    const result = await catalog.list(root);
    expect(result.skills.map((skill) => skill.name)).toEqual(['browser', 'second']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE INSTRUCTIONS');
    expect(result.diagnostics).toEqual([]);
    const skill = await catalog.load(root, 'browser');
    expect(skill.body).toBe('preferred');
    expect(skill.source).toBe('workspace');
    expect(await catalog.readResource(skill, 'references/guide.md')).toBe('reference text');
    await put('.trinity/skills/a/SKILL.md', markdown('browser', 'changed'));
    expect((await catalog.load(root, 'browser')).version).not.toBe(skill.version);
  });

  it('accepts YAML block descriptions and ignores invalid metadata without leaking bodies', async () => {
    await put(
      '.agents/skills/a/SKILL.md',
      '---\nname: browser\ndescription: |\n  Browse sites\n  and apps\n---\nsecret body',
    );
    await put('.agents/skills/b/SKILL.md', markdown('INVALID NAME'));
    await put(
      '.agents/skills/c/SKILL.md',
      '---\nname: browser\nname: duplicate\ndescription: secret YAML\n---\nSECRET',
    );
    const result = await new FileSkillCatalog().list(root);
    expect(result.skills[0]!.description).toContain('Browse sites\nand apps');
    expect(result.diagnostics).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('does not discover parent skills or another workspace via symlinks', async () => {
    await put('.agents/skills/a/SKILL.md', markdown());
    await fs.mkdir(path.join(root, 'child'));
    const catalog = new FileSkillCatalog();
    expect((await catalog.list(path.join(root, 'child'))).skills).toEqual([]);
    await fs.mkdir(path.join(root, 'other'));
    await fs.symlink(path.join(root, '.agents'), path.join(root, 'other', '.agents'));
    const result = await catalog.list(path.join(root, 'other'));
    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
  });

  it('rejects traversal, absolute resources, linked resources and linked SKILL.md', async () => {
    await put('.agents/skills/a/SKILL.md', markdown());
    await put('outside.md', 'other tenant');
    const catalog = new FileSkillCatalog();
    const skill = await catalog.load(root, 'browser');
    await fs.symlink(path.join(root, 'outside.md'), path.join(skill.baseDirectory, 'linked.md'));
    for (const resource of [
      '../../../outside.md',
      path.join(root, 'outside.md'),
      'linked.md',
      '..\\outside.md',
    ]) {
      await expect(catalog.readResource(skill, resource)).rejects.toMatchObject({
        code: expect.stringMatching(/^SKILL_/),
      });
    }
    await fs.rm(path.join(skill.baseDirectory, 'SKILL.md'));
    await fs.symlink(path.join(root, 'outside.md'), path.join(skill.baseDirectory, 'SKILL.md'));
    expect((await catalog.list(root)).skills).toEqual([]);
  });

  it('bounds instructions/resources, rejects binary text and honors aborts', async () => {
    await put('.agents/skills/a/SKILL.md', markdown());
    const catalog = new FileSkillCatalog();
    const skill = await catalog.load(root, 'browser');
    await put('.agents/skills/a/big.md', 'a'.repeat(65_537));
    await put('.agents/skills/a/binary.md', '\0');
    await expect(catalog.readResource(skill, 'big.md')).rejects.toMatchObject({
      code: 'SKILL_SIZE',
    });
    await expect(catalog.readResource(skill, 'binary.md')).rejects.toMatchObject({
      code: 'SKILL_SIZE',
    });
    const controller = new AbortController();
    controller.abort();
    await expect(catalog.list(root, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await put('.agents/skills/a/SKILL.md', markdown('browser', 'a'.repeat(65_537)));
    expect((await catalog.list(root)).skills).toEqual([]);
  });
});

describe('SkillRuntime and model projection', () => {
  it.each([true, false])(
    'advertises the current browser capabilities in a fresh session (live=%s)',
    async (live) => {
      const store = new MemorySessionStore();
      const runtime = new SkillRuntime(
        new FileSkillCatalog({
          bundledDirectories: [path.resolve(import.meta.dirname, '../../../skills')],
        }),
        store,
        {
          now: () => new Date('2026-01-01T00:00:00.000Z'),
          browserCdpEndpoint: live ? '9222' : undefined,
        },
      );
      const registry = new CoreToolRegistry(new FakeSandbox());
      registry.register(createSkillTool(runtime));
      registry.register(bashTool);
      registry.register(
        createBrowserTool({
          store,
          blobs: new LocalBlobStore(path.join(root, 'blobs')),
          now: () => new Date('2026-01-01T00:00:00.000Z'),
          ...(live
            ? {
                access: {
                  authorize: async () => {
                    throw new Error('No live actions in schema test');
                  },
                },
              }
            : {}),
        }),
      );
      const llm = new FakeLLM(
        (request) => {
          expect(request.tools?.find((tool) => tool.name === 'browser')?.parameters).toMatchObject({
            properties: {
              operation: {
                enum: live
                  ? expect.arrayContaining([
                      'navigate',
                      'get_page_text',
                      'read_page',
                      'read_observation',
                    ])
                  : ['read_observation', 'search_observation'],
              },
            },
          });
          expect(request.tools?.some((tool) => tool.name === 'bash')).toBe(true);
          expect(JSON.stringify(request.messages)).not.toContain('--cdp');
          return toolCallThenFinish('load', 'skill', { name: 'agent-browser' });
        },
        (request) => {
          expect(JSON.stringify(request.messages)).toContain('Use the advertised `browser` tool');
          expect(JSON.stringify(request.messages)).not.toContain('agent-browser --');
          return textChunks('Browser capabilities inspected.');
        },
      );
      const loop = new CoreAgentLoop({
        llm,
        model: 'fake/model',
        tools: registry,
        store,
        skills: runtime,
        workspaceRoot: root,
      });
      expect((await loop.run('fresh', 'Read a website', { emit: () => undefined })).reason).toBe(
        'completed',
      );
      llm.assertExhausted();
    },
  );

  it('advertises summaries, loads through the normal tool path, and executes via sandbox', async () => {
    await put('.agents/skills/browser/SKILL.md', markdown());
    const store = new MemorySessionStore();
    const runtime = new SkillRuntime(new FileSkillCatalog(), store, {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const sandbox = new FakeSandbox();
    const commands: string[] = [];
    sandbox.execHandler = (command) => {
      commands.push(command);
      return { stdout: 'browser installed', stderr: '', exitCode: 0 };
    };
    const registry = new CoreToolRegistry(sandbox);
    registry.register(createSkillTool(runtime));
    registry.register(bashTool);
    const llm = new FakeLLM(
      (request) => {
        expect(JSON.stringify(request.messages)).toContain('Browse websites');
        expect(JSON.stringify(request.messages)).not.toContain('PRIVATE INSTRUCTIONS');
        return toolCallThenFinish('load', 'skill', { name: 'browser' });
      },
      (request) => {
        expect(JSON.stringify(request.messages)).toContain('PRIVATE INSTRUCTIONS');
        return toolCallThenFinish('run', 'bash', { command: 'agent-browser --version' });
      },
      () => textChunks('done'),
    );
    const loop = new CoreAgentLoop({
      llm,
      model: 'fake/model',
      tools: registry,
      store,
      skills: runtime,
      workspaceRoot: root,
      spill: {
        thresholdBytes: 1,
        store: {
          put: async () => {
            throw new Error('skill must not spill');
          },
          get: async () => null,
          getMeta: async () => null,
          delete: async () => undefined,
        },
      },
    });
    expect((await loop.run('s1', 'browse a website', { emit: () => undefined })).reason).toBe(
      'completed',
    );
    expect(commands).toEqual(['agent-browser --version']);
    const events = await store.load('s1');
    expect(events.filter((event) => event.type === 'skill/catalog')).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.type === 'tool/result' &&
          !event.isError &&
          JSON.stringify(event.value).includes('PRIVATE INSTRUCTIONS'),
      ),
    ).toBe(true);
    events.forEach((event) => expect(sessionEventSchema.safeParse(event).success).toBe(true));
    llm.assertExhausted();
  });

  it('explicitly activates user-only skills and respects invocation flags and policy', async () => {
    await put(
      '.agents/skills/a/SKILL.md',
      markdown('browser', 'USER ONLY', 'disable-model-invocation: true\n'),
    );
    await put(
      '.agents/skills/b/SKILL.md',
      markdown('hidden', 'MODEL ONLY', 'user-invocable: false\n'),
    );
    await put('.agents/skills/a/guide.md', 'guide');
    const store = new MemorySessionStore();
    const runtime = new SkillRuntime(new FileSkillCatalog(), store, {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    await expect(
      runtime.load({ sessionId: 's', workspaceRoot: root, name: 'browser' }),
    ).rejects.toMatchObject({ code: 'SKILL_DENIED' });
    await runtime.prepare({ sessionId: 's', workspaceRoot: root, prompt: 'Use $browser please' });
    expect(JSON.stringify(toModelMessages(await store.load('s')))).toContain('USER ONLY');
    expect(
      await runtime.load({
        sessionId: 's',
        workspaceRoot: root,
        name: 'browser',
        resource: 'guide.md',
      }),
    ).toMatchObject({ content: 'guide' });
    await runtime.prepare({ sessionId: 's', workspaceRoot: root, prompt: '$browser' });
    expect((await store.load('s')).filter((event) => event.type === 'skill/loaded')).toHaveLength(
      2,
    );
    await expect(
      runtime.prepare({ sessionId: 's', workspaceRoot: root, prompt: '$hidden' }),
    ).rejects.toMatchObject({ code: 'SKILL_DENIED' });
    await expect(
      runtime.prepare({ sessionId: 's', workspaceRoot: root, prompt: '$missing' }),
    ).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' });
    await expect(
      runtime.prepare({
        sessionId: 's',
        workspaceRoot: root,
        prompt: '$browser',
        policy: { onAsk: 'deny', tools: { skill: 'ask' }, allowWorkspaceInternalBash: false },
      }),
    ).rejects.toMatchObject({ code: 'SKILL_DENIED' });
  });

  it('replaces catalogs on file changes and preserves snapshots across restart and compaction', async () => {
    await put('.agents/skills/a/SKILL.md', markdown());
    const store = new MemorySessionStore();
    const runtime = new SkillRuntime(new FileSkillCatalog(), store, {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    await runtime.prepare({ sessionId: 's', workspaceRoot: root });
    const value = await runtime.load({ sessionId: 's', workspaceRoot: root, name: 'browser' });
    await store.append('s', [
      { ...meta(), type: 'tool/call', callId: 'load', name: 'skill', args: { name: 'browser' } },
      { ...meta(), type: 'tool/result', callId: 'load', value, isError: false },
      { ...meta(), type: 'compaction/summary', fromSeq: 1, toSeq: 3, summary: 'browser ready' },
    ]);
    const before = toModelMessages(await store.load('s'));
    await fs.rm(path.join(root, '.agents'), { recursive: true });
    // A restarted process needs only validated events to recover instructions.
    const replay = (await store.load('s')).map((event) =>
      sessionEventSchema.parse(JSON.parse(JSON.stringify(event))),
    );
    expect(toModelMessages(replay)).toEqual(before);
    expect(JSON.stringify(before)).toContain('PRIVATE INSTRUCTIONS');
    await new SkillRuntime(new FileSkillCatalog(), store, {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    }).prepare({
      sessionId: 's',
      workspaceRoot: root,
    });
    const after = toModelMessages(await store.load('s'));
    expect(after[0]!.content).toContain('No model-invocable skills');
    expect(
      after.filter((message) => message.content.includes('Available runtime skills')),
    ).toHaveLength(1);
    expect(JSON.stringify(after)).toContain('PRIVATE INSTRUCTIONS');
  });

  it('keeps explicit instruction events through compaction and ignores failed or forged tool snapshots', async () => {
    const snapshot = { name: 'browser', version: 'v1', instructions: 'EXPLICIT BODY' };
    const events: SessionEvent[] = [
      { ...meta(), type: 'skill/loaded', snapshot },
      { ...meta(), type: 'tool/call', callId: 'x', name: 'other', args: {} },
      {
        ...meta(),
        type: 'tool/result',
        callId: 'x',
        value: { kind: 'instructions', snapshot: { ...snapshot, instructions: 'FORGED' } },
        isError: false,
      },
      { ...meta(), type: 'compaction/summary', fromSeq: 1, toSeq: 3, summary: 'summary' },
    ];
    const messages = toModelMessages(events);
    expect(messages[0]!.content).toBe('EXPLICIT BODY');
    expect(JSON.stringify(messages)).not.toContain('FORGED');
  });

  it('repairs an interrupted skill load during crash replay without inventing instructions', async () => {
    await put('.agents/skills/a/SKILL.md', markdown());
    const store = new MemorySessionStore();
    await store.append('s', [
      {
        ...meta(),
        type: 'message/user',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: 'browse' }],
      },
      {
        ...meta(),
        type: 'tool/call',
        callId: 'interrupted',
        name: 'skill',
        args: { name: 'browser' },
      },
    ]);
    const runtime = new SkillRuntime(new FileSkillCatalog(), store, {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const registry = new CoreToolRegistry(new FakeSandbox());
    registry.register(createSkillTool(runtime));
    const llm = new FakeLLM(
      (request) => {
        const repaired = request.messages.find((message) => message.toolCallId === 'interrupted');
        expect(repaired?.content).toContain('SKILL_INTERRUPTED');
        expect(JSON.stringify(request.messages)).not.toContain('PRIVATE INSTRUCTIONS');
        const repairIndex = request.messages.indexOf(repaired!);
        expect(request.messages[repairIndex + 1]!.content).toBe('continue');
        return toolCallThenFinish('retry', 'skill', { name: 'browser' });
      },
      (request) => {
        expect(JSON.stringify(request.messages)).toContain('PRIVATE INSTRUCTIONS');
        return textChunks('recovered');
      },
    );
    const loop = new CoreAgentLoop({
      llm,
      model: 'fake/model',
      tools: registry,
      store,
      skills: runtime,
      workspaceRoot: root,
    });
    expect((await loop.run('s', 'continue', { emit: () => undefined })).reason).toBe('completed');
    expect((await store.load('s')).filter((event) => event.type === 'tool/result')).toHaveLength(1);
    llm.assertExhausted();
  });

  it('keeps execution permissions independent of loaded skill instructions', async () => {
    await put('.agents/skills/a/SKILL.md', markdown('browser', 'Run browser commands'));
    const store = new MemorySessionStore();
    const runtime = new SkillRuntime(new FileSkillCatalog(), store, {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const sandbox = new FakeSandbox();
    let executed = false;
    sandbox.execHandler = () => {
      executed = true;
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const registry = new CoreToolRegistry(sandbox);
    registry.register(createSkillTool(runtime));
    registry.register(bashTool);
    const llm = new FakeLLM(
      () => toolCallThenFinish('load', 'skill', { name: 'browser' }),
      () => toolCallThenFinish('run', 'bash', { command: 'agent-browser --version' }),
      () => textChunks('command denied'),
    );
    const loop = new CoreAgentLoop({
      llm,
      model: 'fake/model',
      tools: registry,
      store,
      skills: runtime,
      workspaceRoot: root,
    });
    await loop.run(
      's',
      'browse',
      { emit: () => undefined },
      { policy: { onAsk: 'deny', tools: { bash: 'denied' }, allowWorkspaceInternalBash: false } },
    );
    expect(executed).toBe(false);
    const results = (await store.load('s')).filter((event) => event.type === 'tool/result');
    expect(results.map((event) => event.isError)).toEqual([false, true]);
  });

  it('ships the agent-browser runtime instruction package', async () => {
    const bundled = path.resolve(import.meta.dirname, '../../../skills');
    const catalog = new FileSkillCatalog({ bundledDirectories: [bundled] });
    expect((await catalog.list(root)).skills).toEqual([
      expect.objectContaining({ name: 'agent-browser', source: 'bundled' }),
    ]);
    const skill = await catalog.load(root, 'agent-browser');
    expect(skill.body).toContain('Use the advertised `browser` tool');
    expect(skill.body).not.toContain('agent-browser --');
    expect(skill.body).not.toContain('scripts/extract-page.js');
    expect(skill.body).toContain('references/cli-diagnostics.md');
    expect(await catalog.readResource(skill, 'references/cli-diagnostics.md')).toContain(
      'agent-browser skills get core',
    );
  });

  it('bounds compacted instruction retention and refreshes an explicit reactivation', async () => {
    const store = new MemorySessionStore();
    const events: SessionEvent[] = ['old', 'middle', 'new'].map((name) => ({
      ...meta(),
      type: 'skill/loaded',
      snapshot: { name, version: 'v1', instructions: `${name}:` + 'x'.repeat(60_000) },
    }));
    events.push({
      ...meta(),
      type: 'compaction/summary',
      fromSeq: 1,
      toSeq: 3,
      summary: 'skills loaded',
    });
    await store.append('s', events);
    const messages = toModelMessages(await store.load('s'));
    expect(messages.map((message) => message.content.slice(0, 7))).toEqual([
      'middle:',
      'new:xxx',
      '[compac',
    ]);
    await put('.agents/skills/old/SKILL.md', markdown('old', 'OLD REACTIVATED'));
    const runtime = new SkillRuntime(new FileSkillCatalog(), store, {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    await runtime.prepare({
      sessionId: 's',
      workspaceRoot: root,
      prompt: 'Use ($old). Budget $50.',
    });
    expect(JSON.stringify(toModelMessages(await store.load('s')))).toContain('OLD REACTIVATED');
  });

  it('advertises skills that require normal tool approval and denies oversized explicit bundles atomically', async () => {
    await put('.agents/skills/a/SKILL.md', markdown());
    const store = new MemorySessionStore();
    const runtime = new SkillRuntime(new FileSkillCatalog(), store, {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    await runtime.prepare({
      sessionId: 's',
      workspaceRoot: root,
      policy: { onAsk: 'ask', tools: { skill: 'ask' }, allowWorkspaceInternalBash: false },
    });
    expect(JSON.stringify(toModelMessages(await store.load('s')))).toContain('Browse websites');
    for (const name of ['one', 'two', 'three'])
      await put(`.agents/skills/${name}/SKILL.md`, markdown(name, 'x'.repeat(60_000)));
    await expect(
      runtime.prepare({ sessionId: 'other', workspaceRoot: root, prompt: '$one $two $three' }),
    ).rejects.toMatchObject({ code: 'SKILL_LIMIT' });
    expect(await store.load('other')).toEqual([]);
  });

  it('uses the current session identity when replaying a forked skill snapshot', async () => {
    await put('.agents/skills/a/SKILL.md', markdown());
    const store = new MemorySessionStore();
    const runtime = new SkillRuntime(new FileSkillCatalog(), store, {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    await runtime.prepare({ sessionId: 'parent', workspaceRoot: root, prompt: '$browser' });
    await store.append('fork', await store.load('parent'));
    await runtime.prepare({ sessionId: 'fork', workspaceRoot: root });
    const messages = toModelMessages(await store.load('fork'));
    expect(messages[0]!.content).toContain('Runtime session: fork');
    expect(JSON.stringify(messages)).not.toContain('Runtime session: parent');
    expect(JSON.stringify(messages)).toContain('PRIVATE INSTRUCTIONS');
  });

  it('advertises wrapper routing and saved-only fallback without exposing CLI setup', async () => {
    const store = new MemorySessionStore();
    const catalog = new FileSkillCatalog();
    const runtime = new SkillRuntime(catalog, store, {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      browserCdpEndpoint: '9222',
    });
    await runtime.prepare({ sessionId: 's', workspaceRoot: root });
    const instructions = toModelMessages(await store.load('s'))[0]!.content;
    expect(instructions).toContain('Use the browser tool operations advertised in this turn');
    expect(instructions).toContain('without CLI checks, shell commands or extraction scripts');
    expect(instructions).toContain('If only saved operations are advertised');
    expect(instructions).not.toContain('--cdp');
    expect(instructions).not.toContain('--session');
    expect(instructions).not.toContain('9222');
    expect(instructions).toContain('instead of launching a replacement');
    expect(instructions).toContain('Preserve the user-owned Chrome');
    await new SkillRuntime(catalog, store).prepare({ sessionId: 's', workspaceRoot: root });
    expect(toModelMessages(await store.load('s'))[0]!.content).not.toContain(
      'A browser connection is configured',
    );
    expect(toModelMessages(await store.load('s'))[0]!.content).toContain(
      'do not launch managed Chrome',
    );
    for (const value of [
      '9222',
      'http://127.0.0.1:9222',
      'ws://localhost:9222/devtools/browser/id',
    ])
      expect(browserCdpEndpointSchema.safeParse(value).success).toBe(true);
    for (const value of [
      '0',
      '65536',
      'file:///tmp/chrome',
      'http://user:password@localhost:9222',
      'ws://localhost:9222?token=secret',
      '9222; echo bad',
    ])
      expect(browserCdpEndpointSchema.safeParse(value).success).toBe(false);
  });

  it('refreshes a loaded skill after edits and suppresses obsolete instructions on replay', async () => {
    await put('.agents/skills/a/SKILL.md', markdown('browser', 'OLD HEADLESS WORKFLOW'));
    const store = new MemorySessionStore();
    const runtime = new SkillRuntime(new FileSkillCatalog(), store, {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    await runtime.prepare({ sessionId: 's', workspaceRoot: root });
    const value = await runtime.load({ sessionId: 's', workspaceRoot: root, name: 'browser' });
    await store.append('s', [
      { ...meta(), type: 'tool/call', callId: 'load', name: 'skill', args: { name: 'browser' } },
      { ...meta(), type: 'tool/result', callId: 'load', value, isError: false },
    ]);
    await put('.agents/skills/a/SKILL.md', markdown('browser', 'NEW CDP WORKFLOW'));
    await runtime.prepare({ sessionId: 's', workspaceRoot: root });
    const events = await store.load('s');
    expect(JSON.stringify(events)).toContain('OLD HEADLESS WORKFLOW');
    const messages = toModelMessages(events);
    expect(JSON.stringify(messages)).not.toContain('OLD HEADLESS WORKFLOW');
    expect(JSON.stringify(messages)).toContain('NEW CDP WORKFLOW');
    expect(messages.find((message) => message.toolCallId === 'load')!.content).toContain(
      'superseded-instructions',
    );
    await runtime.prepare({ sessionId: 's', workspaceRoot: root });
    expect((await store.load('s')).filter((event) => event.type === 'skill/loaded')).toHaveLength(
      1,
    );
    await fs.rm(path.join(root, '.agents'), { recursive: true });
    expect(toModelMessages(events.map((event) => sessionEventSchema.parse(event)))).toEqual(
      messages,
    );
  });

  it('does not refresh skill instructions when loading is denied by policy', async () => {
    await put('.agents/skills/a/SKILL.md', markdown('browser', 'OLD'));
    const store = new MemorySessionStore();
    const runtime = new SkillRuntime(new FileSkillCatalog(), store, {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    await runtime.prepare({ sessionId: 's', workspaceRoot: root, prompt: '$browser' });
    await put('.agents/skills/a/SKILL.md', markdown('browser', 'NEW'));
    await runtime.prepare({
      sessionId: 's',
      workspaceRoot: root,
      policy: { onAsk: 'deny', tools: { skill: 'denied' }, allowWorkspaceInternalBash: false },
    });
    expect(JSON.stringify(toModelMessages(await store.load('s')))).not.toContain('NEW');
  });

  it('returns validation errors without executing scripts and validates configuration', async () => {
    const store = new MemorySessionStore();
    const runtime = new SkillRuntime(new FileSkillCatalog(), store, {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const registry = new CoreToolRegistry(new FakeSandbox());
    registry.register(createSkillTool(runtime));
    expect(
      (
        await registry.execute(
          { id: 'x', name: 'skill', args: { name: '../escape' } },
          { sessionId: 's', workspaceRoot: root },
        )
      ).isError,
    ).toBe(true);
    expect(skillDirectoriesEnvSchema.parse('["/opt/skills"]')).toEqual(['/opt/skills']);
    expect(skillDirectoriesEnvSchema.safeParse('{bad}').success).toBe(false);
  });
});

it('retains loaded skill instructions after completed tool history is removed', () => {
  const events: SessionEvent[] = [
    {
      ...meta(),
      type: 'message/user',
      surfaceOp: 'append',
      content: [{ kind: 'text', text: 'research' }],
    },
    { ...meta(), type: 'tool/call', callId: 'load', name: 'skill', args: { name: 'browser' } },
    {
      ...meta(),
      type: 'tool/result',
      callId: 'load',
      isError: false,
      value: {
        kind: 'instructions',
        snapshot: { name: 'browser', version: 'v1', instructions: 'REQUIRED BROWSER INSTRUCTIONS' },
      },
    },
    {
      ...meta(),
      type: 'message/assistant',
      surfaceOp: 'append',
      content: [{ kind: 'text', text: 'answer' }],
    },
    { ...meta(), type: 'turn/end', reason: 'completed' },
  ];
  const messages = toModelMessages(events);
  expect(messages.map((message) => message.content)).toEqual([
    'REQUIRED BROWSER INSTRUCTIONS',
    'research',
    'answer',
  ]);
  expect(messages.some((message) => message.role === 'tool')).toBe(false);
});
