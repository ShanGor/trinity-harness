import { z } from 'zod';
import { browserUrlSchema } from './browser.js';
import { browserPreviewSchema } from './browser-preview.js';

const point = z
  .object({ x: z.number().nonnegative().max(2048), y: z.number().nonnegative().max(2048) })
  .strict();
const modifiers = z.array(z.enum(['alt', 'ctrl', 'meta', 'shift'])).max(4);
export const browserHumanActionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('click'),
      point,
      button: z.enum(['left', 'right', 'middle']).default('left'),
      count: z.number().int().min(1).max(2).default(1),
      modifiers: modifiers.default([]),
    })
    .strict(),
  z.object({ type: z.literal('drag'), from: point, to: point }).strict(),
  z
    .object({
      type: z.literal('scroll'),
      dx: z.number().int().min(-2000).max(2000),
      dy: z.number().int().min(-2000).max(2000),
    })
    .strict(),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(4000) }).strict(),
  z
    .object({
      type: z.literal('key'),
      key: z
        .string()
        .min(1)
        .max(30)
        .refine(
          (key) =>
            key.length === 1 ||
            [
              'Enter',
              'Tab',
              'Escape',
              'Backspace',
              'Delete',
              'ArrowUp',
              'ArrowDown',
              'ArrowLeft',
              'ArrowRight',
              'Home',
              'End',
              'PageUp',
              'PageDown',
              'Space',
            ].includes(key),
        ),
      modifiers: modifiers.default([]),
    })
    .strict(),
  z.object({ type: z.literal('navigate'), url: browserUrlSchema }).strict(),
  z.object({ type: z.literal('back') }).strict(),
  z.object({ type: z.literal('forward') }).strict(),
  z.object({ type: z.literal('reload') }).strict(),
  z.object({ type: z.literal('new_tab') }).strict(),
  z
    .object({
      type: z.literal('switch_tab'),
      tabId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
    })
    .strict(),
  z
    .object({
      type: z.literal('close_tab'),
      tabId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
    })
    .strict(),
]);
export type BrowserHumanAction = z.infer<typeof browserHumanActionSchema>;
const base = { sessionId: z.uuid(), viewId: z.uuid() };
const fenced = { ...base, generation: z.uuid(), epoch: z.number().int().nonnegative() };
export const browserInteractionRequestSchema = z.discriminatedUnion('operation', [
  z.object({ ...base, operation: z.literal('state') }).strict(),
  z.object({ ...base, operation: z.literal('frame') }).strict(),
  z.object({ ...base, operation: z.literal('take') }).strict(),
  z.object({ ...base, operation: z.literal('reset') }).strict(),
  z.object({ ...fenced, operation: z.literal('release') }).strict(),
  z.object({ ...fenced, operation: z.literal('pause') }).strict(),
  z.object({ ...fenced, operation: z.literal('heartbeat') }).strict(),
  z
    .object({
      ...fenced,
      operation: z.literal('input'),
      requestId: z.uuid(),
      sequence: z.number().int().positive(),
      frameId: z.uuid(),
      keyboardId: z.uuid().optional(),
      capture: z.boolean().optional(),
      action: browserHumanActionSchema,
    })
    .strict(),
]);
export type BrowserInteractionRequest = z.infer<typeof browserInteractionRequestSchema>;
export const browserControlStateSchema = z
  .object({
    available: z.boolean(),
    mode: z.enum(['agent', 'human', 'paused', 'quarantined']),
    generation: z.uuid().nullable(),
    epoch: z.number().int().nonnegative(),
    controllerId: z.uuid().nullable(),
    expiresAt: z.iso.datetime().nullable(),
    nextSequence: z.number().int().positive(),
  })
  .strict();
export type BrowserControlState = z.infer<typeof browserControlStateSchema>;
/** Private viewer chrome; never a model observation or event payload. */
export const browserViewerChromeSchema = z
  .object({
    tabs: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
            title: z.string().max(300),
            url: z.string().max(8192),
            active: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict();
export const browserInteractionFrameSchema = browserPreviewSchema.options[0].extend({
  frameId: z.uuid(),
  epoch: z.number().int().nonnegative(),
  browser: browserViewerChromeSchema.optional(),
});
export type BrowserInteractionFrame = z.infer<typeof browserInteractionFrameSchema>;
export const browserInteractionResultSchema = z
  .object({
    state: browserControlStateSchema,
    frame: browserInteractionFrameSchema.optional(),
    keyboardId: z.uuid().optional(),
    error: z
      .object({
        code: z.enum([
          'UNAVAILABLE',
          'NOT_AUTHORIZED',
          'NOT_CONTROLLER',
          'STALE_FRAME',
          'STALE_CONTROL',
          'INPUT_SEQUENCE',
          'UNKNOWN_EFFECT',
          'PRIVACY_BLOCKED',
          'BUSY',
        ]),
        message: z.string().max(500),
      })
      .strict()
      .optional(),
    input: z
      .object({ requestId: z.uuid(), effect: z.enum(['applied', 'none', 'unknown']) })
      .strict()
      .optional(),
  })
  .strict();
export type BrowserInteractionResult = z.infer<typeof browserInteractionResultSchema>;
export const browserFrameTargetSchema = z
  .object({
    frameId: z.uuid(),
    tabId: z.string().max(200),
    documentRevision: z.string().max(200),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    focusRevision: z.string().min(1).max(200).optional(),
    width: z.number().int().positive().max(2048),
    height: z.number().int().positive().max(2048),
    capturedAt: z.iso.datetime(),
  })
  .strict();
export type BrowserFrameTarget = z.infer<typeof browserFrameTargetSchema>;
export const browserKeyboardTargetSchema = z
  .object({
    tabId: z.string().max(200),
    documentRevision: z.string().max(200),
    focusRevision: z.string().min(1).max(200),
  })
  .strict();
export type BrowserKeyboardTarget = z.infer<typeof browserKeyboardTargetSchema>;
export const browserHumanInputResultSchema = z.discriminatedUnion('effect', [
  z.object({ effect: z.literal('none') }).strict(),
  z
    .object({ effect: z.literal('applied'), keyboard: browserKeyboardTargetSchema.optional() })
    .strict(),
]);
export type BrowserHumanInputResult = z.infer<typeof browserHumanInputResultSchema>;
export const browserControlRecordSchema = z
  .object({
    sessionId: z.uuid(),
    generation: z.uuid(),
    epoch: z.number().int().nonnegative(),
    mode: browserControlStateSchema.shape.mode,
    controllerId: z.uuid().nullable(),
    expiresAt: z.iso.datetime().nullable(),
    sequence: z.number().int().nonnegative(),
    frame: browserFrameTargetSchema.nullable(),
    frames: z.array(browserFrameTargetSchema).max(8).default([]),
    keyboard: z
      .object({ id: z.uuid(), target: browserKeyboardTargetSchema })
      .strict()
      .nullable()
      .default(null),
    needsObservation: z.boolean().default(false),
    observedSessions: z.array(z.uuid()).max(128).default([]),
  })
  .strict();
export type BrowserControlRecord = z.infer<typeof browserControlRecordSchema>;
export const browserInputRecordSchema = z
  .object({
    sourceSessionId: z.uuid().optional(),
    generation: z.uuid(),
    epoch: z.number().int().nonnegative(),
    sequence: z.number().int().positive(),
    viewId: z.uuid(),
    effect: z.enum(['applied', 'none', 'unknown']),
  })
  .strict();
export type BrowserInputRecord = z.infer<typeof browserInputRecordSchema>;
export interface BrowserInteractionPort {
  interact(
    request: BrowserInteractionRequest,
    signal?: AbortSignal,
  ): Promise<BrowserInteractionResult>;
}
export interface BrowserInteractionStore {
  get(sessionId: string): Promise<BrowserControlRecord | null>;
  put(record: BrowserControlRecord): Promise<void>;
  input(sessionId: string, requestId: string): Promise<BrowserInputRecord | null>;
  reserve(record: BrowserControlRecord, requestId: string, sourceSessionId?: string): Promise<void>;
  finish(
    sessionId: string,
    requestId: string,
    effect: 'applied' | 'none' | 'unknown',
  ): Promise<void>;
}
export const browserHumanCaptureSchema = z
  .object({
    preview: browserPreviewSchema,
    target: browserFrameTargetSchema.omit({ frameId: true }).optional(),
    browser: browserViewerChromeSchema.optional(),
  })
  .strict();
export type BrowserHumanCapture = z.infer<typeof browserHumanCaptureSchema>;
