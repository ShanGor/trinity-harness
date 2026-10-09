---
name: agent-browser
description: Browse websites using the installed agent-browser CLI. Use for current web research, website interaction, inspecting web apps, screenshots, and browser-based UI verification.
---

# Browser interaction with agent-browser

Use the `bash` tool to run the installed `agent-browser` CLI. When the task requires current website information or browser interaction, load this skill and inspect the CLI before claiming browser access is unavailable.

Preserve the exact named feature in the user question. For example, MCP Apps interactive UI support is a different claim from MCP tools/servers, an agent SDK, or distribution of agents through an app store. When the wording is ambiguous, explain those distinctions in the answer and avoid confirming the stronger claim from evidence for a related capability.

## Start

1. Check the executable: `agent-browser --version` (one standalone command).
2. Read the installed version's official instructions: `agent-browser skills get core`. If that command is unavailable, read `agent-browser --help` and the help for the subcommands you need. Follow the installed syntax.
3. Choose the connection mode **before opening a URL**:
   - If the runtime catalog supplies a **Browser CDP endpoint**, or the user explicitly supplies a debugging port/URL, attach to that endpoint. Use `--session trinity-<runtime-session-id> --cdp <endpoint> --pin-tab` on **every browser command**. The named session is a daemon/tab binding; `agent-browser connect 9222` in the default session does not connect a different named session. `--pin-tab` creates and binds a dedicated tab in the user's visible Chrome instead of navigating their existing tabs. Cookies/storage belong to that shared Chrome; tab pinning does not isolate accounts.
   - If the user says they already connected the default session without providing an endpoint, inspect the existing session connection metadata with `agent-browser get cdp-url` and `agent-browser session info --json` before choosing a browser. Do not silently create a new headless browser. Ask for the debugging endpoint if the existing connection cannot be identified.
   - If no existing browser was requested and no CDP endpoint is configured, use a named session for an independently managed browser. The CLI launches headless by default; use `--headed` when the task requires a visible window and a desktop is available.
4. Use the current core connection guidance when attaching to Chrome. If detailed session troubleshooting is needed, `agent-browser skills get core --full` includes the installed session-management reference without a separate filesystem command. Supply the chosen connection flags consistently. Shell variables set in one bash invocation do not persist in later invocations.

Attached workflow, replacing the session placeholder and endpoint with current runtime values:

```sh
agent-browser --session trinity-<runtime-session-id> --cdp 9222 --pin-tab get cdp-url
agent-browser --session trinity-<runtime-session-id> --cdp 9222 --pin-tab open https://example.com
agent-browser --session trinity-<runtime-session-id> --cdp 9222 --pin-tab snapshot -i
agent-browser --session trinity-<runtime-session-id> --cdp 9222 --pin-tab click @e1
```

If the named session previously launched another browser, explicitly reattach with `agent-browser --session trinity-<runtime-session-id> --pin-tab connect 9222` and verify `get cdp-url` before continuing. If its old tab binding is missing (`tab_gone`), create a fresh bound tab with `tab new about:blank`; do not switch to a user's unrelated tab.

## Recover from failures

- When an explicit endpoint is unreachable, report the connection error. Do not drop `--cdp`, fall back to a managed browser, kill Chrome, or repeatedly close/relaunch it.
- A `Page.navigate` timeout means navigation did not complete in time; it does not by itself prove a broken browser connection. Check `get cdp-url`, `get url`, and a fresh snapshot with the same flags. Inspect the current page before retrying, since navigation may have partially succeeded.
- If a search site is inaccessible or yields unrelated regional results, use another accessible source or primary website within the task's authority. Report missing evidence. Avoid fixed sleeps and endless repetitions of the same failing URL.
- The `bash` tool may enforce its own timeout. Use short diagnostic commands separately; do not concatenate close/sleep/navigation loops. Do not request approval again for a command that is already pending.

## Research: collect evidence and answer

For a factual research question, identify the exact feature/product/surface being asked about and what would establish the claim. Separate an announced plan, shipped support, and availability through a related product. Record the question and unresolved distinctions with `research(action="record", notes=...)` when available; an empty findings list is valid initially. These are model-authored research notes, not authoritative facts.

1. Preserve the requested feature phrase in the query (quote a named feature such as "MCP Apps") and search it together with the requested product. Inspect results with `snapshot -i -u` so the actual destination URLs are included. Follow those URLs or click the result ref. Do not guess documentation paths or chase a loosely related article because it shares product keywords.
2. On a relevant public article, load `skill(name="agent-browser", resource="scripts/extract-page.js")` once. Pass the complete returned JavaScript to a single `agent-browser --session trinity-<runtime-session-id> --cdp <endpoint> --pin-tab --json eval '<JavaScript>'` invocation. Use the configured connection mode; omit CDP flags only for an explicitly managed browser. The provided script uses double-quoted strings and can be enclosed in shell single quotes. It reads the current DOM without network requests or page changes and returns bounded article text, title, observed URL, publication metadata (or null), links, and a truncation flag. Do not replace it with an object containing invented evidence. Use it on public research pages only; do not collect private account pages or credentials.
3. Read the extracted article and relevant links together. A missing publication date remains unknown; do not search sidebars/comments repeatedly for a plausible date. If truncated, scope the next read to the missing section with `get text <selector>` or `read --filter <heading>`, and distinguish that additional observation from the structured excerpt.
4. Batch useful findings into `research(action="record", notes=...)`: each finding has a claim, relation (`supports`, `contradicts`, or `context`), and sources containing the exact observed URL and a verbatim passage from its `text`; the extraction call ID is optional and is filled in from the observed results. Keep unresolved questions explicit. Update notes after useful evidence or a strategy change, not after every browser action. `research(action="status")` recovers the notes after restart. Quotes are checked against successful extraction results; matching text does not establish that your interpretation or the website is correct.
5. Continue only to close a material evidence gap or resolve conflicting sources. Prefer the primary announcement or product documentation linked by a source. A repeated observation without useful new evidence should prompt a different source/read method or a conclusion with uncertainty. Runtime repeated-output guidance is advisory; a legitimate unchanged page is not a failure.
6. Answer once the evidence permits a useful conclusion. State what is confirmed, what is inferred, and what you could not verify. Cite actual URLs. Do not turn absence of an announcement into a claim that no plans exist. Set `readyToAnswer` in the notes when appropriate; it is your assessment, not an automatic success signal. Include important findings and sources in the final answer because internal tool notes are omitted from subsequent completed-turn context.

If a citation is rejected, inspect the offending URL, quote, observed source list and excerpt in the error. Correct that citation (including punctuation and redirected URL/query parameters), or omit the unsupported finding. Successful extractions anywhere in the current turn remain usable. Do not reopen unrelated pages or repeatedly resubmit the same rejected notes. In the final answer, discuss the user's question and evidence limits; omit internal note bookkeeping and speculation about tool implementation. A rejected quote is not evidence of a validator bug.

The CLI also supports `read --json --max-output 24000` without a URL to read the current rendered tab, and `read --filter <heading>` for a focused section. Use these when ordinary reading is sufficient; structured research-note citations use the extractor above. An explicit URL to `read` uses HTTP fetching and may not share the current tab authentication or rendering. Do not use a search engine AI overview as primary evidence.

## Work reliably

- Inspect a fresh snapshot before choosing references such as `@e1`. References may change after navigation, interaction, or page updates; refresh snapshots instead of guessing selectors.
- Wait for the relevant visible state using the CLI's documented wait commands. Inspect after each meaningful interaction. Keep reads focused to avoid filling context with entire pages.
- Prefer standalone CLI commands with `--max-output 24000` to bound observations. Prefix permissions also accept a single bounded stdin `head` or `tail` filter, such as `| head -120`, with optional stderr-to-stdout merging (`2>&1`); substitutions, file redirects, file arguments to filters and other compound commands require approval. Use scoped reads and the extractor for article text; truncating the top of an accessibility tree can omit the whole article.
- For research, `snapshot -i` lists interactive elements and omits most article text. Use the documented `get text` command on the article/main element (check CLI help for syntax), or a scoped non-interactive snapshot, to read the actual evidence. Do not infer absence of a feature from an empty filtered list of links. Use the research workflow above for evidence gathering and stopping decisions.
- For research, open primary sources, check dates and the actual page content, and cite the page URLs in the response. Distinguish retrieved facts from inference. Search snippets alone are insufficient evidence.
- For UI work, inspect the actual app and relevant states. Use screenshots when visual layout matters. Do not submit forms, create records, send messages, change accounts, or perform purchases without authority from the task and the runtime approval policy.
- Existing sandbox, network, authentication, and tool permission rules apply. Skill loading does not grant additional execution rights. Do not expose cookies, credentials, or private page content in logs or reports.
- For a browser launched by this task, close its named session when finished. For a user-owned CDP browser, preserve Chrome and existing user tabs; do not issue `close`, `close --all`, or terminate browser processes as routine cleanup. Close only a tab created by the task if cleanup is requested. Report actual limitations if the CLI, browser binaries, authentication, or permitted network access are missing. Do not install or upgrade dependencies silently.

Use `agent-browser skills list` to discover supplementary official CLI skills and `agent-browser skills get <name>` to read them when needed.
