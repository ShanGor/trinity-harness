/**
 * Manual smoke test: MiniMax-M3 reasoning round-trip through AiSdkGateway
 * against the MiniMax Anthropic-compatible endpoint.
 *
 * NOT part of `pnpm test` (requires real network + secrets). Run:
 *
 *   pnpm exec tsx packages/core/scripts/smoke-minimax.mjs
 *
 * Loads the repo-root `.env` when a variable is not already in the
 * environment (same idea as `node --env-file=.env`; tsx has no such flag).
 * Honors MODEL (default "anthropic/MiniMax-M3") and ANTHROPIC_BASE_URL.
 *
 * Verifies, against the live MiniMax-M3 API:
 *   1. `thinking: {type: 'adaptive'}` yields reasoning-delta chunks.
 *   2. Whether thinking blocks carry a provider signature (decides if the
 *      AI SDK will echo them back — see ai-sdk-gateway.ts).
 *   3. A second turn that echoes the full assistant message (reasoning
 *      included, as MiniMax requires) is accepted by the API.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AiSdkGateway } from '../src/index.ts';

// Load repo-root .env for variables not already set (never override).
const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
try {
  for (const line of readFileSync(join(rootDir, '.env'), 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    const [, name, value] = match;
    if (process.env[name] === undefined && value) {
      process.env[name] = value.replace(/^["']|["']$/g, '');
    }
  }
} catch {
  // No .env — environment variables must come from the caller.
}

const key = process.env['ANTHROPIC_API_KEY'];
const baseURL = process.env['ANTHROPIC_BASE_URL'] ?? 'https://api.minimax.cn/anthropic';
if (!key) {
  console.error('ANTHROPIC_API_KEY is not set — refusing to run (fail-closed).');
  process.exit(2);
}

const gateway = new AiSdkGateway(undefined, { thinkingType: 'adaptive' });
const model = process.env['MODEL'] ?? 'anthropic/MiniMax-M3';

/** Drive one turn and collect what came back. */
async function turn(messages) {
  const chunks = await gateway.stream({
    model,
    system: 'You are a precise calculator.',
    messages,
    tools: [],
  });
  let text = '';
  let reasoning = '';
  let signature;
  const kinds = new Set();
  for await (const chunk of chunks) {
    kinds.add(chunk.kind);
    if (chunk.kind === 'text-delta') text += chunk.text;
    if (chunk.kind === 'reasoning-delta') {
      reasoning += chunk.text;
      if (chunk.signature !== undefined) signature = chunk.signature;
    }
  }
  return { text, reasoning, signature, kinds };
}

const report = { baseURL, model };

// Turn 1: thinking on.
const t1 = await turn([{ role: 'user', content: 'What is 17 * 23? Think step by step.' }]);
report.turn1 = {
  gotReasoning: t1.reasoning.length > 0,
  reasoningChars: t1.reasoning.length,
  gotSignature: t1.signature !== undefined,
  answer: t1.text,
};

// Turn 2: echo the full assistant message back (MiniMax requirement).
const t2 = await turn([
  { role: 'user', content: 'What is 17 * 23? Think step by step.' },
  {
    role: 'assistant',
    content: t1.text,
    ...(t1.reasoning.length > 0
      ? {
          reasoning: [
            {
              text: t1.reasoning,
              ...(t1.signature !== undefined ? { signature: t1.signature } : {}),
            },
          ],
        }
      : {}),
  },
  { role: 'user', content: 'Now double that result.' },
]);
report.turn2 = {
  accepted: true,
  gotReasoning: t2.reasoning.length > 0,
  answer: t2.text,
};

console.log(JSON.stringify(report, null, 2));

const ok = report.turn1.gotReasoning && report.turn2.accepted;
console.log(
  ok
    ? '\nSMOKE TEST PASSED: reasoning streams and round-trips.'
    : '\nSMOKE TEST FAILED: see report above.',
);
process.exit(ok ? 0 : 1);
