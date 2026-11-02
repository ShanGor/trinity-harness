import { z } from 'zod';

/** Per-request presentation only; never task scope, permissions or TTS preferences. */
export const promptDeliverySchema = z
  .object({
    mode: z.literal('phone'),
    depth: z.enum(['brief', 'detailed']),
  })
  .strict();
export type PromptDelivery = z.infer<typeof promptDeliverySchema>;
