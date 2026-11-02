import { z } from 'zod';

/** TTS delivery preferences only; never Agent instructions or authority. */
export const DEFAULT_SPEECH_STYLE =
  '保持参考音色和同一位说话人的自然音高范围。中文使用标准普通话，发音清晰，' +
  '不带地方口音；其他语言使用该语言自然清晰的发音。语气专业、沉稳、亲切、耐心，' +
  '使用稳定、适中的讲解语速，中文以每分钟约220至260字为目标，句内和句间保持匀速。' +
  '标点处短暂停顿，不突然加速、放慢、拖长字音或用夸张的语调强调内容；' +
  '数字、英文和专业术语清晰从容地读，不抢读，不刻意卖萌、不夸张表演。' +
  '从开头到结尾保持同一位说话人的音色、口音、音高范围和语气，不随段落或内容切换声音。';

export const speechPreferencesSchema = z
  .object({
    voiceStyle: z.string().trim().min(1).max(1000),
  })
  .strict();
export type SpeechPreferences = z.infer<typeof speechPreferencesSchema>;
export const DEFAULT_SPEECH_PREFERENCES: SpeechPreferences = { voiceStyle: DEFAULT_SPEECH_STYLE };

export const speechSynthesisRequestSchema = z
  .object({
    text: z.string().min(1).max(50_000),
    /** A call can pin its voice for all sentence requests, including local status hints. */
    voiceStyle: speechPreferencesSchema.shape.voiceStyle.optional(),
    /** Language for otherwise language-neutral speech, inferred from the current prompt. */
    languageHint: z.enum(['Chinese']).optional(),
  })
  .strict();
