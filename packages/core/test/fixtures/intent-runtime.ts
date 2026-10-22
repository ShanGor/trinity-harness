import { randomUUID } from 'node:crypto';
import type {
  BlobMeta,
  BlobStore,
  BrowserAccessPort,
  BrowserDriverPort,
  ConversationIndexPort,
  MemoryStorePort,
  SessionMeta,
  SessionMetaStore,
  TopicEpisode,
} from '@trinity-harness/contracts';
import { browserCaptureSchema } from '@trinity-harness/contracts';
import {
  CoreToolRegistry,
  MemorySessionStore,
  PersonalContext,
  createBrowserTool,
  createRecallTool,
  createTaskTool,
  editFileTool,
  readFileTool,
  writeFileTool,
} from '../../src/index.js';
import { FakeSandbox } from '../../src/testing/fake-sandbox.js';

const at = '2026-10-22T00:00:00.000Z';
const eventMeta = () => ({ eventId: randomUUID(), at });

export class IntentFixtureBlobs implements BlobStore {
  readonly entries = new Map<string, { data: Uint8Array; meta: BlobMeta }>();
  async put(
    key: string | undefined,
    data: Uint8Array,
    options: { mimeType: string },
  ): Promise<BlobMeta> {
    const actual = key ?? randomUUID();
    const meta = {
      key: actual,
      uri: `blob://${actual}`,
      mimeType: options.mimeType,
      size: data.byteLength,
    };
    this.entries.set(meta.uri, { data: data.slice(), meta });
    return meta;
  }
  async get(uri: string): Promise<Uint8Array | null> {
    return this.entries.get(uri)?.data ?? null;
  }
  async getMeta(uri: string): Promise<BlobMeta | null> {
    return this.entries.get(uri)?.meta ?? null;
  }
  async delete(uri: string): Promise<void> {
    this.entries.delete(uri);
  }
}

export async function intentRuntime(task: {
  files: Readonly<Record<string, string>>;
  localHistory?: readonly { request: string; answer: string }[];
  otherHistory?: readonly { request: string; answer: string }[];
  pages?: Readonly<Record<string, string>>;
}): Promise<{
  store: MemorySessionStore;
  sandbox: FakeSandbox;
  tools: CoreToolRegistry;
  blobs: IntentFixtureBlobs;
  owner: SessionMeta;
  metas: SessionMetaStore;
  personalContext: PersonalContext;
}> {
  const store = new MemorySessionStore();
  const sandbox = new FakeSandbox();
  for (const [name, content] of Object.entries(task.files)) sandbox.files.set(name, content);
  const blobs = new IntentFixtureBlobs();
  const owner: SessionMeta = {
    id: randomUUID(),
    userId: randomUUID(),
    tenantId: randomUUID(),
    title: 'Synthetic task',
    scope: 'personal',
    kind: 'chat',
    sessionRole: 'side',
    workspaceUri: '/fixture',
    createdAt: at,
  };
  const metas = new Map([[owner.id, owner]]);
  const episodes = new Map<string, TopicEpisode>();
  const memory: MemoryStorePort = {
    snapshot: async () => ({ revision: 0, items: [], hasSuppression: false }),
    change: async () => {
      throw new Error('Memory writes are unavailable in this fixture.');
    },
  };
  const index: ConversationIndexPort = {
    evidence: async (_identity, id) => episodes.get(id) ?? null,
    history: async (_identity, query) => ({
      episodes: [...episodes.values()]
        .reverse()
        .filter(
          (episode) =>
            !query.query ||
            `${episode.request} ${episode.outcome}`
              .toLowerCase()
              .includes(query.query.toLowerCase()),
        )
        .slice(0, query.limit),
      nextBefore: null,
    }),
    revise: async () => {
      throw new Error('History changes are unavailable in this fixture.');
    },
  };
  const metaStore = { get: async (id: string) => metas.get(id) ?? null } as SessionMetaStore;
  const start = async (id: string) =>
    store.append(id, [
      { ...eventMeta(), type: 'session/created', kind: 'chat', workspaceUri: '/fixture' },
    ]);
  await start(owner.id);
  for (const [local, history] of [
    [true, task.localHistory ?? []],
    [false, task.otherHistory ?? []],
  ] as const) {
    const sessionId = local ? owner.id : randomUUID();
    if (!local) {
      metas.set(sessionId, { ...owner, id: sessionId });
      await start(sessionId);
    }
    for (const exchange of history) {
      const fromSeq = (await store.load(sessionId)).length + 1;
      const promptId = randomUUID();
      await store.append(sessionId, [
        {
          eventId: promptId,
          at,
          type: 'message/user',
          surfaceOp: 'append',
          content: [{ kind: 'text', text: exchange.request }],
        },
        {
          ...eventMeta(),
          type: 'message/assistant',
          phase: 'final',
          surfaceOp: 'append',
          content: [{ kind: 'text', text: exchange.answer }],
        },
        { ...eventMeta(), type: 'turn/end', promptId, reason: 'completed' },
      ]);
      episodes.set(promptId, {
        episodeId: promptId,
        promptId,
        sessionId,
        fromSeq,
        answerSeq: fromSeq + 1,
        toSeq: fromSeq + 2,
        at,
        request: exchange.request,
        outcome: exchange.answer,
        topic: exchange.request,
        excluded: false,
        policyRevision: 0,
      });
    }
  }
  const tools = new CoreToolRegistry(sandbox);
  for (const tool of [
    readFileTool,
    writeFileTool,
    editFileTool,
    createTaskTool(store),
    createRecallTool({ memory, index, metas: metaStore, store }),
  ])
    tools.register(tool);
  if (task.pages) {
    let currentUrl = Object.keys(task.pages)[0]!;
    let revision = 0;
    const pages = task.pages;
    const access: BrowserAccessPort = {
      authorize: async (sessionId, _operation, url, signal) => {
        signal?.throwIfAborted();
        if (sessionId !== owner.id || (url && !Object.hasOwn(pages, url)))
          throw new Error('Source unavailable in this isolated fixture.');
        return {
          bindingId: 'fixture',
          tabId: 'fixture-tab',
          documentRevision: `revision-${revision}`,
          cliVersion: 'fixture',
          browserVersion: 'fixture',
          cliSession: 'fixture',
          securityMode: 'trusted-cdp',
        };
      },
    };
    const unsupported = async (): Promise<never> => {
      throw new Error('Operation unsupported by fixture.');
    };
    const driver: BrowserDriverPort = {
      verify: async (_binding, ctx) => ctx.signal?.throwIfAborted(),
      navigate: async (_binding, url, ctx) => {
        ctx.signal?.throwIfAborted();
        if (!Object.hasOwn(pages, url)) throw new Error('Unknown fixture URL');
        currentUrl = url;
        revision += 1;
      },
      capture: async (_binding, _mode, _scope, ctx) => {
        ctx.signal?.throwIfAborted();
        return browserCaptureSchema.parse({
          schemaVersion: 1,
          extractorVersion: 'semantic-v1',
          url: currentUrl,
          title: 'Synthetic source',
          publishedAt: null,
          readiness: 'ready',
          representation: 'article',
          scope: 'article',
          exclusions: [],
          captureTruncated: false,
          blocks: [
            { id: 'b0', kind: 'paragraph', sectionId: null, text: pages[currentUrl], links: [] },
          ],
        });
      },
      surface: async () => ({
        context: {
          width: 800,
          height: 600,
          scrollX: 0,
          scrollY: 0,
          devicePixelRatio: 1,
          locale: 'en-US',
          timezone: 'UTC',
        },
        targets: [],
        truncated: false,
        privacyDenied: false,
      }),
      act: unsupported,
      pointAllowed: unsupported,
      readiness: unsupported,
      accessibility: async () => pages[currentUrl] ?? '',
      paint: unsupported,
      screenshot: unsupported,
    };
    tools.register(createBrowserTool({ store, blobs, access, driver, now: () => new Date(at) }));
  }
  return {
    store,
    sandbox,
    tools,
    blobs,
    owner,
    metas: metaStore,
    personalContext: new PersonalContext(memory, index, store),
  };
}
