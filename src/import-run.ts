import { row, type TestResult, type TestStatistic } from "./import";

interface Statistics {
  medianMs: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
}

interface Candidate {
  id: string;
  name: string;
  version: string;
  statistics: Statistics;
  samplesMs: number[];
  configuration?: {
    engine: string;
    topology: string;
    workload: string;
  };
  metrics?: Record<string, { value: number; unit: string; label?: string }>;
}

interface BenchmarkTest {
  id: string;
  title: string;
  description: string;
  unit: string;
  lowerIsBetter: boolean;
  results: TestResult[];
  statistic?: TestStatistic;
}

interface BenchmarkSection {
  id: string;
  title: string;
  deck: string;
  unit: string;
  lowerIsBetter: boolean;
  verdict: { winnerId: string; headline: string; summary: string };
  candidates: Candidate[];
  tests: BenchmarkTest[];
}

export interface BenchmarkRun {
  id: string;
  label: string;
  environment: {
    machine: string;
    chip: string;
    cores: string;
    memory: string;
    os: string;
    arch: string;
    runtime: string;
  };
  protocol: {
    warmups: number;
    runs: number;
    processModel: string;
    cacheState: string;
    output: string;
  };
  publishedAt: string;
  sections?: BenchmarkSection[];
  candidates?: Candidate[];
}

export interface RunMetadata {
  runId: string;
  engineType: string;
  clientType: string;
  originType: string;
  ami: string;
  region: string;
  matrix: string;
  gitSha: string;
  timestamp: string;
}

export interface RawResult {
  label: string;
  engine: string;
  topology: string;
  workload: string;
  samplesMs: number[];
  p50Ms: number;
  p99Ms: number;
  achievedRps: number;
  errorRate: number;
  engineStats: { rssMb: number; cacheHits?: number; cacheMisses?: number; hitRatio?: number };
  metrics: Record<string, { value: number; unit: string; label?: string }>;
}

export interface RawResults {
  generatedAt: string;
  smoke: boolean;
  sessionCount: number;
  resultCount: number;
  failureCount: number;
  results: RawResult[];
  failures: Array<{ label: string; error: string }>;
}

function pct(arr: number[], p: number): number {
  const s = [...arr].sort((a, b) => a - b);
  const idx = p * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo]!;
  return s[lo]! + (s[hi]! - s[lo]!) * (idx - lo);
}

function r(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export function rigSlug(machine: string): string {
  return machine.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function stats(samples: number[]): Statistics {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    medianMs: r(pct(samples, 0.5), 3),
    meanMs: r(mean, 3),
    minMs: r(sorted[0]!, 3),
    maxMs: r(sorted[sorted.length - 1]!, 3),
  };
}

const CHIP_MAP: Record<string, string> = {
  "c7g.metal": "Graviton3 (64 vCPU)",
  "c7g.4xlarge": "Graviton3 (16 vCPU)",
  "c7g.xlarge": "Graviton3 (4 vCPU)",
};

const MEMORY_MAP: Record<string, string> = {
  "c7g.metal": "128 GiB",
  "c7g.4xlarge": "32 GiB",
  "c7g.xlarge": "8 GiB",
};

export function importRun(raw: RawResults, meta: RunMetadata): BenchmarkRun {
  if (!raw.results.length) throw new Error("No results to import");

  const sections = buildSections(raw.results);
  if (!sections.length) throw new Error("No benchmark sections could be built from the results (partial run?)");

  const machine = `EC2 cluster (${meta.engineType} + 2× ${meta.clientType})`;
  const publishedAt = raw.generatedAt.split("T")[0]!;

  return {
    id: `${publishedAt}-${rigSlug(machine)}`,
    label: `${meta.engineType} cluster (${meta.region})`,
    environment: {
      machine,
      chip: CHIP_MAP[meta.engineType] ?? meta.engineType,
      cores: "64 vCPU engine, 4 vCPU client/origin",
      memory: MEMORY_MAP[meta.engineType] ?? "unknown",
      os: `Ubuntu 24.04 arm64 (${meta.ami})`,
      arch: "arm64",
      runtime: "Docker on bare metal",
    },
    protocol: {
      warmups: 3,
      runs: raw.results[0]!.samplesMs.length,
      processModel: "Three EC2 instances in a cluster placement group",
      cacheState: "Warm cache after three unmeasured passes",
      output: "TTFB via oha with latency correction",
    },
    publishedAt,
    sections,
  };
}

function buildTests(workload: string, candidates: Candidate[]): BenchmarkTest[] {
  const tests: BenchmarkTest[] = [];

  const add = (key: string, id: string, title: string, desc: string, unit: string, lower: boolean, statistic: TestStatistic, samples: (c: Candidate) => number[] | undefined) => {
    if (!candidates.some((c) => c.metrics?.[key])) return;
    tests.push({
      id, title, description: desc, unit, lowerIsBetter: lower,
      results: candidates.map((c) => row(c.id, c.metrics?.[key]?.value ?? 0, samples(c))),
      statistic,
    });
  };
  const perPass = (c: Candidate) => c.samplesMs;
  const none = () => undefined;

  switch (workload) {
    case "miss-storm":
      // samplesMs holds one p99 per cold burst: the p50 is their median, the p99 their 99th percentile.
      add("p50_ttfb", "p50-ttfb", "p50 TTFB", "50th-percentile time to first byte", "ms", true, "median", perPass);
      add("p99_ttfb", "p99-ttfb", "p99 TTFB", "99th-percentile time to first byte", "ms", true, "other", perPass);
      add("coalescing_efficiency", "coalescing", "Coalescing efficiency", "Ratio of concurrent clients to origin requests", "x", false, "other", none);
      break;
    case "origin-flap":
      // samplesMs holds one p99 per phase, and the phases mix baseline, flap and recovery, so no test carries them as samples.
      add("p50_ttfb", "p50-ttfb", "p50 TTFB", "50th-percentile time to first byte", "ms", true, "median", none);
      add("p99_ttfb", "p99-ttfb", "p99 TTFB", "99th-percentile time to first byte", "ms", true, "other", none);
      add("grace_ratio", "grace-ratio", "Grace hit ratio", "Percentage of requests served from stale cache during origin failure", "%", false, "other", none);
      break;
    default:
      // samplesMs holds one p99 per measured pass; the p50 is the median of per-pass p50s that are never written to disk.
      add("p50_ttfb", "p50-ttfb", "p50 TTFB", "50th-percentile time to first byte", "ms", true, "median", none);
      add("p99_ttfb", "p99-ttfb", "p99 TTFB", "99th-percentile time to first byte", "ms", true, "median", perPass);
  }

  return tests;
}

function buildSections(results: RawResult[]): BenchmarkSection[] {
  const workloads = [...new Set(results.map((r) => r.workload))];
  const sections: BenchmarkSection[] = [];

  for (const workload of workloads) {
    const wResults = results.filter((r) => r.workload === workload && r.topology === "plaintext");
    if (wResults.length < 2) continue;

    const candidates: Candidate[] = wResults.map((r) => ({
      id: `${r.engine}-${r.topology}`,
      name: engineName(r.engine),
      version: "pinned",
      statistics: stats(r.samplesMs),
      samplesMs: r.samplesMs,
      configuration: {
        engine: r.engine,
        topology: r.topology,
        workload: r.workload,
      },
      metrics: r.metrics,
    }));

    const best = candidates.reduce((a, b) => a.statistics.medianMs < b.statistics.medianMs ? a : b);

    sections.push({
      id: workload,
      title: workloadTitle(workload),
      deck: workloadDeck(workload),
      unit: "ms",
      lowerIsBetter: true,
      verdict: {
        winnerId: best.id,
        headline: `${best.name} leads on ${workloadTitle(workload).toLowerCase()}`,
        summary: `${best.name} posted ${best.statistics.medianMs} ms median.`,
      },
      candidates,
      tests: buildTests(workload, candidates),
    });
  }

  return sections;
}

function engineName(engine: string): string {
  switch (engine) {
    case "varnish": return "Varnish Cache";
    case "vinyl": return "Vinyl Cache";
    case "nginx": return "NGINX";
    default: return engine;
  }
}

function workloadTitle(w: string): string {
  switch (w) {
    case "hit-path-rps": return "Hit-path RPS";
    case "segment-serve": return "Segment serve";
    case "miss-storm": return "Miss-storm coalescing";
    case "origin-flap": return "Origin-flap grace";
    default: return w;
  }
}

function workloadDeck(w: string): string {
  switch (w) {
    case "hit-path-rps": return "Sustained 5000 rps against a 2 KB cached manifest.";
    case "segment-serve": return "4 MB segment GET and Range GET at 500 rps.";
    case "miss-storm": return "200-concurrent burst on a cold 4 MB segment, measuring request coalescing.";
    case "origin-flap": return "Origin returns 500s; does the proxy serve stale/grace content?";
    default: return "";
  }
}

type Guard = (value: unknown) => boolean;

/** One field of a JSON shape: its key, its guard, and what the guard expects, for the error message. */
type Field<T> = [key: keyof T & string, guard: Guard, expected: string];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isOptional<T>(guard: (value: unknown) => value is T): (value: unknown) => value is T | undefined {
  return (value): value is T | undefined => value === undefined || guard(value);
}

function isArrayOf<T>(guard: (value: unknown) => value is T): (value: unknown) => value is T[] {
  return (value): value is T[] => Array.isArray(value) && value.every(guard);
}

/** Why `value` is not the shape `fields` describe, or undefined when it is. */
function fault<T>(value: unknown, fields: Field<T>[]): string | undefined {
  if (!isRecord(value)) return "not an object";
  for (const [key, guard, expected] of fields) {
    if (guard(value[key])) continue;
    return value[key] === undefined ? `missing ${key}` : `${key} is not ${expected}`;
  }
  return undefined;
}

type Metric = RawResult["metrics"][string];

const METRIC: Field<Metric>[] = [
  ["value", isNumber, "a number"],
  ["unit", isString, "a string"],
  ["label", isOptional(isString), "a string"],
];

function isMetric(value: unknown): value is Metric {
  return fault(value, METRIC) === undefined;
}

function isMetrics(value: unknown): value is RawResult["metrics"] {
  return isRecord(value) && Object.values(value).every(isMetric);
}

const ENGINE_STATS: Field<RawResult["engineStats"]>[] = [
  ["rssMb", isNumber, "a number"],
  ["cacheHits", isOptional(isNumber), "a number"],
  ["cacheMisses", isOptional(isNumber), "a number"],
  ["hitRatio", isOptional(isNumber), "a number"],
];

function isEngineStats(value: unknown): value is RawResult["engineStats"] {
  return fault(value, ENGINE_STATS) === undefined;
}

const RAW_RESULT: Field<RawResult>[] = [
  ["label", isString, "a string"],
  ["engine", isString, "a string"],
  ["topology", isString, "a string"],
  ["workload", isString, "a string"],
  ["samplesMs", isArrayOf(isNumber), "an array of numbers"],
  ["p50Ms", isNumber, "a number"],
  ["p99Ms", isNumber, "a number"],
  ["achievedRps", isNumber, "a number"],
  ["errorRate", isNumber, "a number"],
  ["engineStats", isEngineStats, "engine stats (rssMb, and cacheHits, cacheMisses and hitRatio when present, all numbers)"],
  ["metrics", isMetrics, "a map of metrics (value number, unit string, label string when present)"],
];

export function isRawResult(value: unknown): value is RawResult {
  return fault(value, RAW_RESULT) === undefined;
}

type Failure = RawResults["failures"][number];

const FAILURE: Field<Failure>[] = [
  ["label", isString, "a string"],
  ["error", isString, "a string"],
];

function isFailure(value: unknown): value is Failure {
  return fault(value, FAILURE) === undefined;
}

const RAW_RESULTS: Field<RawResults>[] = [
  ["generatedAt", isString, "a string"],
  ["smoke", isBoolean, "a boolean"],
  ["sessionCount", isNumber, "a number"],
  ["resultCount", isNumber, "a number"],
  ["failureCount", isNumber, "a number"],
  ["results", isArrayOf(isRawResult), "an array of results"],
  ["failures", isArrayOf(isFailure), "an array of failures (label and error strings)"],
];

export function isRawResults(value: unknown): value is RawResults {
  return fault(value, RAW_RESULTS) === undefined;
}

const RUN_METADATA: Field<RunMetadata>[] = [
  ["runId", isString, "a string"],
  ["engineType", isString, "a string"],
  ["clientType", isString, "a string"],
  ["originType", isString, "a string"],
  ["ami", isString, "a string"],
  ["region", isString, "a string"],
  ["matrix", isString, "a string"],
  ["gitSha", isString, "a string"],
  ["timestamp", isString, "a string"],
];

export function isRunMetadata(value: unknown): value is RunMetadata {
  return fault(value, RUN_METADATA) === undefined;
}

export function validateResults(raw: unknown): RawResults {
  if (isRawResults(raw)) return raw;
  if (isRecord(raw) && Array.isArray(raw.results)) {
    for (const [i, result] of raw.results.entries()) {
      const why = fault(result, RAW_RESULT);
      if (why) throw new Error(`Invalid result entry ${i} (${why}): ${JSON.stringify(result).slice(0, 100)}`);
    }
  }
  throw new Error(`Invalid results format: ${fault(raw, RAW_RESULTS) ?? "not the runner's results"}`);
}

export function validateMetadata(raw: unknown): RunMetadata {
  if (isRunMetadata(raw)) return raw;
  throw new Error(`Invalid metadata: ${fault(raw, RUN_METADATA) ?? "not the rig's metadata"}`);
}

if (import.meta.main) {
  const { readFileSync, writeFileSync, mkdirSync, existsSync } = await import("fs");
  const { resolve, join } = await import("path");

  const root = join(import.meta.dirname!, "..");
  const resultsArg = process.argv.find((a) => a.startsWith("--results="))?.split("=")[1];
  const metadataArg = process.argv.find((a) => a.startsWith("--metadata="))?.split("=")[1];
  const resultsPath = resultsArg ? resolve(resultsArg) : join(root, "results.json");
  const metadataPath = metadataArg ? resolve(metadataArg) : join(root, "metadata.json");

  const rawResults = validateResults(JSON.parse(readFileSync(resultsPath, "utf8")));
  const rawMetadata = validateMetadata(JSON.parse(readFileSync(metadataPath, "utf8")));

  const run = importRun(rawResults, rawMetadata);
  const runPath = `runs/${run.id}.json`;

  mkdirSync(join(root, "runs"), { recursive: true });
  writeFileSync(join(root, runPath), JSON.stringify({ schemaVersion: 1, ...run }, null, 2) + "\n");

  const benchmarkPath = join(root, "benchmark.json");
  if (!existsSync(benchmarkPath)) {
    console.error(`benchmark.json not found at ${benchmarkPath}`);
    process.exit(1);
  }
  const benchmark = JSON.parse(readFileSync(benchmarkPath, "utf8"));
  const runs: string[] = benchmark.runs ?? [];
  if (!runs.includes(runPath)) {
    runs.push(runPath);
    benchmark.runs = runs;
    writeFileSync(benchmarkPath, JSON.stringify(benchmark, null, 2) + "\n");
  }

  console.log(`Wrote ${runPath}`);
  console.log(`  ${run.sections?.length ?? 0} sections, environment: ${run.label}`);
}
