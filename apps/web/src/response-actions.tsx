import { memo, useState, type ReactElement } from 'react';
import { Button, Tooltip } from 'antd';

function ActionIcon({ name }: { name: 'copy' | 'check' | 'like' | 'dislike' }): ReactElement {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {name === 'copy' ? (
        <>
          <rect x="8" y="8" width="12" height="12" rx="2" />
          <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
        </>
      ) : name === 'check' ? (
        <path d="m5 12 4 4L19 6" />
      ) : (
        <g transform={name === 'dislike' ? 'rotate(180 12 12)' : undefined}>
          <path d="M7 10h3l3-7a3 3 0 0 1 3 3l-1 4h4a2 2 0 0 1 2 2l-2 7a2 2 0 0 1-2 2H7z" />
          <rect x="3" y="10" width="4" height="11" rx="1" />
        </g>
      )}
    </svg>
  );
}

const popupContainer = (trigger: HTMLElement): HTMLElement => trigger.parentElement ?? trigger;

export const ResponseActions = memo(function ResponseActions({
  content,
}: {
  content: string;
}): ReactElement {
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const [rating, setRating] = useState<'like' | 'dislike' | null>(null);

  const copy = async (): Promise<void> => {
    if (!navigator.clipboard?.writeText) {
      setCopyState('failed');
      return;
    }
    setCopyState('copying');
    try {
      await navigator.clipboard.writeText(content);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <div className="response-actions" role="group" aria-label="Response actions">
      <Tooltip
        getPopupContainer={popupContainer}
        destroyOnHidden
        title={copyState === 'copied' ? 'Copied' : 'Copy response'}
      >
        <Button
          type="text"
          aria-label="Copy response"
          disabled={copyState === 'copying'}
          onClick={() => void copy()}
          icon={<ActionIcon name={copyState === 'copied' ? 'check' : 'copy'} />}
        />
      </Tooltip>
      <span className="response-action-divider" aria-hidden="true" />
      <Tooltip getPopupContainer={popupContainer} destroyOnHidden title="Helpful">
        <Button
          type="text"
          aria-label="Like response"
          aria-pressed={rating === 'like'}
          onClick={() => setRating((previous) => (previous === 'like' ? null : 'like'))}
          icon={<ActionIcon name="like" />}
        />
      </Tooltip>
      <Tooltip getPopupContainer={popupContainer} destroyOnHidden title="Not helpful">
        <Button
          type="text"
          aria-label="Dislike response"
          aria-pressed={rating === 'dislike'}
          onClick={() => setRating((previous) => (previous === 'dislike' ? null : 'dislike'))}
          icon={<ActionIcon name="dislike" />}
        />
      </Tooltip>
      <span className="response-action-status" role="status">
        {copyState === 'copied'
          ? 'Copied'
          : copyState === 'failed'
            ? 'Could not copy. Select the response and copy manually.'
            : ''}
      </span>
    </div>
  );
});
