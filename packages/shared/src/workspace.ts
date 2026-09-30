import { z } from 'zod';

/** Workspace choice sent when creating a session. */
export const workspaceSelectionSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('personal'), path: z.string().max(500).optional() }).strict(),
  z.object({ scope: z.literal('team'), teamId: z.uuid() }).strict(),
]);
export type WorkspaceSelection = z.infer<typeof workspaceSelectionSchema>;

export const personalFoldersQuerySchema = z.object({ path: z.string().max(500).optional() });
export const personalFoldersResponseSchema = z.object({ folders: z.array(z.string()) });
