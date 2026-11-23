# Personal calendar and proactive assistance

Approved scope: 2026-11-23. The personal assistant maintains appointments, deadlines,
reminders and authorized scheduled tasks, including Chinese lunar dates. This
document records the requirements and implementation contracts. Delivery evidence
belongs in project-progress.md and production-checklist.md.

## Product requirements

1. An owner-scoped calendar records events, deadlines, reminders and agent tasks.
   Linked reminders and preparation work remain distinct from the commitment.
   Saving a commitment grants no authority to submit, send, purchase or otherwise
   act on the user's behalf.
2. The ordinary personal conversation loop identifies explicit requests, definite
   commitments, deadlines, recurring obligations, corrections and cancellations.
   Explicit unambiguous requests may be saved immediately. Definite inferred
   commitments may be saved when automatic capture is enabled; otherwise create a
   reviewable suggestion. Tentative/hypothetical/quoted/assistant-authored material
   cannot become an active commitment. Ask a focused question for material ambiguity.
3. Automatic capture defaults off. It is an owner preference, not a deployment
   rollout switch or execution grant. Successful writes are acknowledged with exact
   interpreted dates/timezone, original source links and correction/cancel controls.
   Never claim a save before receiving a durable receipt.
4. Support one-off dates, all-day commitments, duration, daily/weekly/monthly/yearly
   recurrence, an optional end date and multiple reminder offsets. Relative dates
   use the originating committed message timestamp and explicit/account timezone.
   Existing events retain their recorded timezone when account preferences change.
5. Chinese lunar dates are first-class input and recurrence rules. Preserve lunar
   year, month, day and leap-month identity, and show their Gregorian equivalent.
   Annual lunar birthdays/anniversaries recur by lunar month/day, never by the
   first converted Gregorian anniversary. The calendar grid can show both dates.
6. Chinese-calendar civil dates use the conventional China/Hong Kong calendar;
   delivery hour uses the item's IANA timezone. Supported conversion years are
   1901–2100. Out-of-range or nonexistent one-off dates are rejected, never guessed.
   Annual leap-month rules explicitly select leap-only, regular-month fallback or
   both occurrences; ordinary months do not silently include their leap counterpart.
   Missing day 30 explicitly skips or uses the month's last day. Defaults are strict
   leap-only and skip. Lunar recurrence supports once/yearly; ordinary daily/weekly
   and Gregorian monthly rules remain available by selecting Gregorian dates.
7. Durably deliver reminders independently of model calls, browser presence and
   VM power state. Store inbox delivery, read/dismiss and obligation completion
   separately. Snooze creates a durable future delivery; quiet hours defer external
   delivery. Expired reminders remain visibly missed instead of firing an old backlog.
8. Updates is always the durable inbox. Closed-app notifications require a configured
   authenticated delivery adapter and user permission; show availability accurately.
   Web Push subscriptions are owner-scoped and revocable; push content contains a
   generic notice and authenticated link, never commitment text. External provider
   delivery and user reading are distinct and do not promise exactly-once delivery.
9. Agent tasks require explicit delegated request text and an owned source workspace.
   Reuse normal Work dispatch, policy/approval checks, quotas and unknown-effect
   recovery. Inferred commitments cannot enable execution. Preserve start time versus
   completion deadline. Existing task missed/overlap policies remain unchanged.
10. Support conversational and UI edits, cancellations, completion, recurrence pause,
    source inspection, suggestion acceptance/dismissal and reminder history. Warn
    about overlapping timed commitments without moving them. Repeated tool-call
    delivery must return the original receipt, not duplicate the commitment.
11. Cancellation or editing invalidates old pending reminders and future work through
    revision fencing. Running work rechecks current authority; completed/uncertain
    effects are never represented as undone. Personal calendar access is tenant and
    owner scoped; team/child/review tasks cannot create personal commitments.
12. Provide agenda and Gregorian month views, lunar labels, all four item types,
    explicit timezone/recurrence previews and owner capture/reminder preferences.
    External calendar synchronization, invitations, shared calendars and automatic
    meeting negotiation remain a separate phase, as agreed in the requirements.

## Architecture

Register Personal Calendar in design §5. `CalendarStore` in contracts defines
versioned owner records, preferences, reminder inbox and reconciliation; the PG
adapter lives in packages/db. Pure Gregorian/Chinese calendar conversion and next
occurrence calculation live beside the shared schemas, with no provider/network
calls. Chinese dates use pinned MIT-licensed lunar-typescript 1.8.7 in both server and
browser; IANA delivery-time conversion uses Intl. Tests compare dates against
Hong Kong Observatory tables, including the 2027 New Year boundary where the
installed ICU Chinese calendar is one day late. No guessed lunar
arithmetic, host-local timezone or VM cron is permitted.

Calendar writes use expected revisions and operation IDs. Append-only calendar
change receipts preserve source provenance and idempotent recovery. Model writes
must reference the current committed original user prompt and exact quote plus the
originating tool-call journal. Revalidate owner, user role, source availability,
capture preference and matching call in the transaction. Original user text remains
source data; model interpretation cannot certify semantic certainty or authority.

Calendar task creation/update and linked schedule writes commit transactionally.
Extend the existing schedule timing union with calendar recurrence; retain existing
once/daily readers. Source Chat/Work workspaces can anchor a calendar task; no manual
Work creation is required for a simple reminder. The existing control-worker
reconciles reminders and schedules; do not introduce a parallel timer service.
Revision changes cancel obsolete pending deliveries and fence queued task dispatch.
Model-visible calendar reads/results use ordinary committed tool pairs; no silent
calendar state is injected into the system prefix or Persona.

Reminder reconciliation uses PG row locks, bounded pages and unique item/revision/
occurrence/offset keys. Restarts and duplicate ticks reconstruct state from PG.
Notifications may be retried safely using durable delivery records; external effects
and agent tasks retain their independent unknown-outcome policy. Quiet hours affect
notifications, never silently shift event dates or work execution times.

## Verification and release

Deterministic tests cover lunar new year, Mid-Autumn, regular/leap months, missing
day 30, lunar year rollover, timezone/DST gaps/folds, recurrence end dates, duplicate
operations, source/owner/role fences, revisions, cancellation, offline recovery,
reminder snooze/dismiss/quiet hours and task dispatch. HTTP tests cover strict input
and unavailable capability. UI tests cover agenda/month, editing, source links,
preferences, suggestions and unchanged chat drafts. Run relevant pnpm test, lint,
typecheck and Web build, plus agent-browser inspection. Generate/review/apply the
migration and replace old readers/writers together before deployment. Real-provider
capture quality and real-device closed-app push acceptance remain explicit gates.

Calendar dispatch aims to materialize due reminders within 60 seconds under healthy
normal capacity; this is not a promise of exact device delivery or task completion.

## Calendar references

- [Hong Kong Observatory Gregorian–Lunar conversion](https://www.hko.gov.hk/en/gts/time/conversion.htm)
- [Hong Kong Observatory calendar explanation](https://www.hko.gov.hk/en/gts/time/calendarinfo.htm)
- [2026 conversion table](https://www.hko.gov.hk/en/gts/time/calendar/pdf/files/2026e.pdf)

The Chinese calendar is lunisolar, with 29/30-day months and leap months. This is
Chinese calendar support, not a generic astronomical moon-phase or Islamic calendar.
