import { z } from 'zod';
import type { EnvironmentRecord } from './environments.js';
import { skillCatalogResultSchema, skillDefinitionSchema, skillNameSchema } from './skills.js';

export const GUEST_MAX_BYTES = 20 * 1024 * 1024;
export const GUEST_WIRE_BYTES = 32 * 1024 * 1024;
const text = z.string().max(GUEST_MAX_BYTES);
const file = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'));
const base64 = z
  .string()
  .max(Math.ceil(GUEST_MAX_BYTES / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const options = z
  .object({
    cwd: file.optional(),
    env: z
      .record(z.string().max(200), z.string().max(8192))
      .refine((value) => Object.keys(value).length <= 64)
      .optional(),
    timeoutMs: z.number().int().min(1).max(120_000).optional(),
  })
  .strict();
const processId = z.uuid();
export const guestOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('browserOpen') }).strict(),
  z
    .object({
      kind: z.literal('exec'),
      command: text,
      args: z.array(z.string().max(8192)).max(256).optional(),
      maxOutputBytes: z
        .number()
        .int()
        .min(1)
        .max(10 * 1024 * 1024),
      options,
    })
    .strict(),
  z
    .object({
      kind: z.literal('read'),
      path: file,
      maxBytes: z.number().int().min(1).max(GUEST_MAX_BYTES),
    })
    .strict(),
  z
    .object({
      kind: z.literal('readBytes'),
      path: file,
      maxBytes: z.number().int().min(1).max(GUEST_MAX_BYTES),
    })
    .strict(),
  z.object({ kind: z.literal('write'), path: file, content: text }).strict(),
  z.object({ kind: z.literal('writeBytes'), path: file, data: base64 }).strict(),
  z.object({ kind: z.literal('remove'), path: file }).strict(),
  z.object({ kind: z.literal('edit'), path: file, oldText: text, newText: text }).strict(),
  z.object({ kind: z.literal('glob'), pattern: file }).strict(),
  z
    .object({
      kind: z.literal('processOpen'),
      command: file,
      args: z.array(z.string().max(8192)).max(256),
      options,
    })
    .strict(),
  z
    .object({
      kind: z.literal('processWrite'),
      processId,
      seq: z.number().int().positive(),
      data: base64,
    })
    .strict(),
  z
    .object({ kind: z.literal('processRead'), processId, cursor: z.number().int().nonnegative() })
    .strict(),
  z.object({ kind: z.literal('processKill'), processId }).strict(),
  z.object({ kind: z.literal('skillsList') }).strict(),
  z.object({ kind: z.literal('skillLoad'), name: skillNameSchema }).strict(),
  z
    .object({
      kind: z.literal('skillResource'),
      name: skillNameSchema,
      version: z.string().max(200),
      resource: file,
    })
    .strict(),
]);
export type GuestOperation = z.infer<typeof guestOperationSchema>;
export const guestEnvelopeSchema = z
  .object({
    requestId: z.uuid(),
    environmentId: z.uuid(),
    generation: z.uuid(),
    sessionId: z.uuid(),
    workspace: file.refine(
      (value) =>
        !value.startsWith('/') &&
        value.split('/').every((part) => part !== '..' && part !== '.' && part.length > 0),
    ),
    operation: guestOperationSchema,
  })
  .strict();
export type GuestEnvelope = z.infer<typeof guestEnvelopeSchema>;
export const guestOperationErrorSchema = z
  .object({
    kind: z.literal('operationError'),
    operation: z.enum(['read', 'readBytes']),
    code: z.enum(['FILE_NOT_FOUND', 'ACCESS_DENIED', 'NOT_A_DIRECTORY', 'IS_A_DIRECTORY']),
    effect: z.literal('none'),
  })
  .strict();
export type GuestOperationFailure = z.infer<typeof guestOperationErrorSchema>;
export const guestValueSchema = z.discriminatedUnion('kind', [
  guestOperationErrorSchema,
  z
    .object({
      kind: z.literal('exec'),
      stdout: text,
      stderr: text,
      exitCode: z.number().int(),
      outputOverflow: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal('read'), content: text, truncated: z.boolean() }).strict(),
  z.object({ kind: z.literal('bytes'), data: base64 }).strict(),
  z.object({ kind: z.literal('ok') }).strict(),
  z.object({ kind: z.literal('edit'), content: text, replacements: z.number().int() }).strict(),
  z.object({ kind: z.literal('glob'), paths: z.array(file).max(10000) }).strict(),
  z.object({ kind: z.literal('process'), processId }).strict(),
  z
    .object({
      kind: z.literal('processOutput'),
      cursor: z.number().int().nonnegative(),
      data: base64,
      exited: z.boolean(),
      exitCode: z.number().int().nullable(),
    })
    .strict(),
  z.object({ kind: z.literal('skills'), catalog: skillCatalogResultSchema }).strict(),
  z.object({ kind: z.literal('skill'), definition: skillDefinitionSchema }).strict(),
  z.object({ kind: z.literal('resource'), content: z.string().max(65536) }).strict(),
]);
export type GuestValue = z.infer<typeof guestValueSchema>;
export const guestResponseSchema = z
  .object({ requestId: z.uuid(), generation: z.uuid(), value: guestValueSchema })
  .strict();
export interface GuestRequestPort {
  call(sessionId: string, operation: GuestOperation, signal?: AbortSignal): Promise<GuestValue>;
}
export interface GuestRelayPort {
  call(
    environment: EnvironmentRecord,
    request: GuestEnvelope,
    signal?: AbortSignal,
  ): Promise<GuestValue>;
}

export const executionDriverSchema = z.enum(['local', 'firecracker']).default('local');
