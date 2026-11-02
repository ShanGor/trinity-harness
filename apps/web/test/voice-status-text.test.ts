import { describe, expect, it } from 'vitest';

import type { ChatItem } from '../src/chat-items.js';
import { voiceStatusKind, voiceStatusLanguage, voiceStatusText } from '../src/voice-status-text.js';

function itemWithTools(tools: ChatItem['tools']): ChatItem {
  return {
    key: 'assistant',
    role: 'assistant',
    content: '',
    streaming: true,
    tools,
    attachments: [],
  };
}

describe('voice status text', () => {
  it('uses the current user language and alternates reminders', () => {
    expect(voiceStatusText('subtask', 0, '请继续调研这个问题')).toBe(
      '子任务还在处理中，结果汇总后我会继续。',
    );
    expect(voiceStatusText('subtask', 1, '请继续调研这个问题')).toBe(
      '这些子任务仍在运行，有进展后我会告诉你。',
    );
    expect(voiceStatusText('subtask', 2, '请继续调研这个问题')).toBe(
      voiceStatusText('subtask', 0, '请继续调研这个问题'),
    );
    expect(voiceStatusText('research', 0, 'Please research this')).toBe(
      'Research is still in progress. I’ll continue when there’s an update.',
    );
  });

  it('detects supported scripts from the user utterance', () => {
    expect(voiceStatusLanguage('調べてください')).toBe('ja');
    expect(voiceStatusLanguage('조사해 주세요')).toBe('ko');
    expect(voiceStatusLanguage('Продолжай исследование')).toBe('ru');
    expect(voiceStatusLanguage('继续调查')).toBe('zh');
    expect(voiceStatusLanguage('Continue research')).toBe('en');
  });

  it('classifies only active tool state without speaking tool arguments or logs', () => {
    const secret = 'private task arguments and Subagent 1234 Strategy';
    const researching = itemWithTools([
      {
        toolCallId: 'browser-1',
        title: `browser({"query":"${secret}"})`,
        status: 'in_progress',
      },
    ]);
    expect(voiceStatusKind(researching)).toBe('research');
    expect(voiceStatusText(voiceStatusKind(researching), 0, '继续')).not.toContain(secret);

    researching.tools[0]!.status = 'completed';
    researching.tools.push({
      toolCallId: 'subagent-1',
      title: `subagent({"task":"${secret}"})`,
      status: 'in_progress',
    });
    expect(voiceStatusKind(researching)).toBe('subtask');
    researching.tools[1]!.status = 'completed';
    expect(voiceStatusKind(researching)).toBe('working');
  });
});
