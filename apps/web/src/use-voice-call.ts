import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from 'react';

import type { ChatItem } from './chat-items';
import {
  defaultVoiceCallDependencies,
  VoiceCallController,
  type VoiceCallSnapshot,
} from './voice-call-controller';

export interface UseVoiceCallOptions {
  items: ChatItem[];
  busy: boolean;
  approvalPending: boolean;
  getSessionId(): string | null;
  onSubmit(text: string, onPromptId: (promptId: string) => void): Promise<boolean | void>;
  onCancelTurn(): Promise<boolean | void>;
  onError(message: string): void;
}

export interface VoiceCallView {
  controller: VoiceCallController;
  snapshot: VoiceCallSnapshot;
  minimized: boolean;
  setMinimized: Dispatch<SetStateAction<boolean>>;
}

/** Binds the ephemeral call controller to the current App projection and page lifecycle. */
export function useVoiceCall(options: UseVoiceCallOptions): VoiceCallView {
  const latest = useRef(options);
  latest.current = options;
  const [controller] = useState(
    () =>
      new VoiceCallController({
        ...defaultVoiceCallDependencies,
        getSessionId: () => latest.current.getSessionId(),
        submit: (text, onPromptId) => latest.current.onSubmit(text, onPromptId),
        cancelTurn: () => latest.current.onCancelTurn(),
        onError: (message) => latest.current.onError(message),
      }),
  );
  const [minimized, setMinimized] = useState(false);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  useEffect(() => {
    controller.update(options.items, options.busy, options.approvalPending);
  }, [controller, options.items, options.busy, options.approvalPending]);

  useEffect(() => {
    const onVisibilityChange = (): void => {
      // The MVP is foreground-only: never leave a hidden tab recording.
      if (document.hidden && controller.getSnapshot().active) controller.stop();
    };
    const onPageHide = (): void => controller.stop();
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [controller]);

  useEffect(() => () => controller.dispose(), [controller]);

  return { controller, snapshot, minimized, setMinimized };
}
