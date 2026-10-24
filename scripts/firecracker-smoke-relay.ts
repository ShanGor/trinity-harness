import { randomUUID } from 'node:crypto';
import { FirecrackerGuestRelay } from '../apps/node-agent/src/guest-relay.js';

const [stateRoot, id, generation, tenantId, userId, sessionId] = process.argv.slice(2);
if (![stateRoot, id, generation, tenantId, userId, sessionId].every(Boolean))
  throw new Error('Smoke relay requires state root and five UUID arguments');

const result = await new FirecrackerGuestRelay(stateRoot!).call(
  {
    id: id!,
    generation: generation!,
    tenantId: tenantId!,
    userId: userId!,
    nodeId: 'smoke-test',
    state: 'running',
    vcpus: 1,
    memoryMiB: 512,
  },
  {
    requestId: randomUUID(),
    environmentId: id!,
    generation: generation!,
    sessionId: sessionId!,
    workspace: 'smoke-test',
    operation: { kind: 'skillsList' },
  },
  AbortSignal.timeout(15_000),
);

if (result.kind !== 'ok') throw new Error(`Unexpected smoke response: ${result.kind}`);
console.log('Host FirecrackerGuestRelay received a valid guest RPC response.');
