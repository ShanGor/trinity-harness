import { memo, useState, type ReactElement } from 'react';
import { Button, Drawer, Typography } from 'antd';
import type { AnswerCitation } from '@trinity-harness/shared';

/** The final answer's source summary and evidence drawer, following Trinity's format. */
export const AnswerCitationList = memo(function AnswerCitationList({
  citations,
}: {
  citations?: AnswerCitation[];
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  if (!citations?.length) return null;
  const sources = new Set(
    citations.flatMap((citation) =>
      citation.kind === 'research_claim'
        ? citation.sourceUrls
        : [citation.kind === 'web_source' ? citation.url : citation.path],
    ),
  );
  return (
    <section className="answer-sources" aria-label="Sources">
      <Typography.Text type="secondary">
        Sources · {citations.length} {citations.length === 1 ? 'citation' : 'citations'} ·{' '}
        {sources.size} {sources.size === 1 ? 'source' : 'sources'}
      </Typography.Text>
      <Button type="text" size="small" onClick={() => setOpen(true)}>
        View evidence
      </Button>
      <Drawer title="Evidence" open={open} onClose={() => setOpen(false)} size="large">
        <ol className="answer-evidence">
          {citations.map((citation, index) => {
            const url =
              citation.kind === 'web_source'
                ? citation.url
                : citation.kind === 'research_claim'
                  ? citation.sourceUrls[0]
                  : undefined;
            return (
              <li key={`${citation.kind}-${citation.callId}-${index}`}>
                <div>
                  {url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer">
                      {citation.label}
                    </a>
                  ) : (
                    <span>{citation.label}</span>
                  )}
                </div>
                <Typography.Text type="secondary">
                  {citation.kind === 'workspace_reference'
                    ? 'Workspace reference'
                    : citation.kind === 'research_claim'
                      ? 'Research claim'
                      : 'Web source'}
                </Typography.Text>
                {citation.kind === 'workspace_reference' && (
                  <div>
                    {citation.path}
                    {citation.lineNo ? `:${citation.lineNo}` : ''}
                  </div>
                )}
                {citation.detail && <blockquote>{citation.detail}</blockquote>}
                {citation.kind === 'research_claim' && (
                  <ul>
                    {citation.sourceUrls.map((source) => (
                      <li key={source}>
                        <a href={source} target="_blank" rel="noopener noreferrer">
                          {source}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      </Drawer>
    </section>
  );
});
