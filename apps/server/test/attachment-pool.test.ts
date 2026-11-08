import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDb,
  PgAttachmentCatalog,
  PgSessionMetaStore,
  PgSessionStore,
} from '@trinity-harness/db';
import { LocalBlobStore } from '@trinity-harness/core';
import type { Identity, UserStore } from '@trinity-harness/contracts';
import { buildServer } from '../src/server.js';

const url = process.env['DATABASE_URL'];
const admin = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 2000 });
let reachable = false;
if (url) {
  try {
    await admin.query('select 1');
    reachable = true;
  } catch {
    reachable = false;
  }
}
const schema = `attachment_test_${randomUUID().replaceAll('-', '')}`;
const pool = new pg.Pool({
  connectionString: url,
  options: `-c search_path=${schema},public`,
  connectionTimeoutMillis: 2000,
});
const locks = new pg.Pool({
  connectionString: url,
  options: `-c search_path=${schema},public`,
  connectionTimeoutMillis: 2000,
});
let initialized = false;
let root: string;
beforeAll(async () => {
  if (!reachable) return;
  await admin.query(`create schema ${schema}`);
  initialized = true;
  for (const table of [
    'attachment_contents',
    'attachment_ingestions',
    'sessions',
    'session_events',
    'users',
  ])
    await admin.query(`create table ${schema}.${table} (like public.${table} including all)`);
  root = await mkdtemp(path.join(tmpdir(), 'trinity-attachment-api-'));
});
afterAll(async () => {
  await pool.end();
  await locks.end();
  if (initialized) await admin.query(`drop schema ${schema} cascade`);
  await admin.end();
  if (root) await rm(root, { recursive: true, force: true });
});
describe.skipIf(!reachable)(
  'global attachment pool with authenticated PostgreSQL references',
  () => {
    it('deduplicates concurrent cross-tenant uploads, fences reads/prompts and survives server recreation', async () => {
      const identities: Record<string, Identity> = Object.fromEntries(
        ['a', 'b'].map((key) => [
          key,
          { tenantId: randomUUID(), userId: randomUUID(), role: 'developer' as const },
        ]),
      );
      identities.viewer = { ...identities.a!, role: 'viewer' };
      const db = createDb(pool);
      const store = new PgSessionStore(db);
      const metas = new PgSessionMetaStore(db);
      const blobs = new LocalBlobStore(path.join(root, 'blobs'));
      const build = () =>
        buildServer({
          workspaceRoot: root,
          store,
          blobs,
          attachmentCatalog: new PgAttachmentCatalog(db, locks),
          auth: {
            metas,
            tokens: {
              verify: async (token) => identities[token] ?? null,
              issue: async () => 'unused',
            },
            hasher: { hash: async () => '', verify: async () => false },
            users: {} as UserStore,
          },
        });
      let app = await build();
      const headers = (key: string) => ({ authorization: `Bearer ${key}` });
      try {
        const sessions: string[] = [];
        for (const key of ['a', 'b']) {
          const response = await app.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: headers(key),
            payload: { kind: 'chat' },
          });
          expect(response.statusCode).toBe(201);
          sessions.push(response.json<{ sessionId: string }>().sessionId);
        }
        const viewer = await app.inject({
          method: 'POST',
          url: '/acp',
          headers: headers('viewer'),
          payload: {
            jsonrpc: '2.0',
            id: 'viewer',
            method: 'session/prompt',
            params: {
              sessionId: sessions[0],
              prompt: [
                {
                  type: 'file',
                  resource: {
                    data: Buffer.from('private').toString('base64'),
                    mimeType: 'text/plain',
                  },
                },
              ],
            },
          },
        });
        expect(viewer.json().error?.code).toBe(-32603);
        expect(
          Number((await pool.query('select count(*) from attachment_ingestions')).rows[0].count),
        ).toBe(0);
        const operation = randomUUID();
        const body = '  unchanged 你好\r\n';
        const upload = (index: number, filename = 'paste.txt') =>
          app.inject({
            method: 'POST',
            url: `/api/sessions/${sessions[index]}/attachments?mime=text/plain&origin=paste&filename=${filename}&operationId=${operation}`,
            headers: { ...headers(index ? 'b' : 'a'), 'content-type': 'application/octet-stream' },
            payload: Buffer.from(body),
          });
        const responses = await Promise.all([upload(0), upload(0), upload(1, 'other.txt')]);
        expect(responses.map((r) => r.statusCode)).toEqual([201, 201, 201]);
        const first = responses[0]!.json<{ uri: string }>();
        const second = responses[2]!.json<{ uri: string }>();
        expect(responses[1]!.json().uri).toBe(first.uri);
        expect(second.uri).not.toBe(first.uri);
        expect(await readdir(path.join(root, 'blobs', 'attachment-pool'))).toHaveLength(1);
        expect(
          Number((await pool.query('select count(*) from attachment_contents')).rows[0].count),
        ).toBe(1);
        const download = `/api/blobs/${first.uri.slice(7)}`;
        expect((await app.inject({ url: download, headers: headers('b') })).statusCode).toBe(404);
        expect((await app.inject({ url: download, headers: headers('a') })).body).toBe(body);
        const invalid = await app.inject({
          method: 'POST',
          url: `/api/sessions/${sessions[1]}/messages`,
          headers: headers('b'),
          payload: { text: 'read this', attachments: [{ uri: first.uri, mimeType: 'text/plain' }] },
        });
        expect(invalid.statusCode).toBe(400);
        const acpInvalid = await app.inject({
          method: 'POST',
          url: '/acp',
          headers: headers('b'),
          payload: {
            jsonrpc: '2.0',
            id: 'invalid',
            method: 'session/prompt',
            params: {
              sessionId: sessions[1],
              prompt: [
                { type: 'text', text: 'read this' },
                { type: 'file', uri: first.uri, mimeType: 'text/plain' },
              ],
            },
          },
        });
        expect(acpInvalid.json().error?.code).toBe(-32602);

        const poolKey = (await readdir(path.join(root, 'blobs', 'attachment-pool')))[0]!;
        expect(
          (
            await app.inject({
              url: `/api/blobs/attachment-pool/${poolKey}`,
              headers: headers('a'),
            })
          ).statusCode,
        ).toBe(404);
        await app.close();
        app = await build();
        expect((await upload(0)).json().uri).toBe(first.uri);
        expect((await app.inject({ url: download, headers: headers('a') })).body).toBe(body);
      } finally {
        await app.close();
      }
    });
  },
);
