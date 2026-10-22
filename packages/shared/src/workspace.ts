import { z } from 'zod';

/** Workspace choice sent when creating a session. */
export const workspaceSelectionSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('personal'), path: z.string().max(500).optional() }).strict(),
  z.object({ scope: z.literal('team'), teamId: z.uuid() }).strict(),
]);
export type WorkspaceSelection = z.infer<typeof workspaceSelectionSchema>;

export const personalFoldersQuerySchema = z.object({ path: z.string().max(500).optional() });
export const personalFoldersResponseSchema = z.object({ folders: z.array(z.string()) });

/** Browser recovery descriptor; contains configuration only, never uploaded data. */
export const pendingCreationSchema = z
  .object({
    operationId: z.uuid(),
    kind: z.enum(['chat', 'work']),
    policy: z.string().min(1).max(4000),
    workspace: workspaceSelectionSchema.optional(),
    title: z.string().max(200).optional(),
  })
  .strict();
