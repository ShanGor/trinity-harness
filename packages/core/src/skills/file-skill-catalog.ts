import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import {
  skillDefinitionSchema,
  skillSummarySchema,
  type SkillCatalogPort,
  type SkillCatalogResult,
  type SkillDefinition,
  type SkillSummary,
} from '@trinity-harness/contracts';
import { parseDocument } from 'yaml';
import { z } from 'zod';

const frontmatterSchema = z.object({
  name: skillDefinitionSchema.shape.name,
  description: skillDefinitionSchema.shape.description,
  'disable-model-invocation': z.boolean().default(false),
  'user-invocable': z.boolean().default(true),
});
const MAX_BYTES = 65_536;

export class SkillError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SkillError';
  }
}

function missing(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

/** Reject symlink components, absolute resources and escapes before opening. */
async function safePath(root: string, relative: string): Promise<string> {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
    throw new SkillError('SKILL_PATH', 'Skill paths must stay inside their source directory');
  }
  const base = path.resolve(root);
  if ((await fs.realpath(base)) !== base) {
    throw new SkillError(
      'SKILL_SYMLINK',
      'Symbolic links are not allowed in skill source ancestors',
    );
  }
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
    throw new SkillError('SKILL_PATH', 'Skill path escapes its source directory');
  }
  let current = base;
  for (const component of ['', ...path.relative(base, target).split(path.sep)].filter(
    (part, index) => index === 0 || part.length > 0,
  )) {
    current = path.join(current, component);
    if ((await fs.lstat(current)).isSymbolicLink()) {
      throw new SkillError('SKILL_SYMLINK', 'Symbolic links are not allowed in skill sources');
    }
  }
  return target;
}

async function readText(root: string, relative: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const target = await safePath(root, relative);
  const handle = await fs.open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    // On Linux verify the opened inode's location as well, closing a parent
    // symlink swap between path validation and open().
    if (
      process.platform === 'linux' &&
      (await fs.realpath(`/proc/self/fd/${handle.fd}`)) !== target
    ) {
      throw new SkillError('SKILL_PATH', 'Skill source changed while opening');
    }
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) {
      throw new SkillError('SKILL_SIZE', 'Skill text must be a regular file of at most 64 KiB');
    }
    // A bounded read also handles a file growing after stat().
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      signal?.throwIfAborted();
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    signal?.throwIfAborted();
    if (bytesRead > MAX_BYTES || buffer.subarray(0, bytesRead).includes(0)) {
      throw new SkillError('SKILL_SIZE', 'Skill text is oversized or binary');
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch {
      throw new SkillError('SKILL_ENCODING', 'Skill text must be UTF-8');
    }
  } finally {
    await handle.close();
  }
}

export interface FileSkillCatalogOptions {
  bundledDirectories?: readonly string[];
  configuredDirectories?: readonly string[];
}

/** Stateless, bounded discovery; never scans parents or the server user's home. */
export class FileSkillCatalog implements SkillCatalogPort {
  constructor(private readonly options: FileSkillCatalogOptions = {}) {}

  private async discover(
    workspaceRoot: string,
    signal?: AbortSignal,
  ): Promise<{
    definitions: SkillDefinition[];
    diagnostics: SkillCatalogResult['diagnostics'];
  }> {
    const sources: { root: string; relative: string; source: SkillSummary['source'] }[] = [
      ...['.trinity/skills', '.agents/skills', '.claude/skills'].map((relative) => ({
        root: workspaceRoot,
        relative,
        source: 'workspace' as const,
      })),
      ...(this.options.configuredDirectories ?? []).map((root) => ({
        root,
        relative: '',
        source: 'configured' as const,
      })),
      ...(this.options.bundledDirectories ?? []).map((root) => ({
        root,
        relative: '',
        source: 'bundled' as const,
      })),
    ];
    const definitions = new Map<string, SkillDefinition>();
    const diagnostics: SkillCatalogResult['diagnostics'] = [];
    const report = (diagnostic: SkillCatalogResult['diagnostics'][number]): void => {
      if (diagnostics.length < 256) diagnostics.push(diagnostic);
    };
    let visited = 0;
    for (const source of sources) {
      const walk = async (relative: string, depth: number): Promise<void> => {
        signal?.throwIfAborted();
        if (depth > 8 || ++visited > 512) {
          throw new SkillError('SKILL_LIMIT', 'Skill discovery directory limit exceeded');
        }
        const directory = await safePath(source.root, relative);
        const entries = [];
        const dir = await fs.opendir(directory);
        for await (const entry of dir) {
          signal?.throwIfAborted();
          if (entries.length >= 1024)
            throw new SkillError('SKILL_LIMIT', 'Skill directory entry limit exceeded');
          entries.push(entry);
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        if (entries.some((entry) => entry.name === 'SKILL.md')) {
          const skillPath = path.join(relative, 'SKILL.md');
          try {
            const text = await readText(source.root, skillPath, signal);
            const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
            if (!match) throw new SkillError('SKILL_FORMAT', 'SKILL.md requires YAML frontmatter');
            const document = parseDocument(match[1]!, { uniqueKeys: true });
            if (document.errors.length > 0) {
              throw new SkillError('SKILL_FORMAT', 'Invalid skill YAML frontmatter');
            }
            const parsed = frontmatterSchema.safeParse(document.toJS({ maxAliasCount: 20 }));
            if (!parsed.success || match[2]!.trim().length === 0) {
              throw new SkillError('SKILL_FORMAT', 'Invalid skill metadata or empty instructions');
            }
            const definition = skillDefinitionSchema.parse({
              name: parsed.data.name,
              description: parsed.data.description,
              modelInvocable: !parsed.data['disable-model-invocation'],
              userInvocable: parsed.data['user-invocable'],
              source: source.source,
              version: createHash('sha256').update(directory).update(text).digest('hex'),
              baseDirectory: directory,
              body: match[2]!.trim(),
            });
            if (!definitions.has(definition.name)) {
              if (definitions.size >= 128)
                throw new SkillError('SKILL_LIMIT', 'Skill catalog limit exceeded');
              definitions.set(definition.name, definition);
            }
          } catch (err) {
            signal?.throwIfAborted();
            report({
              path: path.join(directory, 'SKILL.md'),
              message:
                err instanceof SkillError ? err.message : 'Unable to parse skill instructions',
            });
          }
          return; // Resources beneath a skill directory are not additional skills.
        }
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.')) {
            await walk(path.join(relative, entry.name), depth + 1);
          } else if (entry.isSymbolicLink()) {
            report({
              path: path.join(directory, entry.name),
              message: 'Symbolic link ignored',
            });
          }
        }
      };
      try {
        await walk(source.relative, 0);
      } catch (err) {
        signal?.throwIfAborted();
        if (!missing(err))
          report({
            path: path.resolve(source.root, source.relative),
            message: err instanceof SkillError ? err.message : 'Unable to read skill directory',
          });
      }
    }
    return { definitions: [...definitions.values()], diagnostics };
  }

  async list(workspaceRoot: string, signal?: AbortSignal): Promise<SkillCatalogResult> {
    const { definitions, diagnostics } = await this.discover(workspaceRoot, signal);
    return {
      skills: definitions.map((definition) => skillSummarySchema.parse(definition)),
      diagnostics,
    };
  }

  async load(workspaceRoot: string, name: string, signal?: AbortSignal): Promise<SkillDefinition> {
    const { definitions } = await this.discover(workspaceRoot, signal);
    const skill = definitions.find((entry) => entry.name === name);
    if (!skill) throw new SkillError('SKILL_NOT_FOUND', `Skill unavailable: ${name}`);
    return skill;
  }

  async readResource(
    skill: SkillDefinition,
    resource: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return readText(skill.baseDirectory, resource, signal);
  }
}
