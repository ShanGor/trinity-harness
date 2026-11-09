# Approval strategy

Implemented baseline: 2026-11-08. This supersedes the former default of approving every browser input operation. Explicit session restrictions, Sandbox, tenant/owner checks, privacy checks and durable approval decisions remain authoritative.

## Principle

Approval protects a consequential effect: spending money, deleting valuable data, replacing existing content without task authority, sending/publishing/disclosing information, or changing access. Reading a supplied book, finding its passages, opening public sources, searching and scrolling should not interrupt the user.

Prepare the action first. The user should see the named target and consequence, not be asked whether an executable name or pixel coordinate is safe. Unknown effects require inspection or a narrower operation, not a vague approval. A plan, website text, model explanation or past assistant proposal cannot grant authority. Never repeat a mutation or an approval merely to repair bookkeeping.

## Execution

The existing Tool Runtime has an optional adapter-owned `assess` preflight. Its bounded Zod contract returns `allowed`, `ask`, or `unavailable`, with a consequence summary. Preflights validate arguments, use the injected Sandbox and cancellation, and do not perform the requested effect. Failures/timeouts produce no-effect unavailability. The Loop persists the result as an ordinary tool result, or uses the summary in the existing durable approval flow. No new approval tool, service, table or event type is introduced.

Explicit `denied` remains final. Explicit `ask` restrictions remain in force. A preflight may add protection to an otherwise allowed tool; an allowlisted executable does not authorize typed browser input. The authenticated original request is supplied through `ToolContext.userRequest`, never a model argument. Existing command grants replay through the event log and cannot override denied or sensitive-file rules. Unknown effects are not automatically retried.

### Attachments and reads

`read_blob` supports a Unicode-code-point `offset`, a nullable `nextOffset`, and literal `query` search returning bounded snippets with match offsets. `maxBytes` bounds returned text; search returns at most 20 matches. A too-small limit returns a correctable error rather than a cursor that cannot advance. Original session-reference, private model-context and browser-artifact restrictions apply to reads and searches alike.

When both attachment authorization and events are available, the tool returns the recorded session-relative `workspacePath`. This is a writable copy; original blob contents remain immutable and may differ after a user edit. Agents must not search `/tmp`, runtime caches or filesystem roots to find attachments.

Literal bounded shell reads are classified as reads, so they do not require a task plan. Supported examples include `sed -n '833,1000p' uploads/book.txt`, `grep -n insight uploads/book.txt`, and `cat uploads/book.txt | head -20`. The no-argument `date` query and its UTC forms (`date -u`, `date --utc`, `date --universal`) are also read-only; setting the clock, reading an input file, or supplying a format string is not in the automatic allowlist. File redirects, execution options, arbitrary interpreters and compound shell programs are not assumed safe. Out-of-workspace literal absolute reads are rejected by preflight. Use file tools and separate independent reads instead of turning unsupported syntax into approval requests.

### Browser

The fixed extractor attaches optional `actionKind` metadata to delivered targets: HTTP(S) anchors, native details/summary controls and search inputs/forms. Target names are untrusted evidence; a friendly label alone does not authorize an arbitrary button. Routine recognized navigation, expansion, search input and scrolling do not ask by default. Sensitive targets remain unavailable. Consequential labels take precedence over ordinary navigation classification for activation.

A consequential named control can request approval showing its site origin and label. A generic final button such as “Pay” or “Delete” does not identify a sufficient consequence and remains unavailable. Coordinate-only clicks and unexplained controls return no-effect inspection guidance, never a coordinate approval. Use fresh delivered named refs, another observed navigation route, or explicit human takeover if the site cannot expose a sufficiently clear action.

There is deliberately narrow reuse of direct request authority: a current request exactly matching `<observed action label> on <site origin>` permits that named action without another prompt. Explicit operation restrictions still apply. This is not general natural-language consent recognition. Broad requests such as “buy a book” do not identify a final price or merchant commitment.

Existing binding/document/fingerprint, delivered-target, generation, control, privacy and post-action checks remain at execution time, including after approval. Human input/control changes invalidate preflight evidence. New metadata is optional for compatibility; old snapshots without classification must be refreshed before routine activation can be recognized.

This is a conservative trusted-browser baseline, not a proof of arbitrary website behavior. JavaScript handlers, misleading labels, side-effectful destinations, custom controls and complex forms still need site-specific acceptance or stronger effect-specific adapters. Do not claim production isolation or universal payment/send/delete safety from these classifications.

### Files and commands

New literal workspace files proceed. Full-file `write_file` replacements and whole-file/emptying `edit_file` replacements require a named-file change request or approval; ordinary bounded edits can proceed when the current request asks for implementation or modification and the existing file can be inspected. Previews identify the path and replacement risk, never include file contents. Named-file recognition checks the committed request for the path and change language, conservatively rejecting negated/restricted wording. Broad implementation requests authorize ordinary targeted edits; complete replacement, deletion, large/uninspectable targets and ambiguous requests may still require file approval. This is a bounded fallback, not a semantic proof that an edit is relevant. Existing full-access policies remain explicit opt-outs for file changes.

Destructive commands, arbitrary interpreters, Git mutations and executable script bodies are no longer automatically safe merely because their executable appeared in the old binary list. Known consequential literal commands request approval; unexplained programs/compound shell syntax return inspection guidance. An exact command supplied as the entire current request can authorize that command, without overriding explicit `ask`/`denied` or sensitive-file rules. Configured and authenticated conversation command grants remain supported.

The stock workspace policy no longer grants all `agent-browser` CLI commands automatically. Use the typed browser tool. Explicit existing custom grants are not silently rewritten. Grant creation uses the same literal parser as execution, so `cd … && sed …` cannot create a useless `cd` grant. Rejected requests cannot create grants.

Preflight is not an OS-level filesystem monitor. File existence can change between inspection and execution; the existing file tools do not provide atomic compare-and-swap overwrite protection. Build/test scripts can have effects, and lexical recognition does not establish script safety. These remain sandbox/trust and rollout limits.

## Validation and rollout

Deterministic regressions cover zero-approval attachment analysis, Unicode continuation/search, shell effect classification, protected overwrites, approval failure/denial, recognized browser controls, consequential/generic/stale/coordinate targets, and ineffective grants. Existing crash recovery, approvals, cancellation, task verification and frontend tests remain applicable.

Deploy matching server, worker and Browser Runtime code. No database migration, permission bulk-upgrade, pinned browser binary change or guest image rebuild is required. Do not infer that a development checkout has changed running containers. Validate actual browser workflows and a real-model attachment turn before claiming production behavior or a universal approval-quality improvement. Remaining acceptance gates live in `production-checklist.md`.
