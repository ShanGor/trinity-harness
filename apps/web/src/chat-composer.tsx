import { memo, useEffect, useRef, useState, type ReactElement } from 'react';
import { Sender } from '@ant-design/x';
import { PretextTextArea } from './pretext-textarea';

const senderComponents = { input: PretextTextArea };

export const ChatComposer = memo(function ChatComposer({
  busy,
  draftKey = 'new',
  canQueue = false,
  draftStore,
  draftOwner,
  placeholder = 'Ask anything…',
  resetVersion,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  draftKey?: string;
  canQueue?: boolean;
  draftStore?: Map<string, string>;
  draftOwner?: string;
  placeholder?: string;
  resetVersion: number;
  onSubmit: (text: string) => void | Promise<boolean | void>;
  onCancel: () => void;
}): ReactElement {
  const [input, setInput] = useState('');
  const submitting = useRef(false);
  const drafts = useRef(draftStore ?? new Map<string, string>());
  const currentKey = useRef(draftKey);
  currentKey.current = draftKey;
  useEffect(() => {
    const saved =
      drafts.current.get(draftKey) ??
      (draftOwner ? sessionStorage.getItem(`trinity.draft:${draftOwner}:${draftKey}`) : null) ??
      '';
    drafts.current.set(draftKey, saved);
    setInput(saved);
  }, [draftKey, draftOwner]);

  useEffect(() => {
    setInput('');
  }, [resetVersion]);

  return (
    <Sender
      components={senderComponents}
      value={input}
      onChange={(value) => {
        drafts.current.set(draftKey, value);
        if (draftOwner) sessionStorage.setItem(`trinity.draft:${draftOwner}:${draftKey}`, value);
        setInput(value);
      }}
      onSubmit={(text) => {
        if ((busy && !canQueue) || submitting.current) return;
        submitting.current = true;
        const key = draftKey;
        void Promise.resolve(onSubmit(text))
          .then((accepted) => {
            if (accepted === false) return;
            if (drafts.current.get(key) === text) {
              drafts.current.delete(key);
              if (draftOwner) sessionStorage.removeItem(`trinity.draft:${draftOwner}:${key}`);
            }
            if (currentKey.current === key) setInput((value) => (value === text ? '' : value));
          })
          .finally(() => {
            submitting.current = false;
          });
      }}
      onCancel={onCancel}
      loading={busy && !canQueue}
      placeholder={placeholder}
    />
  );
});
