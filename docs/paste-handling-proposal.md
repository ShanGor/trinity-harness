# Large Paste Handling Proposal

Status: **Implementation added; deployment acceptance pending**

Review updated: 2026-11-07. Global deduplication of immutable original attachment bytes is a requirement. Session-owned attachment references and independent writable workspace copies preserve access and editing boundaries. This supersedes the earlier session-only storage recommendation; the sections describing prior Harness behavior are the pre-change baseline.

## Goal

Keep large pasted source text out of the ordinary chat prompt while preserving the user's short instruction, the full pasted content, and an understandable attachment in conversation history.

## Reference behavior in `/home/sam/sources/trinity`

The reference separates composer handling from server-side handling:

- In `frontend/src/draftUploads.ts`, the composer estimates tokens as `ceil(characters / 4)`. It detects a large draft at about 8,000 estimated tokens, or when a recognized instruction plus a payload of at least 1,200 characters is present. The payload is separated from the instruction and named `pasted-text.txt`.
- Instruction/payload separation recognizes `Task:`, `Question:`, and `Instruction:` (plus Chinese equivalents), fenced code, and a payload-heavy section after a blank line. For the blank-line heuristic, payload must be at least three times the instruction length and at least 1,200 characters or 400 estimated tokens.
- On submission, the frontend uploads the paste as a text artifact and sends a reference with the turn, rather than sending the full paste inline. It keeps a short preview and size/token metadata for the message UI.
- The backend also applies a large-input guard. The default whole-input threshold is 8,000 tokens; smaller inputs can be split when a clear, payload-heavy instruction/payload structure meets its configured thresholds. It persists reusable text and artifact references and can process the text in chunks for retrieval or full-document work.

These are reference defaults, not proposed fixed limits for Trinity Harness. The reference has both client detection and backend recognition because requests can arrive through more than one path.

## Proposed Harness behavior

1. Detect oversized pasted text at the composer boundary using a documented, configurable threshold. Start with an 8,000-token estimate as a review baseline, not a final commitment.
2. When the threshold is exceeded, preserve a concise instruction in the user message and represent the pasted body as a text attachment/artifact. Keep the complete body out of the normal inline message text.
3. For a structured draft below the whole-input threshold, consider a conservative payload-heavy heuristic: only split when a recognizable instruction is present and the body is materially larger. Do not infer an instruction by stripping arbitrary leading text.
4. Show the attachment name, size, and a bounded preview in the draft and submitted message. Let the user inspect/remove it before sending, using existing attachment UX where possible.
5. Upload content before submitting the turn, then send a validated attachment reference. Preserve normal upload progress, cancellation, retry behavior, and message history semantics.
6. The backend must validate ownership, tenant/session scope, content type, byte limits, and reference existence. It must support the same behavior for non-browser clients; composer detection alone is insufficient.
7. Keep the attachment available as replayable user input. Any later model context should resolve it through existing attachment/document tools or an explicit bounded context policy, rather than silently truncating the source.
8. Treat pasted content as user-provided data, not instructions that can override system or developer policy. Keep full content out of logs and ordinary event metadata; store only bounded previews and safe metadata where appropriate.

## How Harness attachments and workspace files work today

The ordinary web submission path stages files locally, ensures the session exists, uploads each file, then submits a prompt containing the returned blob references. Uploading and submitting a prompt are separate operations.

`POST /api/sessions/:sessionId/attachments` in `apps/server/src/server.ts` currently:

1. Authorizes session access, rejects viewer uploads, and validates MIME and size. Its allowlist is PNG/JPEG/WebP/GIF/PDF, with a 20 MiB ceiling. **Text paste uploads are not currently supported by this endpoint.**
2. Saves the original bytes with `BlobStore.put(undefined, ...)`. The current `LocalBlobStore` generates a fresh key; it does not hash or deduplicate the content.
3. Resolves the session workspace and saves a separate writable copy at `uploads/<uuid>-<sanitized-filename>` using `saveWorkspaceAttachment`.
4. Uses `SandboxPort.writeBytes` when a workspace sandbox is configured, so guest uploads enter the routed guest workspace. The local path writes under the authorized workspace root. This must remain the route for paste materialization too.
5. Appends `session/attachment` with `{ uri, workspacePath, mimeType, size }`, then returns those fields to the caller.

Chat uses its durable automatic workspace, currently `$WORKSPACE_ROOT/sessions/<user_id>/<session_uuid>`. Work uses its bound selected workspace. The binding is obtained from authenticated metadata; the upload must not accept a workspace root from the browser. Legacy Chat binding is recorded once through `session/workspace_bound`.

The client currently types the upload response as `{ uri, mimeType, size }`; it does not expose `workspacePath` in that return type. The server/model path gets the path from the durable attachment event instead. For a matching image/file URI in `message/user`, `packages/core/src/loop/to-model-messages.ts` adds `[Attachment workspace file: uploads/...]`. It does not load the workspace file's contents merely to expose its path. Existing image/PDF ingestion remains a separate model-input mechanism.

Ordinary workspace files are accessed through Sandbox tools such as `read_file`, `write_file`, `edit_file`, and `glob`, under existing policy and approval checks. They are writable working files, not immutable uploaded originals. Editing the workspace copy does not update the original blob. Files created by tools are not automatically upload attachments, and uploading a file does not imply that its full contents have been read by the model.

The ACP inline-resource path is different: `acpBlocksToContent` stores base64 resources in BlobStore but does not itself create a workspace copy or append `session/attachment`. Paste support must deliberately route through common attachment ingestion rather than assume every existing file-resource path materializes a file.

Today each ordinary upload creates a new blob and a new workspace filename, even for identical bytes. The route performs blob write, workspace write, and event append sequentially; these are not one atomic transaction. A failure can leave an unreferenced blob or file. This is an existing recovery concern to address for retryable paste ingestion, not evidence that upload deduplication already exists.

Current access limitation: `GET /api/blobs/*` resolves ordinary keys without a session-attachment ownership lookup. `createReadBlobTool` also reads ordinary blob URIs without performing such a lookup itself. The BlobStore port has no caller/session authorization parameters. Existing special handling protects browser evidence and private model-context namespaces, but those checks do not establish general attachment ownership. Global pooling must include scoped attachment resolution across downloads, prompt acceptance, model resolution, tools, and previews; changing only storage keys would be incomplete.

## How Trinity materializes and deduplicates pastes

There are three distinct identities in the reference:

| Layer                   | Identity and reuse                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw artifact pool       | SHA-256 of original bytes plus byte length. Pooled storage is under a hash-derived filename.                                                                                                            |
| Conversation attachment | Tenant + conversation + artifact kind + raw hash + byte length. Repeated identical uploads in the same conversation return the existing artifact without another transfer or workspace materialization. |
| Processable text pool   | Decoded text identity, including a trimmed-text hash and trimmed length. Whitespace variants can reuse a processing record even when their original raw artifacts differ.                               |

`ArtifactService.init_upload` checks conversation reuse first, then pooled storage reuse, before requesting upload chunks. A pool hit in another conversation still creates that conversation's own attachment and workspace projection. Actual completed transfers verify the assembled SHA-256 against the declared digest.

Uploaded textual artifacts are decoded and written as UTF-8 workspace files with projection metadata recording raw and normalized identities. They are indexed for workspace text search. The older inline-paste fallback in `ensure_inline_pasted_text_artifact` uses `pasted_text_<artifact-id>.txt` and a pooled-file materializer that attempts a hard link, with copy fallback. These paths differ; the proposed Harness design should not assume that every Trinity paste follows one identical materialization path.

The reference's pool lookups are keyed globally by hash/length; conversation records provide access scoping. Harness should adopt global reuse of immutable originals, with its own authorization boundary around attachment references. Pool existence and mutable workspace files must not become globally accessible. A hash is a content identifier, never an access credential.

Reference locations: `frontend/src/App.tsx` (paste upload), `backend/src/service/artifact_service.rs` (`init_upload`, `create_conversation_artifact_from_pool`, `upsert_text_pool_from_file`, `materialize_workspace_projection`), and `backend/src/service/turn_service/documents.rs` (`ensure_inline_pasted_text_artifact`).

## Recommended Harness design for review

Reuse the existing attachment ingestion and `uploads/` directory. Add explicit UTF-8 text-paste support and a file/reference representation that is not treated as an image: today `promptContent` classifies every non-PDF attachment as an image, so merely adding `text/plain` to the MIME allowlist is insufficient.

Recommended sequence:

1. Stage the full clipboard text locally as `pasted-text.txt`, preserving its exact characters and whitespace. Keep surrounding typed instruction and cursor placement intact. Prefer the actual paste boundary over guessing instruction/body boundaries from the whole draft. Offer preview and removal; do not upload merely because the user pasted.
2. On Send, encode once as UTF-8 and upload using authenticated session ingestion. Compute SHA-256 and byte length on the server from received bytes. A browser digest can be an optimization hint, not trusted proof of content.
3. Resolve or create the global immutable content object for the verified bytes, create/reuse a session-owned attachment reference, and materialize a separate writable copy through the configured Sandbox at `uploads/<generated-id>-pasted-text.txt`. Never hard-link a writable working file to the retained original.
4. Append the attachment receipt only after successful storage and materialization. Submit the user's instruction with a validated reference to that receipt. Project a bounded description and workspace-relative path for the model; use existing bounded file tools to inspect the paste. Retain the original reference for replay even if the working file is later edited or deleted.
5. For a paste-only prompt, preserve its status as committed user input; moving text into a file must not silently remove user requirements from intent, planning, continuation, or child-request provenance. Resolve this through the existing intent/context contracts before implementation. Do not summarize the paste into a substitute instruction. A paste-only submission may legitimately require the assistant to read it before deciding whether clarification is needed.

## Global deduplication and ownership

Deduplicate **exact original bytes globally across sessions, users, and tenants sharing the service's content store**. The pool key is `(SHA-256, byte length)`; MIME, filename, originating session, and paste/file origin are attachment metadata and must not split identical physical content. A pasted text body and an uploaded `.txt` file containing the same bytes can share the original. Preserve whitespace and line endings; semantic or trimmed-text equivalence does not establish raw identity.

Use three separate records/concepts:

| Layer                        | Proposed identity and responsibility                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Global content object        | Unique verified digest + byte length; private storage key, readiness state, immutable bytes. No user filename or authoritative per-upload MIME.                                                                                |
| Session attachment reference | Opaque attachment ID, tenant/session ownership, content-object ID, validated MIME, original name, origin, and durable receipt. Authorizes use in that session. Multiple authorized references may point to one content object. |
| Workspace materialization    | Attachment ID, bound workspace/generation where applicable, relative path, original digest, and ingestion identity. Tracks an independent writable copy; its current bytes may differ from the original.                       |

Conceptual persisted DTOs should follow these fields; concrete Zod schemas, table names, ports, and migrations remain part of the implementation design review. Keep these responsibilities within the existing Multimodal/BlobStore and session boundaries, assembled in apps; do not introduce a separate plugin or bypass module ports. PostgreSQL supplies durable uniqueness and ingestion coordination; the object store holds bytes and the configured Sandbox writes workspace files.

Keep pooled object keys private. A client-facing `blob://` attachment alias or explicit attachment ID must resolve through an authorized session reference before the backend accesses the pool. Every read path must apply this rule, including `read_blob`, HTTP previews/downloads, provider blob resolution, and ACP/file prompt ingestion. Do not expose a raw digest-based download URL. The same attachment bytes can be shared physically while filenames, MIME choices, conversation history, and access remain independent.

Physical content objects contain only bytes. Move MIME metadata from the current single-object sidecar model to the attachment reference for pooled attachments; one caller's MIME or filename must not overwrite another's. Existing spill, browser evidence, and private model-context blobs retain their distinct access rules and are outside this attachment pool proposal.

### Upload and reuse rules

For the initial transport, receive the complete bounded body through the authorized upload endpoint, verify/hash it on the server, and then reuse/create the global object. This establishes possession of the bytes without returning a global existence probe. Return the caller's attachment reference with the same response shape whether the pool hit or missed. The global storage requirement does not require metadata-only transfer avoidance.

A metadata-only init request containing a digest must not grant a new session access to somebody else's pooled object. Transfer avoidance can reuse an already-authorized attachment or later use a separately reviewed possession protocol; a guessed hash is insufficient. Do not copy Trinity's global hash-hit fast path directly into Harness's public authorization flow.

- Same bytes in another session/user/tenant: reuse the global object; create that session's own reference and writable workspace copy. Do not expose another session's reference or path.
- Same bytes, same session, same attachment metadata, unchanged workspace copy: reuse the global object and existing attachment/materialization. Keep every new user message even when it uses that same reference.
- Same bytes, same session, edited or missing workspace copy: reuse the global object, create a fresh workspace copy and materialization receipt, and reference the fresh path. Preserve user edits. Prefer a fresh copy for an independent submission when unchanged-state verification cannot be made reliable; never overwrite the existing path.
- Same bytes with a different filename/MIME/origin: reuse the global object while preserving each submission's metadata in the appropriate attachment reference. An idempotent retry returns its original result rather than rewriting metadata.
- Different bytes, including whitespace changes: create a distinct global object. No normalization or approximate matching for raw storage.
- Ordinary tool-created workspace files remain working files. They enter the global attachment pool only through an explicit ingest/publish operation; do not scan or deduplicate all workspace writes.

### Concurrency, retries, retention, and accounting

Two simultaneous uploads of the same bytes must converge on one ready global object through a PostgreSQL unique constraint and immutable/conditional object publication. Upload into temporary staging first; do not use overwrite-capable `BlobStore.put(hash, ...)` as a concurrency strategy. Publication must be recoverable if bytes are stored but the readiness transaction fails. A reference may be committed only against a ready verified object.

Carry a bounded ingestion idempotency key scoped to tenant/session. Persist its verified input identity, chosen path, and receipt progress before uncertain external effects, and reject reuse of the key for different bytes or metadata. Recover an uncertain workspace write by checking that recorded path through the configured Sandbox, rather than allocating another path or overwriting edited content. Per-session durable coordination orders materialization and append-only attachment receipts. A retry can return the existing receipt; a new prompt remains a distinct request.

Failure handling keeps the draft and staged paste available, blocks automatic prompt submission, and allows a deliberate retry. Never silently drop, truncate, or inline the paste. Blob publication, workspace write, and event append form a recoverable workflow rather than one filesystem/database transaction.

Global retention must consider references from **all** sessions and tenants, plus replay retention and pending ingestions. Removing one attachment/message/session cannot delete bytes still retained elsewhere. Use durable reference tracking and a grace-period collection process that excludes live ingestions and rechecks references under coordinated deletion/publication. Reference counts alone cannot justify deletion after a crash. Workspace-copy cleanup is separate and must preserve user edits. General artifact garbage collection does not exist today, so this is required design work rather than an available facility.

Report logical attachment usage per tenant/session independently of pooled physical bytes. A pool hit must not bypass upload limits or expose other tenants' usage. Existing model-usage accounting remains unchanged. Physical storage metrics may report aggregate pool savings without identities, paths, or content.

Where deployments require separate encryption keys, residency, or storage backends, use distinct explicit pools; global means all eligible attachments within the same configured storage/security domain. Do not silently claim cross-domain deduplication or change encryption guarantees to obtain it.

The current `session/attachment` schema and BlobStore port do not implement these records, authorization, conditional publication, or recovery semantics. Define the necessary bounded shared schemas and contracts, database migrations, and reader compatibility before writers; retain legacy opaque blob references through an explicit compatibility resolver. Never rewrite historical session events to migrate them.

## Decisions still needed for review

- Should Harness adopt the reference's 8,000 estimated-token threshold, choose a different value, or configure it per deployment?
- Should the first version convert only threshold-exceeding whole drafts, or also detect instruction-plus-large-body drafts below that threshold?
- Global exact-byte storage deduplication is required. Review the proposed scoped references, independent workspace copies, and full-body-first upload transport; metadata-only transfer avoidance remains separate.
- Approve conversion at the actual clipboard boundary for the first version? Whole-draft parsing and non-browser clients need an explicit equivalent submission contract rather than automatic semantic splitting.
- What limits should apply to pasted byte size, preview length, upload duration, and accepted text encodings?

## Acceptance criteria after approval

- Boundary cases below/at/above the agreed threshold; UTF-8 multibyte size accounting; whitespace and line-ending preservation; selection replacement and cursor placement; typed instructions preserved across multiple pastes.
- Upload through local and configured guest Sandbox routes; Chat automatic and Work selected workspace bindings; prompt references match durable attachment receipts; text never enters the image provider path.
- Identical uploads across sessions, users, tenants, filenames, MIME metadata, and paste/file origins converge on one global original, with independent authorized references and workspace copies.
- A digest or another tenant's attachment ID cannot authorize a read, prompt attachment, or metadata-only pool claim. Verify HTTP, tool, ACP, provider resolution, and preview paths; no raw pool download or existence API.
- Identical retries and concurrent uploads recover one logical result; changed/deleted working copies create fresh paths; different bytes remain distinct. Editing any working copy cannot alter another copy or the retained original.
- Crash recovery covers publication/readiness, workspace write, and receipt append boundaries. Collection racing with upload or attachment deletion cannot remove an object with any live reference or pending ingestion; tenant accounting is independent of physical dedup savings.
- Cancellation, failed upload, failed materialization, failed event append, and lost HTTP response preserve the draft and recover without destructive repeated effects.
- Replay resolves the retained original and current committed user request after workspace edits, restart, continuation, or message exclusion. Attachment-only requests preserve full user-text provenance.

## Scope boundary

This proposal covers paste conversion and a global immutable original-content pool shared by ordinary uploaded attachments and pasted text. Scoped references, access checks, materialization, recovery, and retention are included because global storage reuse depends on them. Model retrieval, normalized-text chunk/index deduplication, full-document analysis, context budgets, and automatic pooling of arbitrary workspace files are separate scope.

## Implemented decisions

- Clipboard conversion uses `ceil(text.length / 4) >= 8,000`, preserves the pasted bytes as UTF-8, and inserts a visible marker at the selection. The existing 20 MiB attachment ceiling applies. There is no heuristic splitting of whole typed drafts. Users can preview/remove staged text and edit surrounding instructions.
- Ordinary image/PDF/text uploads and ACP inline attachments use global immutable original storage. `attachment_contents` records verified digest/size; `attachment_ingestions` journals scoped upload operations. `blob://attachment/<session>/<id>` aliases carry access through append-only receipts. MIME/filename/origin belong to the reference, not the pool.
- A stable upload operation ID recovers its receipt and reserved workspace path. Each independent operation gets a fresh writable copy, including same-session repetitions; this deliberately avoids a time-of-check race against user edits. Global original storage is still deduplicated.
- Server and worker resolve pooled references through session scope. Downloads, prompt admission, ACP, provider resolution, and `read_blob` reject direct pool access. Legacy attachment reads use historical session references; private browser/model-context paths retain their distinct restrictions.
- Text is exposed through workspace paths and bounded reads rather than provider image/file media. The Loop resolves exact pasted originals for current user-text/tool/delegation provenance without injecting them wholesale as model text.
- Recovery verifies the exact reserved path after an uncertain write; mismatched or unavailable files fail closed and are never overwritten automatically. A retained committed receipt is returned on a lost-response retry.
- Retention is conservative: pooled originals and ingestion records are retained; no automatic deletion or garbage collector is enabled. This preserves references across tenants/replay and leaves safe collection, expired staging cleanup, storage quota accounting, and operational retention policy as explicit production follow-ups. Metadata-only upload avoidance is not implemented.
- Migration `0018_sudden_ultimates.sql` adds the catalog tables. Reader/writer code must be deployed together across server and worker after migration. Development memory mode uses an in-memory catalog with the same lifetime as its in-memory sessions; durable recovery requires PostgreSQL.
