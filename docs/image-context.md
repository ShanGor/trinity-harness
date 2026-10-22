# Image context strategy

Evidence storage and provider input are separate. Image artifacts and event references remain available even when a request can avoid sending duplicate pixels.

## Current behavior

- User attachments remain blob references in the log. The gateway resolves them to native image media parts when constructing a provider request.
- Browser screenshots are captured on demand, optionally cropped, stored as immutable PNG artifacts and delivered with authorized observation receipts. Each screenshot remains bounded to 2048×2048 and 2 MiB. Cumulative screenshot counts and bytes have no turn ceiling.
- `read_observation` on a screenshot observation reattaches the original pixels, including on a later turn. It creates a new authorized delivery while preserving the original capture time and saved status. It does not recapture a changed live page. Text search over an observation does not automatically attach pixels.
- Every referenced blob is resolved and checked before image deduplication. Missing or unauthorized images fail the request; deduplication cannot bypass evidence authorization.
- Within one provider request, images with identical encoded bytes and media type share one pixel attachment at their latest occurrence. Earlier occurrences retain their text, tool metadata and an explicit duplicate-image reference. Distinct images are retained; there is no fixed four-image cap.
- The deduplication set is rebuilt per request. An image seen in an earlier request is still sent when it is part of the current request. A model has no persistent pixel memory between API calls.
- The event log, tool pairs, image artifacts and citation receipts are unchanged. The existing turn projection and compaction control historical context; pixel deduplication does not delete evidence or manufacture observations.
- User uploads retain their original encoding. This change adds no lossy recompression. Browser screenshots already support cropped views; use text extraction for text questions and pixels for relevant visual content.

## Reference comparison

The original Trinity app uses resized image derivatives, on-demand `inspect_image`, a four-image provider-call ceiling and historical artifact deduplication. Its FAQ notes that replacing a previously seen image with a text reference can leave a later request without the pixels needed for fresh visual analysis.

Harness adopts selective visual inspection and duplicate suppression while preserving the unique pixels needed by each request. Deduplication compares encoded bytes, so different encodings of visually identical images are conservatively retained. Mutable remote image URLs are not treated as immutable duplicates. Relevance selection remains with the agent; model context limits still apply.

Reference implementations were inspected read-only: `trinity/backend/src/handlers/turns.rs`, `trinity/backend/src/service/image_processing.rs`, `trinity/backend/src/service/turn_service/providers/openai/request_building.rs`, and `trinity/config/prompts/orchestration/image-inspection-guidance.md`.
