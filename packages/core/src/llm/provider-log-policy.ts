// SDK compatibility warnings may interpolate entire reasoning blocks or inputs.
// Retain an explicitly installed operator logger; disable the SDK's raw default.
if (globalThis.AI_SDK_LOG_WARNINGS === undefined) globalThis.AI_SDK_LOG_WARNINGS = false;
