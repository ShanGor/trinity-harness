export interface DatabaseProbe {
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
}
export function assertDisposableDatabase(
  target: DatabaseProbe,
  configured?: DatabaseProbe,
): Promise<void>;
