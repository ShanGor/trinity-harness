/**
 * Workspace path patterns that require a human approval before a file read.
 * Keep this list narrow and update the policy tests when adding a pattern.
 */
export const SENSITIVE_FILE_PATTERNS = [
  '**/.env',
  '**/.env.*',
  '**/.envrc',
  '**/.npmrc',
  '**/.pypirc',
  '**/.netrc',
  '**/.git-credentials',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/id_ecdsa*',
  '**/id_dsa*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.jks',
  '**/*.keystore',
  '**/credentials',
  '**/credentials.json',
  '**/credentials.yaml',
  '**/credentials.yml',
  '**/credentials.toml',
  '**/credentials.ini',
  '**/secrets',
  '**/secrets.json',
  '**/secrets.yaml',
  '**/secrets.yml',
  '**/secrets.toml',
  '**/secrets.ini',
  '**/.aws/credentials',
  '**/.azure/accessTokens.json',
  '**/.kube/config',
  '**/.docker/config.json',
  '**/service-account.json',
  '**/service-account-credentials.json',
] as const;

const SAFE_ENV_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template']);
const SENSITIVE_SUFFIX_PATTERNS = SENSITIVE_FILE_PATTERNS.map((pattern) =>
  pattern.slice(3).toLowerCase(),
);
const SENSITIVE_GLOB_MARKERS = [
  '.env',
  '.envrc',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  'credential',
  'secret',
  'service-account',
];

/** Match a workspace-relative or absolute path against the maintained list. */
export function isSensitiveFilePath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/').replace(/\/+/g, '/').toLowerCase();
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (SAFE_ENV_EXAMPLES.has(basename)) return false;

  return SENSITIVE_SUFFIX_PATTERNS.some((pattern) => {
    if (pattern.includes('*')) {
      const [prefix, suffix] = pattern.split('*', 2);
      return basename.startsWith(prefix!) && basename.endsWith(suffix!);
    }
    return basename === pattern || normalized === pattern || normalized.endsWith(`/${pattern}`);
  });
}

/** Detect literal sensitive path tokens in a Bash command before auto-allow. */
export function bashReferencesSensitiveFile(command: string | undefined): boolean {
  if (!command) return false;
  const tokens = command.match(/[^\s"'`(){}|<>;=]+/g) ?? [];
  return tokens.some((token) => {
    if (isSensitiveFilePath(token)) return true;
    const basename = token.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
    if (basename.endsWith('.env.example')) return false;
    return (
      ['*', '?', '[', ']'].some((character) => token.includes(character)) &&
      SENSITIVE_GLOB_MARKERS.some((marker) => token.toLowerCase().includes(marker))
    );
  });
}
