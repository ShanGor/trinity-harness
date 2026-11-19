export * from './env.js';
export {
  DEFAULT_SPEECH_STYLE,
  DEFAULT_SPEECH_PREFERENCES,
  speechPreferencesSchema,
  speechSynthesisRequestSchema,
} from '@trinity-harness/contracts';
export type { SpeechPreferences } from '@trinity-harness/contracts';
export {
  VOICE_CALL_ASR_SEGMENT_SILENCE_MS,
  VOICE_CALL_SILENCE_MS,
} from '@trinity-harness/contracts';
export * from './ids.js';
export * from './protocol.js';
export * from './usage.js';
export * from './workspace.js';
export { environmentResponseSchema } from '@trinity-harness/contracts';
export { browserPreviewSchema } from '@trinity-harness/contracts';
export type { BrowserPreview } from '@trinity-harness/contracts';
export {
  browserInteractionRequestSchema,
  browserInteractionResultSchema,
} from '@trinity-harness/contracts';
export type {
  BrowserInteractionRequest,
  BrowserInteractionResult,
  BrowserHumanAction,
  BrowserInteractionFrame,
  BrowserControlState,
} from '@trinity-harness/contracts';
export {
  scheduleDefinitionSchema,
  scheduleListSchema,
  inboxListSchema,
  nextScheduleInstant,
} from '@trinity-harness/contracts';
export type {
  ScheduleCreate,
  ScheduleDefinition,
  ScheduleRecord,
  InboxItem,
} from '@trinity-harness/contracts';

export {
  personaSchema,
  personaHistorySchema,
  personaChangeSchema,
  memoryCommandSchema,
  memorySnapshotSchema,
  topicEpisodeSchema,
  historyQuerySchema,
  recallReceiptSchema,
} from '@trinity-harness/contracts';
export type {
  Persona,
  PersonaHistory,
  PersonaChange,
  MemoryCommand,
  SavedMemory,
  MemorySnapshot,
  TopicEpisode,
  HistoryQuery,
  RecallReceipt,
} from '@trinity-harness/contracts';

export {
  sessionSummarySchema,
  sessionSummaryListSchema,
  sessionSettingsSchema,
  sessionPolicyUpdateSchema,
  sessionPolicyUpdateResponseSchema,
  historyPageSchema,
  memorySelectionsResponseSchema,
} from '@trinity-harness/contracts';
export type {
  SessionSummary,
  SessionSettings,
  HistoryPage,
  MemorySelectionsResponse,
} from '@trinity-harness/contracts';

export { promptDeliverySchema, type PromptDelivery } from '@trinity-harness/contracts';
export * from './paste.js';
export {
  attachmentUploadResponseSchema,
  type AttachmentUploadResponse,
} from '@trinity-harness/contracts';

export { attachmentUploadErrorSchema } from '@trinity-harness/contracts';

export { historyPreferencesSchema, type HistoryPreferences } from '@trinity-harness/contracts';

export { steeringInputSchema, type SteeringInput } from '@trinity-harness/contracts';
export {
  roleSchema,
  hasCapability,
  llmConfigurationSchema,
  llmPublishedConfigurationSchema,
  llmConfigurationStateSchema,
  llmConfigurationSaveSchema,
  llmConfigurationPublishSchema,
  llmSessionSettingsSchema,
  llmCredentialWriteSchema,
  llmActivitySchema,
} from '@trinity-harness/contracts';
export type {
  Role,
  Capability,
  LlmConfiguration,
  LlmConfigurationState,
  LlmSessionSettings,
  LlmActivity,
} from '@trinity-harness/contracts';
export {
  llmProfilesResponseSchema,
  llmSessionSettingsResponseSchema,
} from '@trinity-harness/contracts';
export type { LlmProfilesResponse, LlmSessionSettingsResponse } from '@trinity-harness/contracts';
export { llmProbeResultSchema } from '@trinity-harness/contracts';
export type { LlmProbeResult } from '@trinity-harness/contracts';
export { userSchema } from '@trinity-harness/contracts';
export type { User } from '@trinity-harness/contracts';
export { llmConfigurationImpactSchema } from '@trinity-harness/contracts';
export type { LlmConfigurationImpact } from '@trinity-harness/contracts';
export { llmHealthSnapshotSchema } from '@trinity-harness/contracts';
export type { LlmHealthSnapshot } from '@trinity-harness/contracts';
export {
  llmActivityListSchema,
  llmProbeListSchema,
  llmHealthListSchema,
  llmSessionSettingsWriteSchema,
  llmProbeRequestSchema,
  userListSchema,
  userRoleUpdateSchema,
} from '@trinity-harness/contracts';
export {
  llmProviderSettingsSchema,
  llmProviderSettingsWriteSchema,
  llmProviderSettingsResponseSchema,
  llmModelsResponseSchema,
} from '@trinity-harness/contracts';
export type {
  LlmProviderSettings,
  LlmProviderSettingsResponse,
  LlmModelReference,
  LlmModelsResponse,
} from '@trinity-harness/contracts';

export * from './attachments.js';
