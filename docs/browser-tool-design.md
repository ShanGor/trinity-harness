# Browser tool design: live interaction and rendered document capture

Date: 2026-11-13. Implementation update: 2026-11-14. Status: target design with a **capability-negotiated `rendered-document-v1` implementation in this checkout**. Capture uses the configured runtime/driver. The matching candidate is installed on the local development node after direct guest acceptance; jailer and authenticated owner-route acceptance remain open, as does real-model evaluation. Existing semantic observations stay compatible. Implementation and rollout evidence belong in [project progress](project-progress.md) and the [production checklist](production-checklist.md).

Implemented pilot scope: frame identity/owner discovery, isolated bounded structural capture, open-shadow records, decoded image pixels and explicit resource gaps, immutable safe HTML/graph storage, offline paged conversion and source validation, bounded saved reads/search, and explicit workspace export. Conversion preserves text, lists, code and bounded tables; arbitrary user-schema extraction is not advertised. Bounded basic SVG shapes/groups/text and approved computed presentation properties are preserved by the updated serializer. SVG references/filters/foreign content, canvas pixels/OCR, browser resource-cache byte retrieval and refetch/download remain unsupported. Media gaps never invalidate captured text. Frame-aware input remains separate from extraction.

The pilot uses the candidate document/depth/byte/deadline limits below. Transfer chunks contain at most 8,000 UTF-16 units, independently checked byte counts/SHA-256 and document revision, under the 64 KiB chunk-payload ceiling; the existing bounded MCP envelope limit also remains enforced. Generated inert HTML is capped at 16 MiB/document and 64 MiB/capture, with matching stored byte hashes. Each session reserves at most eight writers, including failures/orphans; at most two attempts are allowed without a new user request or a completed live interaction. Conservative retention performs no automatic deletion. This bounds capture storage to eight 10 MiB graphs plus eight 64 MiB HTML sets, with small manifest overhead; deployment-wide owner/tenant storage acceptance remains a release gate. Workspace exports have a separate 64 MiB limit and never overwrite an existing generated directory.

Only already-decoded images up to 2048 × 2048 and 120,000 data-URL characters are copied; larger/cross-origin/streaming resources retain explicit unavailable/reference states. Other asset limits are ceilings, not a promise that the pilot retrieves those bytes. Saved reads recheck source suppression after transfer and exports recheck before each write; transient renderer state has a capture-deadline expiry when explicit cleanup is fenced. The saved graph is the conversion input and source map; deterministic inert HTML files are stored alongside it and revalidated on reads. Derived observations retain the existing 256 KiB limit. `extract_capture` returns `capture.nextOffset` for further offline conversion; ordinary observation cursors paginate delivery within one conversion segment. `export_capture` materializes HTML/media without Markdown conversion. `export_markdown(captureId)` saves the same bundle, then reads the saved HTML through the originating session Sandbox and converts it offline with bundled Turndown/GFM. It never formats semantic observations or substitutes the structural evidence converter. Raw HTML ranges are inert source reads; automatic research citations use delivered derived observation/block ranges with revalidated original capture mappings.

Authority: [design §8.2](design.md), [approval strategy](approval-strategy.md), [browser research](browser-research-improvement-plan.md), [Zendriver integration](zendriver-browser-design.md) and [runtime deployment](runtime-implementation.md). This document supersedes semantic-first capture as the target design for document extraction. The default-off implementation does not change the deployed guest or grant execution rights.

For an HTML/Markdown export task, the skill checks whether `capture_document` is advertised before attempting a new archive. Saved document operations remain available for authorized existing captures when live capture is disabled; their availability does not imply live capture. Only a successful rendered capture supplies `captureId`. Semantic observation/snapshot IDs cannot be substituted. Missing-capture errors identify this prerequisite and the disabled-deployment boundary; repeated semantic reads or scrolling screenshot transcription cannot certify a complete export. The runtime skill states this workflow before general browsing guidance.

## 1. Decision

Use the existing authorized browser for two workflows:

| Workflow            | Purpose                                                                                            | Representation and authority                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Live interaction    | Navigate, follow links, search, click, fill, scroll and operate applications                       | Fresh bounded accessibility/DOM surfaces, validated targets and optional screenshots, fenced to the current runtime, document and control state |
| Document extraction | Read an article, analyze tables, collect useful information, preserve a report or produce Markdown | Capture rendered documents and available media first; save immutable artifacts; derive text, Markdown and structured data offline               |

These workflows share the driver, authenticated owner scope, locks, cancellation, egress policy, journals and evidence infrastructure. They are not separate browsers or an automatic driver fallback. A mixed task can interact to reach the requested state, capture it, and then analyze the saved files.

Archive creation is not a prerequisite for navigation or clicking. Saved HTML is historical source data and never authorizes a live action. Ordinary focused reads may continue using lightweight semantic observations; large extraction/export tasks and persistent extraction gaps use the document pipeline. Choose from the user's goal and observed coverage, without a domain classifier or mandatory extra model call.

## 2. Incident and design motivation

The latest inspected session, `01a1d574-aeeb-7000-8506-4eee5f029e55`, requested text and images from a Grok-hosted report as Markdown. At result seq 22 the browser reported `heading-only`, one visible frame, zero captured embedded frames and one unavailable frame. Later captures retained that gap. The session made 36 browser calls over about 16 minutes and ended aborted. It navigated once; no curl attempt occurred in this session. Export converted the incomplete observation rather than recovering the article.

The user could copy the iframe's HTML manually. This supports investigating the frame-document capture path; it does not prove that every resource can be archived. The preceding patched-binary public reproduction recovered article text, but it was not acceptance of the installed guest or real-model recovery behavior.

The inspected configuration selected Firecracker. Restarting the host Browser Runtime does not replace guest code or its binary. The configured host executable was dated October 24 while a separate patched test executable was dated November 13. The exact installed guest build was not verified in this review; deployment mismatch is a lead, not a proven sole cause.

The architecture must address three independent failures: missing frame documents, loss of source structure before persistence, and repeated model attempts that do not change coverage. Successful navigation, pixels, nonempty text and successful file creation each prove different things.

## 3. Live interaction stays live

Keep `navigate`, `web_search`, `read_page`, `click`, `fill`, `key`, `scroll` and `screenshot` under the existing typed tool. Navigation returns a bounded overview; it must not silently create a full archive. Input uses fresh adapter-owned refs and consequence preflight, with just-in-time checks for unique target identity, visibility, enabled/editable state, event reception, focus and relevant geometry. The exact checks depend on the action.

When adding interaction inside frames, bind the ref to the owned tab, frame ancestry, frame document revision and current control epoch. Re-resolve and validate within that frame immediately before dispatch. Missing or ambiguous identity returns no-effect stale/unavailable feedback. Never turn an HTML node ID, saved selector, copied URL or extraction source range into an action token. Frame-aware extraction does not itself deliver frame-aware input.

Actionability waiting can retry observation and target resolution within a deadline. It must not repeat a click, form submission or navigation after uncertain dispatch. Record intent/outcome through the existing journal; unknown input effects retain quarantine and recovery semantics. No model-authored JavaScript, arbitrary selectors or raw CDP commands are added.

Human takeover blocks model live capture as well as input. Human viewer pixels stay user-only. Returning control requires fresh observations in each originating chat. Saved authorized evidence remains historical evidence, without acquiring current-page authority.

## 4. Capture rendered documents before extracting meaning

“Rendered HTML” means the current browser DOM after page scripts have run, with explicit frame/shadow structure and bounded layout metadata. It is neither the original HTTP response nor a promise to reproduce the application. It covers authorized document state present during the capture interval, including normal content below the viewport. It does not imply content behind collapsed controls, unvisited pagination, unmounted virtual rows or resources that have never loaded.

Do not rely on Chrome's Save page UI, top-level `outerHTML`, `view-source`, a guessed iframe endpoint, or curl. A parent document contains an iframe element; its child document must be captured separately. MHTML may be an optional independently checked export format, never the primary capture dependency or proof of coverage.

### 4.1 Capture protocol

1. Authorize the originating session, owner, current policy and browser generation. Acquire the existing owner-anchor control lock; record the originating command reservation before dispatch.
2. Check document readiness against a bounded task-relevant condition where supplied. DOMContentLoaded, a quiet network and an arbitrary sleep do not establish article readiness. Use cancellable browser events/observers and deadlines; continuous analytics must not prevent capture indefinitely.
3. Discover Chrome's authoritative frame tree and separately hosted iframe targets. Prove parent/owner relationships using browser identities and frame-owner nodes, including nested out-of-process frames. Do not identify frames by URL: duplicate URLs, redirects, `srcdoc` and opaque origins are valid cases. Failure to prove ownership leaves that frame unread.
4. Inventory eligible content and apply privacy inspection in every selected document and open shadow root before retaining content. Eligibility is policy- and scope-bound: inspect mounted content in rendered, non-hidden containers, including below-viewport content. Hidden/protected subtrees remain excluded. Root-level extraction heuristics must not hide an eligible iframe from discovery.
5. Capture each eligible frame in its own validated execution context using fixed adapter-owned code or pinned protocol methods. Save inert structural HTML plus explicit open-shadow-root records and layout/visibility metadata. Resolve relative references against that document's base URI. Preserve document boundaries and iframe-owner placement, rather than appending all child text at the end of the parent.
6. Transfer bounded chunks through the existing Sandbox/private runtime route. Each chunk binds capture/frame/document identity, ordinal, byte count and hash. Verify the assembled result before publishing. No unlimited `outerHTML` result may be buffered and trimmed afterward; implementation must demonstrate bounded serialization as well as bounded transport.
7. Recheck tab, generation, control, frame relationships and document identity. Check per-document mutation markers around serialization; record timestamps and stability status. Identity rechecks alone do not establish stable content. Concurrent scripts mean this is a bounded capture interval, not an atomic browser-wide snapshot.
8. Persist validated artifacts, then commit the manifest/evidence reference and bounded result through existing events. Only committed authorized artifacts are readable. A crash may leave an inaccessible orphan; no partial manifest becomes a successful capture.

Default to one capture attempt plus at most one read-only recapture for a proven transient document/frame change, within the same cancellation/deadline and persisted attempt allowance. Do not merge chunks from different document revisions. Persistent churn returns explicit unstable/partial coverage. Privacy, authorization and unknown input effects are not retryable capture races.

### 4.2 Representation boundaries

The presentation extension (`presentationVersion: 1`) preserves approved computed CSS properties, table spans and bounded inline SVG shapes/groups/text as typed nodes. Visual eligibility does not use `aria-hidden`: visible decorative vectors are eligible and visible protected controls still undergo privacy inspection. CSS is limited to a closed property/value vocabulary with no URLs, custom properties, escapes or executable content. SVG accepts only bounded geometry, paint and transform attributes; external/local references, foreign content and filter/definition mechanisms are omitted and reported. These are presentation improvements, not a pixel-identical backup: source stylesheets, embedded fonts, pseudo-elements, animation and unsupported SVG features are not reproduced.

SVG resources use `inline` for structure preserved in the graph/HTML; `captured` continues to require validated PNG bytes. Unsupported SVG scopes remain unavailable resources. Rejected supported-property values/unsupported vectors emit `presentation-omitted`/`vector-omitted`, reflected in partial coverage and bounded result `presentationOmissions`. Inventory is bounded independently of serialization. Persisted and exported HTML allow the validated inline styles via CSP while retaining default network/script denial. Old captures without the presentation version retain their original HTML bytes and hashes. Markdown retains sanitized SVG as inline HTML with a portability warning, since Markdown renderers may suppress SVG.

Deploy matching contracts/readers and export code before the updated capture writer; the existing pinned frame/evaluation protocol needs no Rust patch. Existing guest packaging still requires the matching application payload and maintenance procedure when updating its immutable image. The local copied-file regression is not deployed-browser acceptance.

HTML preserves structure; layout metadata supports visibility decisions; semantic blocks provide compact reading; screenshots support visual evidence. None alone describes every page. Inline SVG can retain safe structure. Canvas/WebGL needs separately authorized pixels, with OCR stored as a derived uncertain transcription. Closed shadow roots, plugins and inaccessible embedded documents remain unavailable unless an explicitly supported capability passes privacy and ownership review. No browser-security override is introduced.

Full raw DOM can contain hidden credentials, script payloads, populated controls and private drafts that semantic reading previously excluded. Broad capture must not expand model authority. Never persist unscreened raw HTML and sanitize it later. Apply existing denial rules and safe serialization before durable storage/model delivery; if inspection is ambiguous or exceeds its bounds, fail closed. Record safe omissions without values. Exclude scripts, event handlers, executable URLs, form values and protected hidden content. The result is a policy-filtered structural capture, with exclusions, not a byte-for-byte page backup.

## 5. Media and offline artifacts

Media discovery covers `img`/`picture` selected sources, safe inline SVG, CSS background references, posters and audio/video references. Record role, frame/node provenance, dimensions, MIME type when known and availability. Discovery is not successful byte transfer. A remote URL is not an offline asset.

Prefer bytes already available through an ownership-checked, pinned browser resource capability. DOM/canvas image access can fail on cross-origin media even when the browser displays it. Resource retrieval behavior and whether it can initiate network access must be established on the pinned build; APIs with unknown behavior cannot be labeled offline reads. No default image refetch, CORS disablement, universal-access world, cookie export or shell HTTP fallback. Any separately authorized browser download/refetch follows destination/egress, permission, size, credential and cancellation checks and reports its network effect explicitly.

Use explicit per-resource states: `captured`, `reference-only`, `not-loaded`, `blocked`, `unsupported` or `limit-reached`. Streaming/DRM content, blob URLs and expired resources do not imply a recoverable file. Do not start video playback, click downloads or scroll indefinitely to improve media coverage. Authorized lazy loading is a separate live interaction, followed by a new capture.

Conceptual internal artifact layout:

```text
capture/manifest.json
capture/documents/main.html
capture/documents/<opaque-document-id>.html
capture/structure/<opaque-document-id>.json
capture/assets/<content-hash>.<validated-extension>
derived/<conversion-id>/content.md
derived/<conversion-id>/sources.json
```

This is a logical BlobStore layout, not a model-supplied path or host filesystem API. A capture contains version/build metadata, originating call/session authorization, runtime/document revisions, capture interval, hashed frame/resource entries, exclusions, safe reason codes, byte counts and coverage status. Raw internal frame IDs remain adapter metadata; model results use opaque capture/document IDs. Sensitive URLs never enter diagnostic fields.

Large captures use the separately versioned `browser-document-v1` artifact contract. Keep current 256 KiB semantic artifacts and per-response bounds unchanged. Proposed starting limits for evaluation: 20 documents, depth 3, 2 MiB per document, 10 MiB document total, 100 assets, 5 MiB per asset, 25 MiB asset total, 64 KiB transfer chunks and a 30-second capture deadline. These candidate defaults are implemented as pilot ceilings, with the stricter decoded-media limits and storage quotas recorded above; they are not completeness guarantees. Validate aggregate limits before publication, report each omitted scope, and propagate tighter task/tenant limits. No new cumulative per-turn evidence cap is introduced.

## 6. Typed operations and module boundaries

Retain one `browser` tool and existing contracts/DI. The pilot implements the following operations. Saved operations remain available without a live browser; `capture_document` is advertised only with a configured runtime or a live driver implementing capture, then checks the installed binary capability before serialization:

| Operation                         | Behavior                                                                                                 | Effects and result                                                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture_document`                | Capture the current owned rendered document graph with bounded readiness and media policy                | Live read plus internal evidence persistence; returns capture ID, coverage, inventory summary and small excerpt; no workspace file write     |
| `extract_capture`                 | Derive article/full-content text, Markdown, tables or bounded structured data from an authorized capture | Offline, no browser allocation/network; returns derived observation and source mapping; never promises arbitrary schema correctness          |
| `read_capture` / `search_capture` | Retrieve bounded inert source/derived ranges                                                             | Offline authorized reads with exact delivered-range receipts; no live refs                                                                   |
| `export_capture`                  | Materialize rendered HTML, captured media, structure and provenance in the session workspace             | Ordinary Sandbox mutation, minimal plan/policy checks, bounded generated paths and manifest; archive access alone grants no overwrite rights |

`export_markdown(captureId)` uses the same workspace mutation policy as `export_capture`, returning the generated Markdown path, HTML bundle path, capture ID and converter provenance. It does not allocate a browser or accept an observationId.

Keep current `read_observation` and `search_observation` compatible. `export_markdown` now requires `captureId` from a committed rendered-document capture, replacing its former `observationId` input. Historical export results remain historical data, but new semantic-only export requests are rejected. Semantic-only observations cannot reconstruct rendered HTML; never regenerate an old observation from the current page to satisfy an export. `get_page_text` remains a lightweight live capture, not pagination or an implicit document archive. An older binary returns no-effect capability feedback; it never silently substitutes semantic text for a document capture.

Extend `BrowserDriverPort` with high-level typed capture capabilities, not generic evaluation. `BrowserRuntimePort` continues owning complete-operation authorization, locking, dispatch and outcomes. Cross-process DTOs and version negotiation belong in contracts with Zod; pure conversion stays in core and storage uses injected BlobStore/SessionStore. App roots assemble dependencies. No new service, plugin framework or direct provider transport is needed.

`export_markdown(captureId)` is an HTML-first workspace operation. Before conversion it writes each captured frame as `<document-id>.html`, its structural source map, available media under `media/<hash>.png`, `manifest.json`, and `content.html` with child documents placed at their iframe owners. Exported per-frame HTML links to local child HTML; the composed input contains the child content. Relative references have already been resolved against each captured document's base URI. Captured media `src` values and links to captured media URLs are rewritten to the deduplicated local `media/` files in both per-frame and composed HTML. Unsafe/original remote media loads, CSS and `srcset` are excluded; unavailable resources have placeholders and explicit manifest states. Original media URLs remain provenance, never a claim that bytes were downloaded. Immutable internal artifacts are unchanged; the export manifest records their source hashes plus the composed conversion-input hash.

The converter is bundled Turndown with GFM support. After materializing `content.html`, read its exact bytes through bounded version-fenced Sandbox pages and verify their SHA-256 against the composed-input hash. Conversion runs in a disposable worker thread with a 30-second deadline, cancellation, a 256 MiB old-generation memory limit and an 8 MiB output ceiling. Node worker imports use packaged dependency paths; no guest/native converter executable is needed. Headed simple tables become GFM tables; merged-cell or headerless tables remain inert HTML with a warning. Input bytes are hash-checked again before Markdown publication. The manifest records converter/extension versions, configuration, input/output hashes and warning presence. HTML node/document identities retain provenance; Markdown is not advertised as an exact research block-range source map.

Conversion failure/output overflow leaves the HTML bundle and its `conversion: null` manifest available for offline diagnosis, without publishing partial Markdown or recapturing the website. Generated directories are never overwritten or automatically retried. The 16 MiB per-file and 64 MiB aggregate export ceilings include HTML, media, metadata and Markdown. `export_capture` writes only the HTML/media/provenance bundle. Structural `extract_capture` remains a separate bounded citable evidence projection.

Offline conversion treats HTML as inert untrusted data. Never execute its scripts, resolve external entities or load remote images/styles. Preserve language, Unicode, table cells, list/code structure and link destinations. Record converter version, configuration and input hashes. Derived blocks map to capture/document/node/text ranges; cross-frame ordering is explicit. HTML appearance fidelity and semantic extraction accuracy are separate acceptance dimensions.

## 7. Evidence, files and privacy

Every read rechecks owner/tenant/session access and current suppression policy. Shared personal browser access does not share evidence authority across chats, children or forks. Generic blob/HTTP/file tools must not expose internal capture namespaces. Use purpose-built bounded reads; large files do not justify bypassing source checks.

Saving an archive is not proof the model read it. Expose exact inert text/HTML ranges or derived block ranges with committed receipts before citing them. Resolve citations through the existing source pipeline extended with derivation provenance; validate original capture hashes and mapping. OCR and model-derived summaries remain labeled interpretations. A successful conversion or matched citation never certifies claim support or task completeness.

Workspace exports are explicit copies. They cannot mint authoritative source receipts or live action refs. Generic analysis may process exported files as untrusted workspace data; automatic citation authority still requires the original authorized capture mapping. Human preview must be inert/sandboxed with scripts, forms, external loads and top navigation disabled. Export excludes active content and warns within metadata if offline rendering is incomplete. Credentials and browser/profile storage are never bundled.

Hashing proves integrity, not privacy. Existing retention is conservative; the pilot uses the durable session writer reservations and conservative orphan retention above; broader owner/tenant storage acceptance must pass before general rollout. Metrics contain counts, reason codes and timings, never page text, identities, URLs or paths.

## 8. Coverage and recovery

Report independent dimensions: document coverage, resource coverage, capture stability, conversion outcome and delivered ranges. Candidate values for document coverage are `captured-within-scope`, `partial`, `unstable` and `unavailable`. “Within scope” is bounded by explicit eligibility and limits; it never means the entire website or all possible application states.

| Observation                                                      | Next behavior                                                                                                                                                                       |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loaded report but heading-only text and an unread visible iframe | Use available document capture once; report missing-frame reason if unsupported. Do not repeat semantic reads or export the heading as complete.                                    |
| Capture has article text but an asset is reference-only          | Analyze available text; label media limitations in export. Do not reject successful text evidence.                                                                                  |
| Extraction method missed a table present in saved HTML           | Reconvert/read saved content; no navigation or recapture.                                                                                                                           |
| Known transient frame replacement during capture                 | Bounded read-only recapture; no reload/click replay.                                                                                                                                |
| Repeated unchanged partial result                                | Persist replayable recovery guidance near the next decision, retain the unresolved requirement, and change method or report the specific limit. No automatic task completion claim. |
| Privacy denial or unknown ownership                              | Stop that capture scope according to existing denial rules; no narrower scope to evade protected content.                                                                           |
| Transport/schema/storage failure                                 | Preserve existing channel failure/quarantine semantics; a successful screenshot cannot erase the fault.                                                                             |
| Expired live refs after analysis                                 | Obtain a fresh live surface before input.                                                                                                                                           |

Track recovery by capture/document identity, relevant revision, result reason and attempted method. Reading a saved artifact is not new live discovery or recovery. Replay must retain failed attempts; restart must not reset retry allowances. Guidance is advisory unless an explicit tool precondition rejects a call; do not describe prompt wording as enforced policy. Valid available evidence remains usable after conversion/export errors.

## 9. Cases and acceptance matrix

| Case                                                                              | Expected result / boundary                                                                                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Static article, article tables and images below viewport                          | Capture mounted eligible document structure; convert offline; media states explicit; no mandatory scrolling                                      |
| Same-origin and cross-origin iframe report                                        | Separate child documents mapped to iframe owners; article text retains child provenance                                                          |
| Nested OOPIFs, duplicate URLs, `srcdoc`, inherited `about:blank`                  | Identity/ancestry-based ownership; opaque documents require a proven owner and inherited provenance, never a general scheme allowlist relaxation |
| Event frame registry missed a loaded frame                                        | Authoritative frame discovery recovers it, or reports a typed frame limitation                                                                   |
| Frame redirect, replacement, moving DOM or control takeover mid-chunk             | Never publish mixed revisions; bounded recovery or unavailable/unstable result; takeover discards model capture                                  |
| Open/closed shadow roots, SVG, canvas and charts                                  | Explicit supported structure/pixels and exclusions; OCR remains derived; no blanket visual-completeness claim                                    |
| SPA loading spinner, analytics never idle                                         | Bounded content readiness; timeout/partial result without repeated navigation                                                                    |
| Virtual table, pagination or lazy image                                           | Capture present state only; further live interaction requires task authority and fresh refs                                                      |
| Authenticated report with private draft, hidden token or populated sensitive form | Privacy checks apply before persistence; deny protected captures; no credential leakage in files/logs                                            |
| Data/blob images, cross-origin pixels, missing/oversized/streamed assets          | State each resource independently; no silent fetch or claim of offline completeness                                                              |
| Form submission, link following or dashboard control                              | Live fresh refs and consequence checks; archive not required; no automatic uncertain-effect retry                                                |
| Analyze then submit a form on the same page                                       | Saved content informs reasoning; fresh live observation establishes action authority                                                             |
| Archive storage failure or worker crash before event commit                       | No readable uncommitted capture; replay does not repeat effects; orphan handled by retention policy                                              |
| Malicious HTML, prompt injection, path traversal or oversized MIME payload        | Inert bounded processing, safe generated paths, content untrusted, parser limits enforced                                                        |
| Cross-chat read, fork, deleted/suppressed source or stale authorization           | Fail closed despite shared browser, cached manifest or copied file reference                                                                     |
| Large multilingual document                                                       | Chunk integrity, aggregate limits, correct Unicode ranges and deterministic conversion; explicit truncation                                      |
| Old guest with matching upstream `--version`                                      | Reject unavailable capture capability before work; upstream version alone is insufficient                                                        |
| Reported Grok page on the deployed owner route                                    | Capture child HTML and derive article text from saved bytes; compare to an independently reviewed fixture; report media coverage separately      |

Mechanism tests cover privacy, ownership, limits, cancellation, torn-tail replay, immutable provenance and no network on conversion. Pinned real-Chrome fixtures cover frame topology and serialization. The deployed authenticated guest route must pass separately. Real-model trials compare task outcomes, repeated calls, latency and cost on matched tasks/model versions; manual review checks missing text/table/media and claim support. A passed tool call or one public-page reproduction cannot establish SOTA performance.

## 10. Delivery stages and rollout

1. Specify versioned schemas, privacy-safe serialization, source mapping, capability negotiation and chunk/resource limits. Measure capture/transfer costs on local fixtures before enabling the large writer.
2. Implement frame-identity capture and bounded immutable storage behind an explicit capability. Preserve current semantic readers; add new readers before writers. Validate same-origin, cross-origin, opaque and OOPIF cases on the pinned Chrome.
3. Add deterministic offline conversion and bounded source reads, then explicit safe workspace export. Keep raw/derived authority and action refs separate.
4. Add replayable recovery guidance, export completeness checks and matched real-model evaluations. Do not force capture for ordinary interaction or simple sufficient reads.
5. Build/deploy the matching patched binary **and guest TypeScript payload**, rebuild the immutable guest image and wake a fresh generation through existing maintenance gates. Preserve profile/data disks and rollback images. Restart the host Browser Runtime where required. Validate capability/build IDs on the actual owner route before accepting rollout.

Record an application build/patch identifier as well as upstream Zendriver/Chrome/protocol versions. Do not expose executable paths or infrastructure addresses to the model. Unsupported deployments return no-effect capability feedback and keep compatible saved reads. No fallback to LocalSandbox, another browser driver or curl is introduced.

## 11. Primary sources and interpretation

- [Chrome DevTools protocol definitions](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json): frame trees/owners, isolated worlds, DOM serialization, DOMSnapshot and resource/snapshot capabilities. `DOMSnapshot.captureSnapshot` documents DOM/layout capture including frames and flattened shadow DOM; this is a candidate supporting representation, not proof that the pinned build covers every OOPIF or preserves all media. Validate actual process topology.
- [Chrome Page snapshot documentation](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureSnapshot): MHTML includes frame/resource serialization at the protocol level. Chrome UI export behavior and pinned-build fidelity must be measured independently; MHTML is optional here.
- [Playwright locators](https://playwright.dev/docs/locators), [actionability](https://playwright.dev/docs/actionability) and [frames](https://playwright.dev/docs/frames): examples of current role/label targeting, just-in-time actionability checks and explicit frame scoping. These inform interaction design; Trinity keeps Zendriver and its stronger journal/permission fences rather than adopting a second driver or copying retry semantics.

The two-workflow architecture, artifact contracts and rollout policy are Trinity design decisions inferred from these primitives and the observed failure. They are not claims made by the source projects or a measured best-in-class result.

### Export result evidence (2026-11-14)

New Markdown results add optional outputHash/outputBytes, warningCodes (`inline-svg`, `unsupported-table`) and bounded limitations (omitted frames, truncated documents, inline SVG and unavailable resource counts). Old results remain compatible. Inline SVG reports viewer compatibility; unsupported tables retain inert HTML. These warnings and unverified coverage do not by themselves require another capture. Export success supplies mechanical publication evidence; it does not certify semantic fidelity. Task checks can name the exact capture/export operation to exclude screenshots and unrelated observations.

2026-11-14 follow-up: `layout-html` identifies retained CSS grid HTML where block span cells would otherwise concatenate during Markdown conversion. Original input hashes and HTML provenance stay unchanged. `limitations.savedMediaFiles` optionally reports deduplicated files actually written; listing media files solely to establish this count is unnecessary. Warning codes describe representation compatibility, not mandatory recapture or universal completeness. See [acceptance evidence](export-verification-acceptance-2026-11-14.md).
