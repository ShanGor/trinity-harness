import { z } from 'zod';

/** Ephemeral user-facing pixels, never model evidence or an input capability. */
export const browserPreviewSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('frame'),
      generation: z.uuid(),
      capturedAt: z.iso.datetime(),
      securityMode: z.enum(['trusted-cdp', 'trusted-managed']),
      width: z.number().int().positive().max(2048),
      height: z.number().int().positive().max(2048),
      png: z
        .string()
        .min(1)
        .max(2_796_204)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    })
    .strict(),
  z
    .object({
      state: z.enum(['unavailable', 'runtime_unavailable', 'busy', 'privacy_blocked']),
    })
    .strict(),
]);
export type BrowserPreview = z.infer<typeof browserPreviewSchema>;

export const browserPreviewRequestSchema = z.object({ sessionId: z.uuid() }).strict();
export interface BrowserPreviewPort {
  /** Never allocates a browser; missing or unverified live bindings fail closed. */
  preview(sessionId: string, signal?: AbortSignal): Promise<BrowserPreview>;
}
