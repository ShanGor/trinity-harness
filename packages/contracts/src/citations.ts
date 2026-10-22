import { z } from 'zod';

const sourceUrl = z
  .url()
  .max(2000)
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  });
const base = {
  label: z.string().min(1).max(1000),
  detail: z.string().max(1000).optional(),
  callId: z.string().min(1).max(200),
  evidenceSeq: z.number().int().positive(),
  observationId: z.string().max(200).optional(),
  blockId: z.string().max(200).optional(),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().positive().optional(),
  artifactUri: z.string().max(500).optional(),
  capturedAt: z.iso.datetime().optional(),
  /** Committed screenshot provenance; it does not authorize a verbatim text quote. */
  imageUri: z.string().max(500).optional(),
};

/** Grounding categories follow Trinity's Sources / View evidence presentation. */
export const answerCitationSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('web_source'), url: sourceUrl }),
  z.object({
    ...base,
    kind: z.literal('workspace_reference'),
    path: z.string().min(1).max(2000),
    lineNo: z.number().int().positive().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal('research_claim'),
    claimText: z.string().min(1).max(1000),
    sourceUrls: z.array(sourceUrl).min(1).max(3),
  }),
]);
export const answerCitationListSchema = z.array(answerCitationSchema).max(60);
export type AnswerCitation = z.infer<typeof answerCitationSchema>;

/** References remain part of the final answer when it is used as conversation context. */
export function citationContext(citations: readonly AnswerCitation[]): string {
  if (!citations.length) return '';
  return (
    '\n\nSources:\n' +
    citations
      .map((citation, index) => {
        const target =
          citation.kind === 'web_source'
            ? citation.url
            : citation.kind === 'workspace_reference'
              ? citation.path + (citation.lineNo ? `:${citation.lineNo}` : '')
              : citation.sourceUrls.join(', ');
        return `${index + 1}. ${citation.label} — ${target}`;
      })
      .join('\n')
  );
}
