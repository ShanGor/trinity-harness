import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

/**
 * OTel SDK bootstrap (docs/design.md §17 可观测性). Instrumentation in
 * packages/core uses the `@opentelemetry/api` GLOBAL tracer/meter, which are
 * no-ops until an SDK is registered here — apps call {@link startTelemetry}
 * when OTEL_* env is present, and `shutdown()` on drain. Span + metric
 * shapes are defined next to the code that emits them (packages/core/src/
 * telemetry.ts); this package owns ONLY process-level wiring (exporters).
 */

export interface TelemetryOptions {
  /** OTel service name (default: TRINITY_SERVICE_NAME || 'trinity-harness'). */
  serviceName?: string | undefined;
  /** OTLP/gRPC endpoint for traces + metrics (e.g. http://otel-collector:4317). */
  otlpEndpoint?: string | undefined;
  /**
   * When set, exposes a Prometheus /metrics endpoint on this port
   * (design.md §17: OTel + Prometheus). Scrapes read the same in-process
   * metric instruments as the OTLP reader.
   */
  prometheusPort?: number | undefined;
}

export interface Telemetry {
  /** Flush + unregister; called on SIGTERM drain (AGENTS.md §4.2). */
  shutdown(): Promise<void>;
}

/**
 * Starts the Node SDK with the configured exporters. Returns null when no
 * exporter is configured (pure OTLP-api no-op path — apps stay untraced).
 */
export function startTelemetry(opts: TelemetryOptions): Telemetry | null {
  const otlpEndpoint = opts.otlpEndpoint ?? process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  const prometheusPort =
    opts.prometheusPort ??
    (process.env['OTEL_PROMETHEUS_PORT'] ? Number(process.env['OTEL_PROMETHEUS_PORT']) : undefined);

  if (!otlpEndpoint && prometheusPort === undefined) {
    return null;
  }

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]:
        opts.serviceName ?? process.env['TRINITY_SERVICE_NAME'] ?? 'trinity-harness',
    }),
    traceExporter: otlpEndpoint
      ? new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` })
      : undefined,
    metricReader:
      prometheusPort !== undefined
        ? new PrometheusExporter({ port: prometheusPort })
        : otlpEndpoint
          ? new PeriodicExportingMetricReader({
              exporter: new OTLPMetricExporter({ url: `${otlpEndpoint}/v1/metrics` }),
              exportIntervalMillis: 15_000,
            })
          : undefined,
  });
  sdk.start();

  return {
    shutdown: async () => {
      await sdk.shutdown();
    },
  };
}
