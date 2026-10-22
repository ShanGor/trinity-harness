import { z } from 'zod';

export const BROWSER_LIMITS = {
  artifact: 256 * 1024,
  transport: 320 * 1024,
  overview: 6 * 1024,
  focused: 8 * 1024,
  diagnostic: 2 * 1024,
  callsPerStep: 16,
  image: 2 * 1024 * 1024,
  imageDimension: 2048,
} as const;
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
export const browserUrlSchema = z
  .url()
  .max(2000)
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  }, 'Expected credential-free HTTP(S) URL');
export const browserRangeSchema = z
  .object({
    blockId: id,
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .refine((range) => range.end > range.start, 'Expected nonempty half-open code-point range');
export type BrowserRange = z.infer<typeof browserRangeSchema>;
export const browserSourceSchema = z.object({
  observationId: id,
  blockId: id,
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().positive().optional(),
});
export const browserBlockSchema = z.object({
  id,
  kind: z.enum(['heading', 'paragraph', 'list_item', 'table', 'code', 'accessibility']),
  text: z.string().max(64_000),
  sectionId: id.nullable(),
  links: z.array(z.object({ title: z.string().max(200), url: browserUrlSchema })).max(20),
  rows: z
    .array(z.array(z.object({ text: z.string().max(8000), header: z.boolean() })).max(40))
    .max(100)
    .optional(),
});
export const browserCaptureSchema = z.object({
  schemaVersion: z.literal(1),
  extractorVersion: z.enum(['semantic-v1', 'semantic-v2']),
  url: browserUrlSchema,
  title: z.string().max(1000),
  publishedAt: z.object({ value: z.string().max(200), origin: z.string().max(200) }).nullable(),
  readiness: z.enum(['ready', 'partial', 'timed_out']),
  representation: z.enum(['article', 'documentation', 'accessibility']),
  scope: z.string().max(200),
  exclusions: z.array(z.string().max(200)).max(20),
  blocks: z.array(browserBlockSchema).max(1000),
  captureTruncated: z.boolean(),
});
export type BrowserCapture = z.infer<typeof browserCaptureSchema>;
export const browserViewportSchema = z.object({
  width: z.number().positive().max(10000),
  height: z.number().positive().max(10000),
  scrollX: z.number().finite(),
  scrollY: z.number().finite(),
  devicePixelRatio: z.number().positive().max(10),
  locale: z.string().max(100),
  timezone: z.string().max(100),
});
export const browserTargetSchema = z.object({
  ref: id,
  role: z.string().max(100),
  name: z.string().max(300),
  path: z.array(z.number().int().nonnegative()).max(80),
  disabled: z.boolean(),
  sensitive: z.boolean(),
  activation: z.enum(['dom', 'enter', 'space', 'pointer']).optional(),
  box: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
  }),
});
export const browserInteractionSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  context: browserViewportSchema,
  targets: z.array(browserTargetSchema).max(100),
  truncated: z.boolean(),
  filter: z.enum(['interactive', 'all']).optional(),
  scopePath: z.array(z.number().int().nonnegative()).max(80).optional(),
});
export type BrowserInteraction = z.infer<typeof browserInteractionSchema>;
export const browserImageSchema = z.object({
  uri: z.string().max(500),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  mimeType: z.literal('image/png'),
  bytes: z.number().int().positive().max(BROWSER_LIMITS.image),
  width: z.number().int().positive().max(BROWSER_LIMITS.imageDimension),
  height: z.number().int().positive().max(BROWSER_LIMITS.imageDimension),
  crop: z.object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  scale: z.literal(1),
});
export const browserReadinessSchema = z.object({
  text: z.string().min(1).max(200),
  timeoutMs: z.number().int().min(100).max(10000).default(3000),
});
const scope = z.object({ snapshotId: id, ref: id });
export const browserDriverMetadataSchema = z.object({
  engine: z.enum(['agent-browser', 'zendriver']),
  adapterVersion: z.literal(1),
  upstreamVersion: z.string().min(1).max(100),
  runtimeGeneration: id.optional(),
});
export const browserSurfaceSchema = z.object({
  context: browserViewportSchema,
  targets: z.array(browserTargetSchema).max(100),
  truncated: z.boolean(),
  privacyDenied: z.boolean(),
});
export type BrowserSurface = z.infer<typeof browserSurfaceSchema>;
export const browserObservationSchema = browserCaptureSchema.extend({
  observationId: id,
  sessionId: z.string().min(1).max(200),
  bindingId: id,
  tabId: id,
  documentRevision: id,
  cliVersion: z.string().min(1).max(100),
  browserVersion: z.string().min(1).max(100),
  capturedAt: z.iso.datetime(),
  driver: browserDriverMetadataSchema.optional(),
  securityMode: z.enum(['trusted-cdp', 'trusted-managed', 'enforced']).optional(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  interaction: browserInteractionSchema.optional(),
  image: browserImageSchema.optional(),
  readinessCondition: browserReadinessSchema.optional(),
});
export type BrowserObservation = z.infer<typeof browserObservationSchema>;
const navigate = z.object({
  operation: z.literal('navigate'),
  url: browserUrlSchema,
  readiness: browserReadinessSchema.optional(),
});
const webSearch = z.object({
  operation: z.literal('web_search'),
  query: z.string().trim().min(1).max(200),
});
const readPage = z.object({
  operation: z.literal('read_page'),
  filter: z.enum(['interactive', 'all']).default('interactive'),
  scope: scope.optional(),
});
const getText = z.object({
  operation: z.literal('get_page_text'),
  mode: z.enum(['article', 'documentation']).default('article'),
  scope: scope.optional(),
});
export const browserActionOperations = ['click', 'fill', 'scroll', 'key'] as const;
const click = z
  .object({
    operation: z.literal('click'),
    snapshotId: id,
    ref: id.optional(),
    point: z.object({ x: z.number().nonnegative(), y: z.number().nonnegative() }).optional(),
    readiness: browserReadinessSchema.optional(),
  })
  .refine((a) => Boolean(a.ref) !== Boolean(a.point), 'Provide one ref or point');
const fill = z.object({
  operation: z.literal('fill'),
  snapshotId: id,
  ref: id,
  text: z.string().max(4000),
  readiness: browserReadinessSchema.optional(),
});
const scroll = z.object({
  operation: z.literal('scroll'),
  snapshotId: id,
  direction: z.enum(['up', 'down', 'left', 'right']),
  pixels: z.number().int().min(1).max(2000),
  readiness: browserReadinessSchema.optional(),
});
const key = z.object({
  operation: z.literal('key'),
  snapshotId: id,
  ref: id,
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
  readiness: browserReadinessSchema.optional(),
});
const screenshot = z.object({
  operation: z.literal('screenshot'),
  crop: browserImageSchema.shape.crop.optional(),
});
const read = z.object({
  operation: z.literal('read_observation'),
  observationId: id,
  blockIds: z.array(id).min(1).max(20).optional(),
  sectionId: id.optional(),
  cursor: z.object({ blockId: id, offset: z.number().int().nonnegative() }).optional(),
});
const search = z.object({
  operation: z.literal('search_observation'),
  observationId: id,
  query: z.string().min(1).max(200),
  cursor: z.object({ blockId: id, offset: z.number().int().nonnegative() }).optional(),
});
export const browserArgumentsSchema = z.discriminatedUnion('operation', [
  navigate,
  webSearch,
  readPage,
  getText,
  read,
  search,
  click,
  fill,
  scroll,
  key,
  screenshot,
]);
export type BrowserArguments = z.infer<typeof browserArgumentsSchema>;
export const browserResultSchema = z.object({
  kind: z.literal('browser-result-v1'),
  operation: z.enum([
    'navigate',
    'web_search',
    'read_page',
    'get_page_text',
    'read_observation',
    'search_observation',
    'click',
    'fill',
    'scroll',
    'key',
    'screenshot',
  ]),
  callId: id,
  sessionId: z.string().min(1).max(200),
  observationId: id,
  artifactUri: z.string().min(1).max(500),
  url: browserUrlSchema,
  title: z.string().max(1000),
  capturedAt: z.iso.datetime(),
  driver: browserDriverMetadataSchema.optional(),
  bindingId: id,
  tabId: id,
  documentRevision: id,
  readiness: z.enum(['ready', 'partial', 'timed_out']),
  saved: z.boolean(),
  securityMode: z.enum(['trusted-cdp', 'trusted-managed', 'enforced']).optional(),
  captureTruncated: z.boolean(),
  representation: browserCaptureSchema.shape.representation,
  scope: z.string().max(200),
  exclusions: browserCaptureSchema.shape.exclusions,
  publishedAt: browserCaptureSchema.shape.publishedAt,
  outline: z.array(z.object({ blockId: id, title: z.string().max(160) })).max(16),
  links: z
    .array(z.object({ blockId: id, title: z.string().max(200), url: browserUrlSchema }))
    .max(20)
    .optional(),
  linksTruncated: z.boolean().optional(),
  duplicateSuppressed: z.boolean(),
  outputTruncated: z.boolean(),
  blocks: z
    .array(
      z.object({
        id,
        kind: browserBlockSchema.shape.kind,
        text: z.string().max(64_000),
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
      }),
    )
    .max(1000),
  receipt: z.array(browserRangeSchema).max(1000),
  continuation: z.object({ blockId: id, offset: z.number().int().nonnegative() }).nullable(),
  snapshot: browserInteractionSchema
    .omit({ targets: true })
    .extend({
      snapshotId: id,
      targets: z.array(browserTargetSchema.omit({ path: true })).max(100),
    })
    .optional(),
  image: browserImageSchema.optional(),
  readinessCondition: browserReadinessSchema.optional(),
  effect: z.enum(['none', 'applied', 'unknown']).optional(),
});
export type BrowserResult = z.infer<typeof browserResultSchema>;
export const browserErrorSchema = z.object({
  kind: z.literal('browser-error-v1'),
  code: z.enum([
    'INVALID_ARGUMENTS',
    'DISABLED',
    'INVALID_OUTPUT',
    'TRANSPORT_OVERFLOW',
    'DRIVER_FAILED',
    'PAGE_UNAVAILABLE',
    'ARTIFACT_UNAVAILABLE',
    'PERSIST_FAILED',
    'NOT_AUTHORIZED',
    'STALE_TARGET',
    'LIMIT_REACHED',
    'NOT_EXECUTED',
    'CANCELLED',
    'PRIVACY_DENIED',
  ]),
  operation: z.string().max(40),
  effect: z.enum(['none', 'applied', 'unknown']),
  message: z.string().max(500),
  recovery: z.enum(['focused_read', 'conclude', 'reobserve', 'navigate']).optional(),
});
export type BrowserError = z.infer<typeof browserErrorSchema>;

/** Session access and explicit deployment mode; skill content never grants access. */
export interface BrowserAccessPort {
  /** Revalidate authenticated ownership and destination at execution time. Denial throws.
   * `trusted-cdp` explicitly attaches to an owner-controlled Chrome with shared cookies
   * and no asserted network isolation. `enforced` additionally requires verified
   * browser-side egress/privacy controls and no alternate model control routes.
   * Recheck captured final URLs after driver execution.
   */
  authorize(
    sessionId: string,
    operation: BrowserArguments['operation'],
    url: string | undefined,
    signal?: AbortSignal,
  ): Promise<BrowserBinding>;
}
export interface BrowserBinding {
  bindingId: string;
  tabId: string;
  documentRevision: string;
  cliVersion: string;
  browserVersion: string;
  /** Administrator-owned named CLI session; never model supplied. */
  cliSession: string;
  cdpEndpoint?: string;
  securityMode?: 'trusted-cdp' | 'trusted-managed' | 'enforced';
  observedUrl?: string;
  driver?: z.infer<typeof browserDriverMetadataSchema>;
}
