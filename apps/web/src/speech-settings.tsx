import { useEffect, useState, type ReactElement } from 'react';
import { Alert, Button, Input, Modal, Space, Typography } from 'antd';
import type { AcpClient } from '@trinity-harness/client-acp';
import { DEFAULT_SPEECH_STYLE, speechPreferencesSchema } from '@trinity-harness/shared';

/** Account settings apply to manual playback and the next phone call. */
export function SpeechSettingsModal({
  client,
  onClose,
}: {
  client: AcpClient;
  onClose(): void;
}): ReactElement {
  const [voiceStyle, setVoiceStyle] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setLoaded(false);
    setError('');
    void client
      .getSpeechPreferences(abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) {
          setVoiceStyle(value.voiceStyle);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setError('Could not load voice settings. Please retry.');
      });
    return () => abort.abort();
  }, [client, reload]);
  const save = async (): Promise<void> => {
    const preferences = speechPreferencesSchema.safeParse({ voiceStyle });
    if (!preferences.success) return;
    setSaving(true);
    setError('');
    try {
      await client.setSpeechPreferences(preferences.data);
      onClose();
    } catch {
      // A lost reply may have committed; reload before another save.
      setLoaded(false);
      setError('Could not confirm the save. Reload to check your current voice settings.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open
      title="Voice settings"
      onCancel={onClose}
      footer={
        <Space>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="primary"
            loading={saving}
            disabled={!loaded || !speechPreferencesSchema.safeParse({ voiceStyle }).success}
            onClick={() => void save()}
          >
            Save voice
          </Button>
        </Space>
      }
    >
      <Typography.Paragraph>
        Used for your message playback and phone calls on all devices. An active call keeps its
        current voice until you reconnect.
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary">
        Default speaker: the Peach voice clone from the uploaded reference recording. Delivery uses
        clear standard Mandarin and a steady, moderate pace. Describe your preferred speaking style,
        accent and pace below; the default speaker remains Peach.
      </Typography.Paragraph>
      {error && (
        <Alert
          type="error"
          message={error}
          action={<Button onClick={() => setReload((value) => value + 1)}>Reload</Button>}
        />
      )}
      <label htmlFor="speech-voice-style">Voice style</label>
      <Input.TextArea
        id="speech-voice-style"
        value={voiceStyle}
        disabled={!loaded || saving}
        onChange={(event) => setVoiceStyle(event.target.value)}
        maxLength={1000}
        showCount
        autoSize={{ minRows: 5, maxRows: 10 }}
      />
      <Button disabled={!loaded || saving} onClick={() => setVoiceStyle(DEFAULT_SPEECH_STYLE)}>
        Restore default
      </Button>
    </Modal>
  );
}
