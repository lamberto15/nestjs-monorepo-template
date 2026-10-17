import { maintenanceAvailable } from '../tenancy/tenant-pool.js';
import { acrossTenantsReadOnly } from '../tenancy/tenant-scope.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { getHeapStatistics } from 'node:v8';
import { Injectable, Logger } from '@nestjs/common';
import { collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

/** A collector that takes longer (Redis or PostgreSQL away) is given up: the scrape goes on without it. */
const COLLECT_TIMEOUT_MS = 2_000;
const TIMED_OUT = Symbol('timed out');

/** One value of a collected gauge, with its labels. */
export type MetricSample<Label extends string> = {
  labels?: Partial<Record<Label, string>>;
  value: number;
};

/**
 * The process's Prometheus metrics (prom-client), served at `GET /metrics`:
 * Node's default metrics and the heap's limit, HTTP request durations by route pattern, requests
 * in flight, and the gauges other groups register with `collect()` (queue
 * depths, outbox lag: the platform's, read at scrape time, so core never
 * imports the platform).
 *
 * A registry of its own, not prom-client's global one: every app of a test
 * run (and anything else in the process) keeps its metrics apart.
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger('Metrics');
  readonly registry = new Registry();

  /** How long requests take, by method, route pattern and status. */
  readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds, by method, route pattern and status.',
    labelNames: ['method', 'route', 'status'] as const,
    // An API's range: 5 ms to 10 s.
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  /** Requests being served right now. */
  readonly inFlight = new Gauge({
    name: 'http_requests_in_flight',
    help: 'HTTP requests being served.',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
    // Not among prom-client's defaults: what the heap alert compares the used heap with.
    this.collect(
      'nodejs_heap_size_limit_bytes',
      "V8's heap limit (--max-old-space-size plus the young generation).",
      () => [{ value: getHeapStatistics().heap_size_limit }],
    );
  }

  /**
   * A gauge whose values `read` gives at each scrape (labelled samples).
   * A failing read is logged and leaves the gauge empty for that scrape:
   * one broken source never fails the whole scrape.
   */
  collect<Label extends string = never>(
    name: string,
    help: string,
    read: () => Promise<MetricSample<Label>[]> | MetricSample<Label>[],
    labelNames: readonly Label[] = [],
    /**
     * `acrossTenants`: a deployment-wide gauge over tenant tables, read as
     * the maintenance role in read-only transactions (docs/tenancy.md, "The
     * bypass"): only where that role is, the workers; elsewhere (api
     * replicas) the gauge isn't registered, and Prometheus takes it from
     * the workers' scrape.
     */
    options: { acrossTenants?: boolean } = {},
  ) {
    if (options.acrossTenants && !maintenanceAvailable()) {
      return;
    }
    const logger = this.logger;
    new Gauge<Label>({
      name,
      help,
      labelNames,
      registers: [this.registry],
      async collect() {
        this.reset();
        try {
          const samples = await Promise.race([
            options.acrossTenants ? acrossTenantsReadOnly(read) : read(),
            sleep(COLLECT_TIMEOUT_MS, TIMED_OUT, { ref: false }),
          ]);
          if (samples === TIMED_OUT) {
            throw new Error(`no answer in ${COLLECT_TIMEOUT_MS} ms`);
          }
          for (const sample of samples) {
            this.set(sample.labels ?? {}, sample.value);
          }
        } catch (error) {
          // Absent, not a 0, so alerts notice: reset() empties a labelled
          // gauge but seeds a 0 on an unlabelled one, which remove() takes
          // out. (remove() without labels throws on a labelled gauge, which
          // failed every scrape while Redis was away.)
          this.reset();
          if (labelNames.length === 0) {
            this.remove();
          }
          logger.warn(`${name} not collected: ${(error as Error).message}`);
        }
      },
    });
  }

  /** The exposition (text format) and its content type. */
  async scrape() {
    return {
      contentType: this.registry.contentType,
      body: await this.registry.metrics(),
    };
  }
}
