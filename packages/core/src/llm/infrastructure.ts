import { z } from 'zod';
import type { LlmCredentialPort } from '@trinity-harness/contracts';
import { LlmConfigurationError } from '@trinity-harness/contracts';
import { EncryptedLlmCredentials } from './credentials.js';
export const llmInfrastructureEnvShape = {
  LLM_CREDENTIAL_KEY_ID: z.string().min(1).max(100).optional(),
  LLM_CREDENTIAL_KEYS: z.string().max(16384).optional(),
  LLM_PROVIDER_DESTINATIONS: z
    .string()
    .max(16384)
    .default(
      '[{"origin":"https://api.openai.com"},{"origin":"https://api.anthropic.com"},{"origin":"https://api.kimi.com"}]',
    )
    .transform((value) =>
      z
        .array(
          z
            .object({ origin: z.string().url().max(2048), allowPrivate: z.boolean().optional() })
            .strict(),
        )
        .max(64)
        .parse(JSON.parse(value)),
    ),
};
export function infrastructureCredentials(keyId?: string, keys?: string): LlmCredentialPort {
  if (keyId && keys) {
    try {
      return new EncryptedLlmCredentials(
        keyId,
        z.record(z.string(), z.string()).parse(JSON.parse(keys)),
      );
    } catch {
      throw new Error('Invalid LLM credential encryption configuration');
    }
  }
  if (keyId || keys) throw new Error('Configure both LLM credential key ID and key ring');
  const unavailable = async (): Promise<never> => {
    throw new LlmConfigurationError(
      'UNAVAILABLE',
      'Operator must configure credential encryption before managing providers',
    );
  };
  return { seal: unavailable, open: unavailable };
}
