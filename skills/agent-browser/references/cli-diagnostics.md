# Operator CLI diagnostics

Load this resource only for an explicit operator request to troubleshoot the underlying agent-browser CLI or its CDP connection. Ordinary browsing uses the advertised `browser` tool. These instructions grant no execution permission; Sandbox and approval rules still apply.

1. Check the executable with the standalone command `agent-browser --version`.
2. Read the installed version's guidance with `agent-browser skills get core`. If unavailable, inspect `agent-browser --help` and the relevant subcommand help. Do not install or upgrade software without task authority.
3. Obtain the exact debugging endpoint from the operator. Use the current runtime session identifier from the skill catalog. Diagnostic commands that touch Chrome must include `--session trinity-<runtime-session-id> --cdp <endpoint> --pin-tab` together; a default-session connection does not transfer to a named session.
4. Verify the attachment and inspect only the task-owned tab:

```sh
agent-browser --session trinity-<runtime-session-id> --cdp <endpoint> --pin-tab get cdp-url
agent-browser --session trinity-<runtime-session-id> --cdp <endpoint> --pin-tab get url
agent-browser --session trinity-<runtime-session-id> --cdp <endpoint> --pin-tab snapshot -i
```

If the named session is attached to a different browser, explicitly reattach with `agent-browser --session trinity-<runtime-session-id> --pin-tab connect <endpoint>` and verify `get cdp-url`. Never switch to an unrelated user tab to repair a missing binding. If the endpoint is unreachable, report the error; do not drop the endpoint, launch managed Chrome, kill Chrome or close the user's browser. A navigation timeout may leave a partially loaded page; inspect its current URL and snapshot before retrying effects.

Keep diagnostic output bounded and scoped to the requested issue. Avoid fixed sleeps, shell command loops and private account content. Preserve user-owned Chrome and its tabs. Resume normal reading and interaction through `browser` after diagnostics.
