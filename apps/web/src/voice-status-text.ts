import type { ChatItem } from './chat-items';

export type VoiceStatusKind = 'research' | 'subtask' | 'working';
type VoiceStatusLanguage = 'zh' | 'en' | 'ja' | 'ko' | 'ru';

const ACTIVE_SUBTASK_TOOL = /^\s*subagent\s*(?:\(|$)/u;

/** Uses only bounded tool state, never tool arguments, output or child logs. */
export function voiceStatusKind(item: ChatItem): VoiceStatusKind {
  const active = item.tools.filter(
    (tool) => tool.status === 'pending' || tool.status === 'in_progress',
  );
  if (active.some((tool) => /^\s*browser\s*(?:\(|$)/u.test(tool.title))) return 'research';
  if (active.some((tool) => ACTIVE_SUBTASK_TOOL.test(tool.title))) return 'subtask';
  return 'working';
}

/** Best-effort script detection from the current user's own utterance. */
export function voiceStatusLanguage(userText: string): VoiceStatusLanguage {
  if (/[\u3040-\u30ff]/u.test(userText)) return 'ja';
  if (/[\uac00-\ud7af]/u.test(userText)) return 'ko';
  if (/[\u0400-\u04ff]/u.test(userText)) return 'ru';
  if (/[\u3400-\u9fff]/u.test(userText)) return 'zh';
  return 'en';
}

const STATUS_TEXT = {
  zh: {
    research: [
      '资料检索还在进行，有进展后我会继续告诉你。',
      '资料检索仍在处理中，完成后我会继续汇报。',
    ],
    subtask: ['子任务还在处理中，结果汇总后我会继续。', '这些子任务仍在运行，有进展后我会告诉你。'],
    working: ['任务还在处理中，有进展后我会继续告诉你。', '我还在处理这个任务，完成后会继续汇报。'],
  },
  en: {
    research: [
      'Research is still in progress. I’ll continue when there’s an update.',
      'The research is still running. I’ll report back when it’s ready.',
    ],
    subtask: [
      'The subtasks are still running. I’ll continue once their results are ready.',
      'I’m still waiting for the subtasks. I’ll update you when there’s progress.',
    ],
    working: [
      'The task is still in progress. I’ll continue when there’s an update.',
      'I’m still working on it. I’ll report back when it’s ready.',
    ],
  },
  ja: {
    research: [
      '調査はまだ進行中です。進展があり次第、お知らせします。',
      '引き続き調べています。結果が出たらお伝えします。',
    ],
    subtask: [
      'サブタスクを処理しています。結果がそろい次第、続きをお伝えします。',
      'サブタスクはまだ実行中です。進展があり次第、お知らせします。',
    ],
    working: [
      '作業はまだ進行中です。進展があり次第、お知らせします。',
      '引き続き対応しています。完了したらお知らせします。',
    ],
  },
  ko: {
    research: [
      '자료 조사가 아직 진행 중입니다. 진전이 있으면 이어서 알려드리겠습니다.',
      '조사를 계속하고 있습니다. 결과가 나오면 말씀드리겠습니다.',
    ],
    subtask: [
      '하위 작업을 처리하고 있습니다. 결과가 준비되면 이어서 말씀드리겠습니다.',
      '하위 작업이 아직 실행 중입니다. 진전이 있으면 알려드리겠습니다.',
    ],
    working: [
      '작업이 아직 진행 중입니다. 진전이 있으면 알려드리겠습니다.',
      '계속 처리하고 있습니다. 완료되면 말씀드리겠습니다.',
    ],
  },
  ru: {
    research: [
      'Исследование ещё продолжается. Я сообщу, когда появятся новости.',
      'Я всё ещё собираю материалы. Сообщу, когда будут готовы результаты.',
    ],
    subtask: [
      'Подзадачи ещё выполняются. Я продолжу, когда будут готовы их результаты.',
      'Я всё ещё жду результаты подзадач. Сообщу, когда появятся новости.',
    ],
    working: [
      'Задача ещё выполняется. Я сообщу, когда появятся новости.',
      'Я продолжаю работать. Сообщу, когда всё будет готово.',
    ],
  },
} as const;

/** Two alternating reminders avoid repeating the same sentence back-to-back. */
export function voiceStatusText(
  kind: VoiceStatusKind,
  reminderIndex: number,
  userText: string,
): string {
  const language = voiceStatusLanguage(userText);
  const messages = STATUS_TEXT[language][kind];
  return messages[Math.abs(reminderIndex) % messages.length]!;
}
