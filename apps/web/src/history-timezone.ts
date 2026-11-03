import { useSyncExternalStore } from 'react';

const key = 'trinity.history.timezone';
const changed = 'trinity-history-timezone';

export function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return value.length > 0;
  } catch {
    return false;
  }
}

export function readHistoryTimezone(): string {
  const stored = localStorage.getItem(key);
  return stored && validTimezone(stored)
    ? stored
    : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function saveHistoryTimezone(value: string): void {
  if (!validTimezone(value)) return;
  localStorage.setItem(key, value);
  window.dispatchEvent(new Event(changed));
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(changed, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(changed, listener);
    window.removeEventListener('storage', listener);
  };
}

export function useHistoryTimezone(): string {
  return useSyncExternalStore(subscribe, readHistoryTimezone, () => 'UTC');
}
