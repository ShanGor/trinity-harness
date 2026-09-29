import { metrics, trace } from '@opentelemetry/api';

/**
 * OTel instrumentation surface (docs/design.md §17 可观测性). Instruments are
 * created from the `@opentelemetry/api` GLOBAL provider: without a registered
 * SDK they are no-ops, so tests and inline mode stay untraced and free.
 * The SDK is registered by composition roots via `@trinity-harness/otel`.
 *
 * Metric attribute cardinality is kept bounded: session ids NEVER become
 * metric attributes (unbounded); tenant ids are fine (low cardinality).
 */

const tracer = trace.getTracer('trinity-harness/core');
const meter = metrics.getMeter('trinity-harness/core');

/** Token consumption per model request (usage chunks summed per step). */
export const tokenCounter = meter.createCounter('trinity.llm.tokens', {
  description: 'LLM tokens consumed (input+output) per model request',
  unit: '{token}',
});

/** Tool execution outcomes. */
export const toolCounter = meter.createCounter('trinity.tools.calls', {
  description: 'Tool executions by outcome',
  unit: '{call}',
});

/** Human approval round-trip latency (request → decision). */
export const approvalDuration = meter.createHistogram('trinity.approval.duration_ms', {
  description: 'Approval request to decision latency',
  unit: 'ms',
});

export const turnDuration = meter.createHistogram('trinity.turn.duration_ms', {
  description: 'Turn wall-clock duration',
  unit: 'ms',
});

export const turnSteps = meter.createHistogram('trinity.turn.steps', {
  description: 'Model requests per turn',
  unit: '{step}',
});

export { tracer };
