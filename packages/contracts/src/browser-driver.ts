import { z } from 'zod';
import { browserArgumentsSchema, browserResultSchema, browserErrorSchema } from './browser.js';
import type { BrowserBinding, BrowserCapture, BrowserSurface } from './browser.js';
import type { ToolContext, ToolResult } from './tools.js';

const path = z.array(z.number().int().nonnegative()).max(80);
export const browserDriverActionSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('click'),
    path: path.optional(),
    dom: z.boolean().optional(),
    point: z.object({ x: z.number().nonnegative(), y: z.number().nonnegative() }).optional(),
  }),
  z.object({ operation: z.literal('fill'), path, text: z.string().max(4000) }),
  z.object({
    operation: z.literal('key'),
    path,
    key: z.enum([
      'Enter',
      'Escape',
      'Tab',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Space',
      'Backspace',
    ]),
  }),
  z.object({
    operation: z.literal('scroll'),
    direction: z.enum(['up', 'down', 'left', 'right']),
    pixels: z.number().int().min(1).max(2000),
  }),
]);
export type BrowserDriverAction = z.infer<typeof browserDriverActionSchema>;
export const browserDriverStateSchema = z.object({
  url: z.string().max(2000),
  documentRevision: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  browserVersion: z.string().min(1).max(100),
  tabId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
});
export type BrowserDriverState = z.infer<typeof browserDriverStateSchema>;

/** Only fixed operations are exposed here; JavaScript and selectors stay adapter-owned. */
export interface BrowserDriverPort {
  verify(binding: BrowserBinding, ctx: ToolContext): Promise<void>;
  surface(
    binding: BrowserBinding,
    filter: 'interactive' | 'all',
    scope: number[] | undefined,
    ctx: ToolContext,
  ): Promise<BrowserSurface>;
  capture(
    binding: BrowserBinding,
    mode: 'article' | 'documentation',
    scope: number[] | undefined,
    ctx: ToolContext,
  ): Promise<BrowserCapture>;
  navigate(binding: BrowserBinding, url: string, ctx: ToolContext): Promise<void>;
  act(binding: BrowserBinding, action: BrowserDriverAction, ctx: ToolContext): Promise<void>;
  pointAllowed(
    binding: BrowserBinding,
    point: { x: number; y: number },
    ctx: ToolContext,
  ): Promise<boolean>;
  readiness(
    binding: BrowserBinding,
    text: string,
    timeoutMs: number,
    ctx: ToolContext,
  ): Promise<'ready' | 'timed_out'>;
  accessibility(
    binding: BrowserBinding,
    surface: BrowserSurface,
    filter: 'interactive' | 'all',
    scope: number[] | undefined,
    ctx: ToolContext,
  ): Promise<string>;
  paint(binding: BrowserBinding, ctx: ToolContext): Promise<'ready' | 'timed_out'>;
  screenshot(binding: BrowserBinding, ctx: ToolContext): Promise<Uint8Array>;
}

export const browserRuntimeRequestSchema = z
  .object({
    sessionId: z.uuid(),
    callId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
    args: browserArgumentsSchema,
    permissionGranted: z.boolean(),
  })
  .strict();
export type BrowserRuntimeRequest = z.infer<typeof browserRuntimeRequestSchema>;
export const browserRuntimeResultSchema = z
  .object({
    value: z.union([browserResultSchema, browserErrorSchema]),
    isError: z.boolean(),
  })
  .superRefine((r, ctx) => {
    if (r.isError !== (r.value.kind === 'browser-error-v1'))
      ctx.addIssue({ code: 'custom', message: 'Inconsistent browser outcome' });
  });
export type BrowserRuntimeResult = z.infer<typeof browserRuntimeResultSchema>;
export const browserCommandRecordSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  result: browserRuntimeResultSchema.nullable(),
});
export type BrowserCommandRecord = z.infer<typeof browserCommandRecordSchema>;
export interface BrowserRuntimePort {
  execute(request: BrowserRuntimeRequest, signal?: AbortSignal): Promise<BrowserRuntimeResult>;
}

export const browserRuntimeRecordSchema = z.object({
  sessionId: z.uuid(),
  generation: z.uuid(),
  owner: z.uuid(),
  status: z.enum(['active', 'invalid']),
});
export type BrowserRuntimeRecord = z.infer<typeof browserRuntimeRecordSchema>;
export interface BrowserRuntimeStore {
  /** Distributed, connection-scoped lock; disconnection must abort the operation. */
  run<T>(
    sessionId: string,
    action: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  binding(sessionId: string): Promise<BrowserRuntimeRecord | null>;
  bind(record: BrowserRuntimeRecord): Promise<void>;
  command(sessionId: string, callId: string): Promise<BrowserCommandRecord | null>;
  begin(sessionId: string, callId: string, hash: string, generation: string): Promise<void>;
  finish(sessionId: string, callId: string, result: BrowserRuntimeResult): Promise<void>;
}

/** Supervisor resources are execution infrastructure, never worker authority. */
export interface ManagedBrowserSession {
  generation: string;
  execute(request: BrowserRuntimeRequest, signal: AbortSignal): Promise<ToolResult>;
  dispose(): Promise<void>;
}
