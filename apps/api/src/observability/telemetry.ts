import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

/**
 * OpenTelemetry bootstrap (ARCHITECTURE §11).
 *
 * This module MUST be required before anything else in the process: auto
 * instrumentation works by monkey-patching modules such as http and pg as they
 * load, so anything imported earlier is invisible to tracing.
 *
 * Instrumentation is off by default. Locally it is noise; in a deployed
 * environment OTEL_ENABLED=true turns it on. Tracing exists from day 1 because
 * per-turn latency (time-to-first-token, time-to-first-audio, tool duration) is a
 * product metric for a voice assistant, not just an ops concern.
 */

let sdk: NodeSDK | undefined;

export function startTelemetry(): void {
  if (process.env.OTEL_ENABLED !== 'true') return;
  if (sdk) return;

  sdk = new NodeSDK({
    // Service name comes from OTEL_SERVICE_NAME, which the SDK reads directly.
    traceExporter: new OTLPTraceExporter({
      url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318'}/v1/traces`,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Filesystem spans bury the traces that matter in noise.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();
}

export async function stopTelemetry(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = undefined;
}

startTelemetry();
