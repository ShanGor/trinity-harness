import type { Identity, User, UserStore } from '@trinity-harness/contracts';

/** Directory truth for API fixtures; production never treats token roles as authority. */
export function usersForIdentity(
  principal: (() => Identity | undefined) | ((userId: string) => Identity | undefined),
): UserStore {
  const user = (id: string): User | null => {
    const identity = principal(id);
    return identity && identity.userId === id
      ? {
          id,
          tenantId: identity.tenantId,
          role: identity.role,
          email: `${id}@test.invalid`,
          createdAt: '2026-11-17T00:00:00.000Z',
        }
      : null;
  };
  return {
    findById: async (id) => user(id),
    findByEmail: async () => null,
    verifyCredentials: async () => null,
    createUser: async () => {
      throw new Error('Fixture does not provision users');
    },
    listByTenant: async () => [],
  };
}
