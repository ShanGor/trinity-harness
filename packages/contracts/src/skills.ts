import { z } from 'zod';

import type { PermissionPolicy } from './approval.js';
import type { AppendOptions } from './session.js';

export const skillNameSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(64);
export const skillSummarySchema = z.object({
  name: skillNameSchema,
  description: z.string().min(1).max(1024),
  source: z.enum(['workspace', 'configured', 'bundled']),
  version: z.string().min(1),
  modelInvocable: z.boolean(),
  userInvocable: z.boolean(),
});
export type SkillSummary = z.infer<typeof skillSummarySchema>;
export const skillDefinitionSchema = skillSummarySchema.extend({
  baseDirectory: z.string().min(1),
  body: z.string().max(65_536),
});
export type SkillDefinition = z.infer<typeof skillDefinitionSchema>;
export const skillSnapshotSchema = z.object({
  name: skillNameSchema,
  version: z.string().min(1),
  instructions: z.string().max(70_000),
});
export type SkillSnapshot = z.infer<typeof skillSnapshotSchema>;
export const skillResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('instructions'), snapshot: skillSnapshotSchema }),
  z.object({
    kind: z.literal('resource'),
    name: skillNameSchema,
    resource: z.string().max(1024),
    content: z.string().max(65_536),
  }),
]);
export type SkillResult = z.infer<typeof skillResultSchema>;
export const skillArgumentsSchema = z.object({
  name: skillNameSchema,
  resource: z.string().min(1).max(1024).optional(),
});
export type SkillArguments = z.infer<typeof skillArgumentsSchema>;
export const skillDirectoriesSchema = z.array(z.string().min(1)).max(32);
export const skillCatalogResultSchema = z.object({
  skills: z.array(skillSummarySchema).max(128),
  diagnostics: z.array(z.object({ path: z.string(), message: z.string() })).max(256),
});
export type SkillCatalogResult = z.infer<typeof skillCatalogResultSchema>;

/** Read-only instruction sources; implementations enforce workspace boundaries. */
export interface SkillCatalogPort {
  list(workspaceRoot: string, signal?: AbortSignal): Promise<SkillCatalogResult>;
  load(workspaceRoot: string, name: string, signal?: AbortSignal): Promise<SkillDefinition>;
  readResource(skill: SkillDefinition, resource: string, signal?: AbortSignal): Promise<string>;
}

/** Session orchestration; all model-visible instruction context is persisted. */
export interface SkillRuntimePort {
  prepare(options: {
    sessionId: string;
    workspaceRoot: string;
    prompt?: string | undefined;
    policy?: PermissionPolicy | undefined;
    signal?: AbortSignal | undefined;
    appendOpts?: AppendOptions | undefined;
  }): Promise<void>;
  load(
    options: SkillArguments & {
      sessionId: string;
      workspaceRoot: string;
      signal?: AbortSignal | undefined;
    },
  ): Promise<SkillResult>;
}

export const skillDirectoriesEnvSchema = z
  .string()
  .default('[]')
  .transform((value, ctx) => {
    try {
      return skillDirectoriesSchema.parse(JSON.parse(value));
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'SKILL_DIRS must be a JSON array of directory paths',
      });
      return z.NEVER;
    }
  });

/** Administrator-supplied endpoint; reject credentials that would enter event logs. */
export const browserCdpEndpointSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    if (/^\d+$/.test(value)) return Number(value) >= 1 && Number(value) <= 65535;
    try {
      const url = new URL(value);
      return (
        ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) &&
        url.hostname.length > 0 &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, 'Browser CDP endpoint must be a port (1–65535) or an HTTP/WebSocket URL without credentials, query or fragment');
