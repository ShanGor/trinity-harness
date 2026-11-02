// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpClient } from '@trinity-harness/client-acp';
import { DEFAULT_SPEECH_STYLE } from '@trinity-harness/shared';
import { SpeechSettingsModal } from '../src/speech-settings';

let root: Root;
let container: HTMLDivElement;
let client: AcpClient;
let close: ReturnType<typeof vi.fn>;
async function render(): Promise<void> {
  await act(async () =>
    root.render(createElement(SpeechSettingsModal, { client, onClose: close })),
  );
}
function button(text: string): HTMLButtonElement {
  return [...document.querySelectorAll('button')].find((item) => item.textContent === text)!;
}
async function click(text: string): Promise<void> {
  await act(async () => button(text).click());
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => computedStyle(element));
  client = new AcpClient();
  vi.spyOn(client, 'getSpeechPreferences').mockResolvedValue({ voiceStyle: '自然温柔的成年女声' });
  vi.spyOn(client, 'setSpeechPreferences').mockImplementation(async (value) => value);
  close = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('account voice settings', () => {
  it('loads, restores the default locally, and persists only on save', async () => {
    await render();
    expect(document.querySelector<HTMLTextAreaElement>('#speech-voice-style')!.value).toBe(
      '自然温柔的成年女声',
    );
    await click('Restore default');
    expect(document.querySelector<HTMLTextAreaElement>('#speech-voice-style')!.value).toBe(
      DEFAULT_SPEECH_STYLE,
    );
    expect(client.setSpeechPreferences).not.toHaveBeenCalled();
    await click('Save voice');
    expect(client.setSpeechPreferences).toHaveBeenCalledExactlyOnceWith({
      voiceStyle: DEFAULT_SPEECH_STYLE,
    });
    expect(close).toHaveBeenCalledOnce();
  });
  it('preserves an unconfirmed save and requires reload before retrying', async () => {
    vi.mocked(client.setSpeechPreferences).mockRejectedValue(new Error('network'));
    await render();
    await click('Save voice');
    expect(close).not.toHaveBeenCalled();
    expect(button('Save voice').disabled).toBe(true);
    expect(document.body.textContent).toContain('Could not confirm the save');
    await click('Reload');
    expect(client.getSpeechPreferences).toHaveBeenCalledTimes(2);
    expect(button('Save voice').disabled).toBe(false);
  });
  it('cannot overwrite preferences after a failed load', async () => {
    vi.mocked(client.getSpeechPreferences).mockRejectedValue(new Error('offline'));
    await render();
    expect(button('Save voice').disabled).toBe(true);
    expect(document.querySelector<HTMLTextAreaElement>('#speech-voice-style')!.disabled).toBe(true);
    expect(document.body.textContent).toContain('Could not load voice settings');
  });
});
