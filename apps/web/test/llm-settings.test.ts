// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpClient } from '@trinity-harness/client-acp';
import type { LlmProviderSettingsResponse } from '@trinity-harness/shared';
import { LlmAdministration, LlmSessionSettings, knownModelDefaults } from '../src/llm-settings';

let root: Root, container: HTMLDivElement, client: AcpClient;
const providerId = crypto.randomUUID(),
  modelId = crypto.randomUUID();
const provider = {
  id: providerId,
  name: 'Kimi Code China',
  adapter: 'openai' as const,
  endpoint: 'https://api.kimi.com/coding/v1',
  enabled: true,
};
const model = {
  id: modelId,
  connectionId: providerId,
  name: 'Kimi',
  modelId: 'k3-256k',
  pricingKey: 'unpriced',
  enabled: true,
  contextTokens: 262144,
  outputTokens: 8192,
  capabilities: { tools: true, images: false, files: false, reasoning: true },
  settings: { reasoningEffort: 'high' as const },
};
const state: LlmProviderSettingsResponse = {
  version: 0,
  settings: {
    providers: [provider],
    models: [],
    routing: { defaultModel: null, automaticFallback: false, fallbackModels: [] },
  },
  credentials: [],
  migrationRequired: false,
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => computed(element));
  client = new AcpClient();
  vi.spyOn(client, 'getLlmProviders').mockResolvedValue(structuredClone(state));
  vi.spyOn(client, 'saveLlmProviders').mockImplementation(async (_version, settings) => ({
    ...state,
    version: 1,
    settings,
    credentials: [{ providerId, configured: true }],
  }));
  vi.spyOn(client, 'getLlmModels').mockResolvedValue({
    available: true,
    models: [{ ...model, providerName: provider.name }],
    defaultModel: { providerId, modelId: model.modelId },
    canTune: false,
  });
  vi.spyOn(client, 'getLlmSessionSettings').mockResolvedValue({
    expectedLastSeq: 5,
    settings: null,
  });
  vi.spyOn(client, 'setLlmSessionSettings').mockResolvedValue();
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
async function administration(): Promise<void> {
  await act(async () =>
    root.render(
      createElement(App, null, createElement(LlmAdministration, { client, onClose: vi.fn() })),
    ),
  );
}

describe('direct provider and model settings', () => {
  it('saves inline connection credentials without models, defaults or profile creation', async () => {
    await administration();
    await click(button('Edit'));
    expect(button('Add API key')).toBeUndefined();
    expect(button('Replace key')).toBeUndefined();
    const field = document.querySelector<HTMLInputElement>(
      'input[aria-label="API key for Kimi Code China"]',
    )!;
    await input(field, 'private-key');
    await click(button('Save connection'));
    expect(client.saveLlmProviders).toHaveBeenCalledWith(
      0,
      state.settings,
      [{ providerId, secret: 'private-key' }],
      expect.any(String),
    );
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="API key for Kimi Code China"]')
        ?.value ?? '',
    ).toBe('');
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });
  it('preserves keys after rejection and reuses the operation ID when retrying unchanged input', async () => {
    vi.mocked(client.saveLlmProviders).mockRejectedValueOnce(new Error('Save unavailable'));
    await administration();
    await click(button('Edit'));
    const field = document.querySelector<HTMLInputElement>(
      'input[aria-label="API key for Kimi Code China"]',
    )!;
    await input(field, 'private-key');
    await click(button('Save connection'));
    expect(field.value).toBe('private-key');
    expect(document.body.textContent).toContain('Save unavailable');
    await click(button('Save connection'));
    expect(vi.mocked(client.saveLlmProviders).mock.calls[0]?.[3]).toBe(
      vi.mocked(client.saveLlmProviders).mock.calls[1]?.[3],
    );
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="API key for Kimi Code China"]')
        ?.value ?? '',
    ).toBe('');
  });
  it('leaves the current key untouched when saving a blank key field', async () => {
    vi.mocked(client.getLlmProviders).mockResolvedValue({
      ...structuredClone(state),
      credentials: [{ providerId, configured: true }],
    });
    await administration();
    await click(button('Edit'));
    await input(
      document.querySelector<HTMLInputElement>('input[value="Kimi Code China"]')!,
      'Personal Kimi',
    );
    await click(button('Save connection'));
    expect(vi.mocked(client.saveLlmProviders).mock.calls[0]?.[2]).toEqual([]);
  });
  it('shows a connection list with CRUD actions and no editing fields until opened', async () => {
    await administration();
    expect(button('Add connection')).toBeTruthy();
    expect(button('Edit')).toBeTruthy();
    expect(button('Delete')).toBeTruthy();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    await click(button('Add connection'));
    expect(document.body.textContent).toContain('Save connection');
    expect(document.querySelector('input[type="password"]')).toBeTruthy();
    expect(client.saveLlmProviders).not.toHaveBeenCalled();
  });
  it('cancels a new connection without saving it or leaving its key in the page', async () => {
    await administration();
    await click(button('Add connection'));
    const field = document.querySelector<HTMLInputElement>('input[type="password"]')!;
    await input(field, 'discarded-key');
    await click(button('Cancel'));
    expect(client.saveLlmProviders).not.toHaveBeenCalled();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(button('Edit')).toBeTruthy();
  });
  it('deletes only the selected connection and clears its routing references', async () => {
    vi.mocked(client.getLlmProviders).mockResolvedValue({
      ...structuredClone(state),
      settings: {
        ...structuredClone(state.settings),
        models: [model],
        routing: {
          defaultModel: { providerId, modelId: model.modelId },
          automaticFallback: false,
          fallbackModels: [],
        },
      },
      credentials: [{ providerId, configured: true }],
    });
    await administration();
    await click(button('Delete'));
    await click(button('OK'));
    expect(vi.mocked(client.saveLlmProviders).mock.calls[0]?.[1]).toEqual({
      providers: [],
      models: [],
      routing: { defaultModel: null, automaticFallback: false, fallbackModels: [] },
    });
  });
  it.each([
    ['MiniMax-M3.1-Flash', true, 1000000],
    ['Custom model', false, 32768],
  ] as const)(
    'applies known defaults when entering %s without assuming unknown capabilities',
    async (modelId, tools, contextTokens) => {
      vi.mocked(client.getLlmProviders).mockResolvedValue({
        ...structuredClone(state),
        settings: {
          ...structuredClone(state.settings),
          providers: [
            {
              ...provider,
              name: 'MiniMax',
              adapter: 'anthropic',
              endpoint: 'https://api.minimax.cn/anthropic/v1',
            },
          ],
        },
        credentials: [{ providerId, configured: true }],
      });
      await administration();
      await click(button('Edit'));
      await click(button('Add model'));
      await input(
        document.querySelector<HTMLInputElement>('[aria-label="Model for MiniMax"]')!,
        modelId,
      );
      await click(button('Save connection'));
      expect(vi.mocked(client.saveLlmProviders).mock.calls[0]?.[1].models[0]).toMatchObject({
        modelId,
        contextTokens,
        capabilities: { tools, reasoning: tools },
      });
    },
  );
  it('lets Members follow the default directly without advanced controls', async () => {
    await act(async () =>
      root.render(
        createElement(LlmSessionSettings, { client, sessionId: 'session', readOnly: false }),
      ),
    );
    expect(document.body.textContent).toContain('Default · k3-256k');
    expect(document.body.textContent).not.toContain('Advanced settings');
    await click(button('Save model'));
    expect(client.setLlmSessionSettings).toHaveBeenCalledWith('session', 5, {
      followDefault: true,
    });
  });
  it('keeps composer controls closed until clicked and discards unapplied edits', async () => {
    vi.mocked(client.getLlmModels).mockResolvedValue({
      available: true,
      canTune: true,
      defaultModel: { providerId, modelId: model.modelId },
      models: [{ ...model, providerName: provider.name, adapter: 'openai' }],
    });
    await act(async () =>
      root.render(
        createElement(LlmSessionSettings, {
          client,
          sessionId: 'session',
          readOnly: false,
          compact: true,
        }),
      ),
    );
    expect(document.querySelector('[aria-label="AI model"]')).toBeNull();
    const trigger = document.querySelector('[aria-label="Model and reasoning settings"]')!;
    await click(trigger);
    expect(document.querySelector('[aria-label="Session reasoning effort"]')).toBeTruthy();
    await act(async () => {
      document
        .querySelector('[aria-label="Session reasoning effort"]')!
        .closest('.ant-select')!
        .querySelector('.ant-select-selector')!
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await click(document.querySelector('.ant-select-item-option[title="high"]'));
    expect(client.setLlmSessionSettings).not.toHaveBeenCalled();
    await click(trigger);
    await click(trigger);
    expect(
      document.querySelector('[aria-label="Session reasoning effort"]')!.closest('.ant-select')!
        .textContent,
    ).toContain('Model default');
    await click(button('Apply'));
    expect(client.setLlmSessionSettings).toHaveBeenCalledWith('session', 5, {
      followDefault: true,
    });
  });
  it('applies reasoning with the selected model and preserves drafts on save failure', async () => {
    vi.mocked(client.getLlmModels).mockResolvedValue({
      available: true,
      canTune: true,
      defaultModel: { providerId, modelId: model.modelId },
      models: [{ ...model, providerName: provider.name, adapter: 'openai' }],
    });
    vi.mocked(client.setLlmSessionSettings).mockRejectedValueOnce(new Error('Save unavailable'));
    await act(async () =>
      root.render(
        createElement(LlmSessionSettings, {
          client,
          sessionId: 'session',
          readOnly: false,
          compact: true,
        }),
      ),
    );
    await click(document.querySelector('[aria-label="Model and reasoning settings"]'));
    await act(async () => {
      document
        .querySelector('[aria-label="Session reasoning effort"]')!
        .closest('.ant-select')!
        .querySelector('.ant-select-selector')!
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await click(document.querySelector('.ant-select-item-option[title="high"]'));
    await click(button('Apply'));
    expect(client.setLlmSessionSettings).toHaveBeenCalledWith('session', 5, {
      followDefault: true,
      reasoningEffort: 'high',
    });
    expect(document.body.textContent).toContain('Save unavailable');
    expect(
      document
        .querySelector('[aria-label="Model and reasoning settings"]')!
        .getAttribute('aria-expanded'),
    ).toBe('true');
  });
  it('refreshes the event sequence before saving after ordinary chat activity', async () => {
    await act(async () =>
      root.render(
        createElement(LlmSessionSettings, {
          client,
          sessionId: 'session',
          readOnly: false,
          compact: true,
        }),
      ),
    );
    vi.mocked(client.getLlmSessionSettings).mockResolvedValue({
      expectedLastSeq: 19,
      settings: { followDefault: true },
    });
    await click(document.querySelector('[aria-label="Model and reasoning settings"]'));
    await click(button('Apply'));
    expect(client.setLlmSessionSettings).toHaveBeenCalledWith('session', 19, {
      followDefault: true,
    });
  });
  it('refuses to overwrite a changed model selection discovered during save', async () => {
    await act(async () =>
      root.render(
        createElement(LlmSessionSettings, {
          client,
          sessionId: 'session',
          readOnly: false,
          compact: true,
        }),
      ),
    );
    vi.mocked(client.getLlmSessionSettings).mockResolvedValue({
      expectedLastSeq: 19,
      settings: { model: { providerId, modelId: model.modelId } },
    });
    const trigger = document.querySelector('[aria-label="Model and reasoning settings"]')!;
    await click(trigger);
    await click(button('Apply'));
    expect(client.setLlmSessionSettings).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Model selection changed elsewhere');
    await click(trigger);
    await click(trigger);
    expect(document.querySelector('.ant-select-selection-item')?.textContent).toContain(
      `${provider.name} / ${model.modelId}`,
    );
  });
  it('stages new Chat settings without creating a session or writing to the server', async () => {
    const onDraftChange = vi.fn();
    await act(async () =>
      root.render(
        createElement(LlmSessionSettings, {
          client,
          readOnly: false,
          compact: true,
          onDraftChange,
        }),
      ),
    );
    await click(document.querySelector('[aria-label="Model and reasoning settings"]'));
    await click(button('Apply'));
    expect(onDraftChange).toHaveBeenCalledWith({ followDefault: true });
    expect(client.getLlmSessionSettings).not.toHaveBeenCalled();
    expect(client.setLlmSessionSettings).not.toHaveBeenCalled();
  });
  it.each(['openai', 'anthropic'] as const)(
    'keeps the %s composer free of numeric tuning and clears legacy overrides on Apply',
    async (adapter) => {
      vi.mocked(client.getLlmModels).mockResolvedValue({
        available: true,
        canTune: true,
        defaultModel: { providerId, modelId: model.modelId },
        models: [{ ...model, providerName: provider.name, adapter }],
      });
      vi.mocked(client.getLlmSessionSettings).mockResolvedValue({
        expectedLastSeq: 5,
        settings: {
          followDefault: true,
          reasoningBudgetTokens: 4096,
          maxOutputTokens: 8192,
          pinned: true,
        },
      });
      await act(async () =>
        root.render(
          createElement(LlmSessionSettings, {
            client,
            sessionId: 'session',
            readOnly: false,
            compact: true,
          }),
        ),
      );
      await click(document.querySelector('[aria-label="Model and reasoning settings"]'));
      expect(document.querySelector('[role="spinbutton"]')).toBeNull();
      expect(document.querySelector('[role="switch"]')).toBeNull();
      expect(document.body.textContent).not.toMatch(
        /budget|tokens|Advanced settings|Reset advanced|fallback/i,
      );
      expect(!!document.querySelector('[aria-label="Session reasoning effort"]')).toBe(
        adapter === 'openai',
      );
      await click(button('Apply'));
      expect(client.setLlmSessionSettings).toHaveBeenCalledWith('session', 5, {
        followDefault: true,
      });
    },
  );
  it('keeps Viewer controls read-only', async () => {
    await act(async () =>
      root.render(
        createElement(LlmSessionSettings, { client, sessionId: 'session', readOnly: true }),
      ),
    );
    expect(button('Save model')).toBeUndefined();
    expect(document.querySelector<HTMLInputElement>('[role="combobox"]')?.disabled).toBe(true);
  });
  it('requires explicit model selection for old profile settings without rewriting history', async () => {
    vi.mocked(client.getLlmSessionSettings).mockResolvedValue({
      expectedLastSeq: 9,
      settings: { profileId: crypto.randomUUID() },
    });
    await act(async () =>
      root.render(
        createElement(LlmSessionSettings, { client, sessionId: 'session', readOnly: false }),
      ),
    );
    expect(document.body.textContent).toContain('Choose a model to replace');
    expect(button('Save model')?.disabled).toBe(true);
    expect(client.setLlmSessionSettings).not.toHaveBeenCalled();
  });
  it('preserves composer draft and focus while model settings load', async () => {
    let resolve!: (value: Awaited<ReturnType<AcpClient['getLlmModels']>>) => void;
    vi.mocked(client.getLlmModels).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await act(async () =>
      root.render(
        createElement(
          'div',
          null,
          createElement('textarea', { defaultValue: 'Unsent draft' }),
          createElement(LlmSessionSettings, { client, sessionId: 'session', readOnly: false }),
        ),
      ),
    );
    const composer = document.querySelector('textarea')!;
    composer.focus();
    await act(async () =>
      resolve({ available: true, canTune: false, models: [], defaultModel: null }),
    );
    expect(document.querySelector('textarea')).toBe(composer);
    expect(document.activeElement).toBe(composer);
    expect(composer.value).toBe('Unsent draft');
  });
});

describe('known model defaults', () => {
  it('supplies MiniMax Flash tool/reasoning metadata without enabling unknown model capabilities', () => {
    const miniMax = {
      ...provider,
      adapter: 'anthropic' as const,
      endpoint: 'https://api.minimax.cn/anthropic/v1',
    };
    expect(knownModelDefaults(miniMax, 'MiniMax-M3.1-Flash')).toMatchObject({
      contextTokens: 1000000,
      capabilities: { tools: true, reasoning: true, files: false, images: false },
      settings: { thinkingType: 'adaptive' },
    });
    expect(knownModelDefaults(miniMax, 'Unknown model')).toBeUndefined();
    expect(
      knownModelDefaults(
        { ...miniMax, endpoint: 'https://custom.example/v1' },
        'MiniMax-M3.1-Flash',
      ),
    ).toBeUndefined();
    expect(knownModelDefaults(provider, 'k3-256k')).toMatchObject({
      contextTokens: 262144,
      capabilities: { tools: true, reasoning: true },
    });
  });
});
