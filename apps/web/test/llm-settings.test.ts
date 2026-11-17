// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpClient } from '@trinity-harness/client-acp';
import type { LlmConfigurationState } from '@trinity-harness/shared';
import { LlmAdministration, LlmSessionSettings } from '../src/llm-settings';

let root: Root, container: HTMLDivElement, client: AcpClient;
const profileId = crypto.randomUUID(),
  sessionId = crypto.randomUUID(),
  deploymentId = crypto.randomUUID(),
  connectionId = crypto.randomUUID();
const configuration = {
  connections: [
    {
      id: connectionId,
      name: 'Example provider',
      adapter: 'openai' as const,
      endpoint: 'https://example.com/v1',
      enabled: true,
    },
  ],
  deployments: [
    {
      id: deploymentId,
      connectionId,
      name: 'Example model',
      modelId: 'example',
      pricingKey: 'test/model',
      enabled: true,
      contextTokens: 10000,
      outputTokens: 1000,
      capabilities: { tools: true, images: false, files: false, reasoning: false },
      settings: {},
    },
  ],
  profiles: [
    {
      id: profileId,
      name: 'Assistant',
      primary: deploymentId,
      backups: [],
      mode: 'manual' as const,
      allowedDeployments: [deploymentId],
      maxOutputTokens: 1000,
    },
  ],
  defaultProfileId: profileId,
};
const state: LlmConfigurationState = {
  version: 1,
  activeRevision: 1,
  source: 'database',
  draft: configuration,
  published: configuration,
  credentials: [],
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => computed(element));
  client = new AcpClient();
  vi.spyOn(client, 'getLlmConfiguration').mockResolvedValue(structuredClone(state));
  vi.spyOn(client, 'getLlmProfiles').mockResolvedValue({
    available: true,
    defaultProfileId: profileId,
    canTune: false,
    profiles: [
      {
        id: profileId,
        name: 'Assistant',
        mode: 'manual',
        maxOutputTokens: 1000,
        deployments: [{ id: deploymentId, name: 'Example model' }],
      },
    ],
  });
  vi.spyOn(client, 'getLlmSessionSettings').mockResolvedValue({
    expectedLastSeq: 5,
    settings: { profileId },
  });
  vi.spyOn(client, 'setLlmSessionSettings').mockResolvedValue();
  vi.spyOn(client, 'replaceLlmCredential').mockResolvedValue(state);
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
function button(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((element) => element.textContent === text);
}
async function click(element: Element | null | undefined): Promise<void> {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}
async function input(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('AI settings forms', () => {
  it('lets Members select approved profiles without exposing advanced controls', async () => {
    await act(async () =>
      root.render(createElement(LlmSessionSettings, { client, sessionId, readOnly: false })),
    );
    expect(document.body.textContent).not.toContain('Advanced settings');
    await click(button('Save AI settings'));
    expect(client.setLlmSessionSettings).toHaveBeenCalledWith(sessionId, 5, { profileId });
  });
  it('exposes bounded Expert controls and keeps the draft after a rejected save', async () => {
    vi.mocked(client.getLlmProfiles).mockResolvedValue({
      available: true,
      canTune: true,
      profiles: [
        {
          id: profileId,
          name: 'Assistant',
          mode: 'manual',
          maxOutputTokens: 1000,
          deployments: [{ id: deploymentId, name: 'Example model' }],
        },
      ],
    });
    vi.mocked(client.setLlmSessionSettings).mockRejectedValue(
      new Error('Configuration changed; reload settings'),
    );
    await act(async () =>
      root.render(createElement(LlmSessionSettings, { client, sessionId, readOnly: false })),
    );
    expect(document.body.textContent).toContain('Advanced settings');
    const output = document.querySelector<HTMLInputElement>(
      'input[aria-label="Maximum session output tokens"]',
    )!;
    expect(output.getAttribute('aria-valuemax')).toBe('1000');
    await input(output, '900');
    await click(button('Save AI settings'));
    expect(document.body.textContent).toContain('Configuration changed');
    expect(output.value).toBe('900');
    await click(button('Reset advanced settings'));
    expect(output.value).toBe('');
  });
  it('keeps Viewer controls read-only', async () => {
    await act(async () =>
      root.render(createElement(LlmSessionSettings, { client, sessionId, readOnly: true })),
    );
    expect(button('Save AI settings')).toBeUndefined();
    expect(document.querySelector<HTMLInputElement>('[role="combobox"]')?.disabled).toBe(true);
  });
  it('preserves the conversation composer node and focus as settings load', async () => {
    let resolve!: (value: Awaited<ReturnType<AcpClient['getLlmProfiles']>>) => void;
    vi.mocked(client.getLlmProfiles).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await act(async () =>
      root.render(
        createElement(
          'div',
          null,
          createElement('textarea', {
            defaultValue: 'Unsent draft',
            'aria-label': 'Conversation draft',
          }),
          createElement(LlmSessionSettings, { client, sessionId, readOnly: false }),
        ),
      ),
    );
    const composer = document.querySelector('textarea')!;
    composer.focus();
    await act(async () =>
      resolve({
        available: true,
        canTune: false,
        profiles: [{ id: profileId, name: 'Assistant', mode: 'manual', maxOutputTokens: 1000 }],
      }),
    );
    expect(document.querySelector('textarea')).toBe(composer);
    expect(document.activeElement).toBe(composer);
    expect(composer.value).toBe('Unsent draft');
  });
  it('clears the write-only key immediately after submission, including failure', async () => {
    vi.mocked(client.replaceLlmCredential).mockRejectedValue(new Error('Save unavailable'));
    await act(async () =>
      root.render(
        createElement(App, null, createElement(LlmAdministration, { client, onClose: vi.fn() })),
      ),
    );
    await click(button('Replace key'));
    const field = document.querySelector<HTMLInputElement>('input[aria-label="Provider API key"]')!;
    await input(field, 'private-provider-key');
    await click(button('OK'));
    expect(client.replaceLlmCredential).toHaveBeenCalledWith(
      connectionId,
      1,
      'private-provider-key',
    );
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="Provider API key"]')?.value ?? '',
    ).toBe('');
    expect(document.body.textContent).toContain('Save unavailable');
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });
});
