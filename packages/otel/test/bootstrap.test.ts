import { afterEach, expect, it, vi } from 'vitest';

const { configured, started, shutdown } = vi.hoisted(() => ({
  configured: vi.fn(),
  started: vi.fn(),
  shutdown: vi.fn(async () => {}),
}));
vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    constructor(options: unknown) {
      configured(options);
    }
    start = started;
    shutdown = shutdown;
  },
}));
vi.mock('@opentelemetry/exporter-prometheus', () => ({
  PrometheusExporter: class {},
}));

import { startTelemetry } from '../src/index.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it('disables implicit localhost trace export when only Prometheus is configured', async () => {
  vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
  const telemetry = startTelemetry({ prometheusPort: 9465 });
  expect(configured).toHaveBeenCalledWith(
    expect.objectContaining({ spanProcessors: [], traceExporter: undefined }),
  );
  expect(started).toHaveBeenCalledOnce();
  await telemetry?.shutdown();
  expect(shutdown).toHaveBeenCalledOnce();
});

it('keeps an explicitly configured OTLP trace exporter enabled', async () => {
  const telemetry = startTelemetry({ otlpEndpoint: 'http://collector:4318' });
  const options = configured.mock.calls[0]![0];
  expect(options.traceExporter).toBeDefined();
  expect(options).not.toHaveProperty('spanProcessors');
  await telemetry?.shutdown();
});
