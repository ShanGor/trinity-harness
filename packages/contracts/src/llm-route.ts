import { z } from 'zod';
const id = z.uuid();
export const llmRouteReceiptSchema = z.object({
  profileName: z.string().max(100).optional(),
  deploymentName: z.string().max(100).optional(),
  revision: z.number().int().positive(),
  profileId: id.optional(),
  selection: z.enum(['default', 'model']).optional(),
  automaticFallback: z.boolean().optional(),
  connectionId: id,
  deploymentId: id,
  credentialVersionId: id,
  modelId: z.string().max(256),
  pricingKey: z.string().max(200),
  reason: z.enum(['primary', 'pin', 'fallback']),
  maxOutputTokens: z.number().int().positive(),
  reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  reasoningBudgetTokens: z.number().int().positive().optional(),
});
export type LlmRouteReceipt = z.infer<typeof llmRouteReceiptSchema>;
