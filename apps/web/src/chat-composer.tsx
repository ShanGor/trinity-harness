import { memo, useEffect, useState, type ReactElement } from 'react';
import { Sender } from '@ant-design/x';
import { PretextTextArea } from './pretext-textarea';

const senderComponents = { input: PretextTextArea };

export const ChatComposer = memo(function ChatComposer({
  busy,
  resetVersion,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  resetVersion: number;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}): ReactElement {
  const [input, setInput] = useState('');

  useEffect(() => {
    setInput('');
  }, [resetVersion]);

  return (
    <Sender
      components={senderComponents}
      value={input}
      onChange={setInput}
      onSubmit={(text) => {
        if (busy) return;
        setInput('');
        onSubmit(text);
      }}
      onCancel={onCancel}
      loading={busy}
      placeholder="Describe a coding task…"
    />
  );
});
