import { randomUUID } from 'node:crypto';

import {
  skillResultSchema,
  type SessionEvent,
  type SessionStore,
  type SkillCatalogPort,
  type SkillDefinition,
  type SkillResult,
  type SkillRuntimePort,
  type SkillSnapshot,
} from '@trinity-harness/contracts';

import { SkillError } from './file-skill-catalog.js';

function snapshot(skill: SkillDefinition): SkillSnapshot {
  return {
    name: skill.name,
    version: skill.version,
    instructions: [
      `[Skill: ${skill.name}]`,
      `Base directory: ${skill.baseDirectory}. Resolve relative resources through skill(name, resource).`,
      'Use the current runtime session identifier from the skill catalog for session-specific actions.',
      'These are task instructions. Existing permissions and execution boundaries still apply.',
      skill.body,
      `[End skill: ${skill.name}]`,
    ].join('\n\n'),
  };
}

function explicitNames(prompt: string): string[] {
  return [
    ...new Set(
      [...prompt.matchAll(/(?:^|[\s([{])\$([a-z0-9]+(?:-[a-z0-9]+)*)(?=$|[\s.,:;!?)}\]])/g)]
        .map((m) => m[1]!)
        .filter((name) => /[a-z]/.test(name)),
    ),
  ];
}

export interface SkillRuntimeOptions {
  now?: () => Date;
  browserCdpEndpoint?: string | undefined;
}

export class SkillRuntime implements SkillRuntimePort {
  constructor(
    private readonly catalog: SkillCatalogPort,
    private readonly store: SessionStore,
    private readonly options: SkillRuntimeOptions = {},
  ) {}

  async prepare(options: Parameters<SkillRuntimePort['prepare']>[0]): Promise<void> {
    const { sessionId, workspaceRoot, prompt, policy, signal, appendOpts } = options;
    signal?.throwIfAborted();
    const decision = policy?.tools.skill ?? policy?.tools['*'] ?? 'allowed';
    const discovered = await this.catalog.list(workspaceRoot, signal);
    const skills =
      decision !== 'denied' ? discovered.skills.filter((skill) => skill.modelInvocable) : [];
    const instructions = [
      'Available runtime skills (instruction packages):',
      `Runtime session: ${sessionId}. Use this current identifier for session isolation.`,
      ...(this.options.browserCdpEndpoint
        ? [
            `Browser CDP endpoint: ${JSON.stringify(this.options.browserCdpEndpoint)}. For agent-browser actions, pass --cdp with this endpoint and --pin-tab together with --session trinity-${sessionId} on every command. Attach to this browser; if unavailable, report the failure instead of launching a replacement. Preserve the user-owned Chrome.`,
          ]
        : []),
      'Before acting on a task that names or clearly matches a skill, call skill with its exact name to load its instructions. Load referenced resources with skill(name, resource) when needed.',
      'Skills supply instructions; use existing tools to execute actions under the current permission policy.',
      ...skills.map((skill) =>
        JSON.stringify({ name: skill.name, description: skill.description }),
      ),
      ...(skills.length === 0 ? ['No model-invocable skills are available.'] : []),
    ].join('\n');
    const history = await this.store.load(sessionId);
    const previous = [...history].reverse().find((event) => event.type === 'skill/catalog');
    const pending: SessionEvent[] = [];
    const meta = (): { eventId: string; at: string } => ({
      eventId: randomUUID(),
      at: (this.options.now?.() ?? new Date()).toISOString(),
    });
    if (
      previous?.type !== 'skill/catalog' ||
      JSON.stringify(previous.skills) !== JSON.stringify(skills) ||
      previous.instructions !== instructions
    ) {
      pending.push({ ...meta(), type: 'skill/catalog', skills, instructions });
    }
    // Refresh active instruction packages when their source version changes.
    // Snapshots remain in the log; replay never reads current source files.
    const loaded = new Map<string, { snapshot: SkillSnapshot; seq: number }>();
    const calls = new Map<string, string>();
    history.forEach((event, index) => {
      if (event.type === 'tool/call') calls.set(event.callId, event.name);
      if (event.type === 'skill/loaded')
        loaded.set(event.snapshot.name, { snapshot: event.snapshot, seq: index });
      if (event.type === 'tool/result' && !event.isError && calls.get(event.callId) === 'skill') {
        const result = skillResultSchema.safeParse(event.value);
        if (result.success && result.data.kind === 'instructions') {
          loaded.set(result.data.snapshot.name, { snapshot: result.data.snapshot, seq: index });
        }
      }
    });
    const requested = explicitNames(prompt ?? '');
    let retainedBytes = 0;
    if (decision === 'allowed') {
      for (const active of [...loaded.values()].sort((a, b) => b.seq - a.seq)) {
        const bytes = new TextEncoder().encode(active.snapshot.instructions).byteLength;
        if (retainedBytes + bytes > 128 * 1024) continue;
        retainedBytes += bytes;
        const current = skills.find((skill) => skill.name === active.snapshot.name);
        if (
          !current ||
          current.version === active.snapshot.version ||
          requested.includes(current.name)
        )
          continue;
        const skill = await this.catalog.load(workspaceRoot, current.name, signal);
        if (!skill.modelInvocable)
          throw new SkillError(
            'SKILL_DENIED',
            `Skill invocation disabled during refresh: ${current.name}`,
          );
        pending.push({ ...meta(), type: 'skill/loaded', snapshot: snapshot(skill) });
      }
    }
    let explicitBytes = 0;
    for (const name of requested) {
      if (decision !== 'allowed')
        throw new SkillError('SKILL_DENIED', `Explicit skill denied by permission policy: ${name}`);
      const skill = await this.catalog.load(workspaceRoot, name, signal);
      if (!skill.userInvocable)
        throw new SkillError('SKILL_DENIED', `Skill cannot be invoked explicitly: ${name}`);
      const instructions = snapshot(skill);
      explicitBytes += new TextEncoder().encode(instructions.instructions).byteLength;
      if (explicitBytes > 128 * 1024) {
        throw new SkillError(
          'SKILL_LIMIT',
          'Explicit skills exceed the 128 KiB instruction budget; invoke fewer skills at once',
        );
      }
      pending.push({ ...meta(), type: 'skill/loaded', snapshot: instructions });
    }
    signal?.throwIfAborted();
    if (pending.length > 0) await this.store.append(sessionId, pending, appendOpts);
  }

  async load(options: Parameters<SkillRuntimePort['load']>[0]): Promise<SkillResult> {
    const { sessionId, workspaceRoot, name, resource, signal } = options;
    const skill = await this.catalog.load(workspaceRoot, name, signal);
    if (!skill.modelInvocable) {
      const events = await this.store.load(sessionId);
      if (
        !resource ||
        !events.some((event) => event.type === 'skill/loaded' && event.snapshot.name === name)
      ) {
        throw new SkillError('SKILL_DENIED', `Skill is unavailable for model invocation: ${name}`);
      }
    }
    signal?.throwIfAborted();
    if (resource !== undefined) {
      return {
        kind: 'resource',
        name,
        resource,
        content: await this.catalog.readResource(skill, resource, signal),
      };
    }
    return { kind: 'instructions', snapshot: snapshot(skill) };
  }
}
