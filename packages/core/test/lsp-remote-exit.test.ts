import { expect, it } from 'vitest';
import { LspConnection } from '../src/index.js';
import type { LongRunningProcess } from '@trinity-harness/contracts';

it('rejects pending LSP requests when a remote process exit cannot be confirmed', async () => {
  let rejectExit!: (error: Error) => void;
  const exited = new Promise<number | null>((_resolve, reject) => {
    rejectExit = reject;
  });
  const process: LongRunningProcess = {
    exited,
    write() {},
    kill() {},
    async *chunks() {
      yield* [];
    },
  };
  const connection = new LspConnection(process);
  const pending = connection.request('initialize', {});
  const rejected = expect(pending).rejects.toThrow('termination could not be confirmed');
  rejectExit(new Error('guest disconnected'));
  await rejected;
});
