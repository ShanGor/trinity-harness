import { z } from 'zod';

export const nodeAgentEnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    NODE_RUNTIME_TOKEN: z.string().min(32),
    NODE_ID: z.string().regex(/^[a-z0-9-]{1,63}$/),
    NODE_STATE_DIR: z.literal('/srv/trinity-node'),
    NODE_DEPLOYMENT_MODE: z.enum(['production', 'development']),
    NODE_STORAGE_ENCRYPTION: z.enum(['host-managed', 'provider-managed', 'none']),
    WORKSPACE_ROOT: z
      .string()
      .refine((value) => value.startsWith('/'))
      .default('/workspace'),
    NODE_GUEST_ROUTING: z.enum(['true', 'false']).default('false'),
    NODE_PORT: z.coerce.number().int().min(1).max(65535).default(3030),
  })
  .superRefine((env, context) => {
    if (env.NODE_STORAGE_ENCRYPTION === 'none' && env.NODE_DEPLOYMENT_MODE !== 'development') {
      context.addIssue({
        code: 'custom',
        path: ['NODE_STORAGE_ENCRYPTION'],
        message: 'Unencrypted storage is allowed only in explicit development mode',
      });
    }
  });

export type NodeAgentEnv = z.infer<typeof nodeAgentEnvSchema>;

export function parseNodeAgentEnv(input: NodeJS.ProcessEnv): NodeAgentEnv {
  return nodeAgentEnvSchema.parse(input);
}
