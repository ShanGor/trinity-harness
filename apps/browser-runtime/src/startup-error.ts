import { z } from 'zod';

export type StartupPhase = 'configuration' | 'deployment' | 'executable' | 'database' | 'listen';

/** Startup errors can contain database credentials, proxy URLs and filesystem paths. */
export function formatStartupError(error: unknown, phase: StartupPhase): string {
  const prefix = `Browser runtime startup failed (${phase})`;
  if (error instanceof z.ZodError) {
    const fields = [...new Set(error.issues.map((issue) => String(issue.path[0])))].filter(
      (field) => /^[A-Z][A-Z0-9_]{0,63}$/.test(field),
    );
    return `${prefix}: invalid configuration${fields.length ? `: ${fields.slice(0, 16).join(', ')}` : ''}. Check the environment and .env files.`;
  }
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  switch (code) {
    case 'EADDRINUSE':
      return `${prefix}: EADDRINUSE. BROWSER_RUNTIME_PORT is already in use. Reuse the running runtime, stop it before restarting, or configure a free port and matching BROWSER_RUNTIME_ENDPOINT in server/worker.`;
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
    case 'ENOTFOUND':
      return `${prefix}: ${code}. Check the configured service address and availability.`;
    case '28P01':
      return `${prefix}: PostgreSQL authentication failed. Check DATABASE_URL credentials.`;
    case 'ENOENT':
    case 'EACCES':
      return `${prefix}: ${code}. Check the configured executable, workspace and storage permissions.`;
    default:
      return `${prefix}. Check ${
        {
          configuration: 'the environment and .env files',
          deployment:
            'FIRECRACKER_NODES, NODE_RUNTIME_TOKEN and the execution driver configuration',
          executable: 'ZENDRIVER_BINARY and the pinned Zendriver version',
          database: 'PostgreSQL availability, DATABASE_URL and applied migrations',
          listen: 'BROWSER_RUNTIME_HOST and BROWSER_RUNTIME_PORT',
        }[phase]
      }.`;
  }
}
