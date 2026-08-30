import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { importRun, rigSlug, validateResults, validateMetadata } from "../src/import-run";
import type { RawResults, RunMetadata } from "../src/import-run";

function sampleResults(): RawResults {
  return {
    generatedAt: "2026-08-30T00:00:00Z",
    smoke: false,
    sessionCount: 3,
    resultCount: 3,
    failureCount: 0,
    results: [
      {
        label: "varnish/plaintext/hit-path-rps",
        engine: "varnish",
        topology: "plaintext",
        workload: "hit-path-rps",
        samplesMs: [0.5, 0.6, 0.55, 0.52, 0.58],
        p50Ms: 0.55,
        p99Ms: 0.6,
        achievedRps: 5000,
        errorRate: 0,
        engineStats: { rssMb: 100 },
        metrics: { p50_ttfb: { value: 0.55, unit: "ms" }, p99_ttfb: { value: 0.6, unit: "ms" } },
      },
      {
        label: "vinyl/plaintext/hit-path-rps",
        engine: "vinyl",
        topology: "plaintext",
        workload: "hit-path-rps",
        samplesMs: [0.6, 0.7, 0.65, 0.62, 0.68],
        p50Ms: 0.65,
        p99Ms: 0.7,
        achievedRps: 5000,
        errorRate: 0,
        engineStats: { rssMb: 110 },
        metrics: { p50_ttfb: { value: 0.65, unit: "ms" }, p99_ttfb: { value: 0.7, unit: "ms" } },
      },
      {
        label: "nginx/plaintext/hit-path-rps",
        engine: "nginx",
        topology: "plaintext",
        workload: "hit-path-rps",
        samplesMs: [0.7, 0.8, 0.75, 0.72, 0.78],
        p50Ms: 0.75,
        p99Ms: 0.8,
        achievedRps: 5000,
        errorRate: 0,
        engineStats: { rssMb: 6 },
        metrics: { p50_ttfb: { value: 0.75, unit: "ms" }, p99_ttfb: { value: 0.8, unit: "ms" } },
      },
    ],
    failures: [],
  };
}

function sampleMeta(): RunMetadata {
  return {
    runId: "bench-20260830-120000-42",
    engineType: "c7g.metal",
    clientType: "c7g.xlarge",
    originType: "c7g.xlarge",
    ami: "ami-0123456789abcdef0",
    region: "us-east-1",
    matrix: "smoke",
    gitSha: "abc123",
    timestamp: "2026-08-30T12:00:00Z",
  };
}

describe("importRun", () => {
  test("converts results and metadata to a BenchmarkRun", () => {
    const run = importRun(sampleResults(), sampleMeta());

    expect(run.id).toBe("2026-08-30-ec2-cluster-c7g-metal-2-c7g-xlarge");
    expect(run.label).toContain("c7g.metal");
    expect(run.environment.machine).toContain("c7g.metal");
    expect(run.environment.chip).toContain("Graviton3");
    expect(run.environment.arch).toBe("arm64");
    expect(run.publishedAt).toBe("2026-08-30");
  });

  test("builds sections from results grouped by workload", () => {
    const run = importRun(sampleResults(), sampleMeta());

    expect(run.sections).toBeDefined();
    expect(run.sections!.length).toBe(1);
    expect(run.sections![0]!.id).toBe("hit-path-rps");
    expect(run.sections![0]!.candidates.length).toBe(3);
  });

  test("picks the candidate with the lowest median as the section winner", () => {
    const run = importRun(sampleResults(), sampleMeta());
    const section = run.sections![0]!;

    expect(section.verdict.winnerId).toBe("varnish-plaintext");
    expect(section.verdict.headline).toContain("Varnish Cache");
  });

  test("computes correct statistics from samples", () => {
    const run = importRun(sampleResults(), sampleMeta());
    const varnish = run.sections![0]!.candidates.find((c) => c.id === "varnish-plaintext");

    expect(varnish).toBeDefined();
    expect(varnish!.statistics.minMs).toBe(0.5);
    expect(varnish!.statistics.maxMs).toBe(0.6);
    expect(varnish!.statistics.medianMs).toBe(0.55);
  });

  test("rejects empty results", () => {
    const empty: RawResults = { ...sampleResults(), results: [], resultCount: 0 };
    expect(() => importRun(empty, sampleMeta())).toThrow("No results");
  });

  test("derives id from generatedAt and machine, not from meta.runId", () => {
    const altMeta: RunMetadata = { ...sampleMeta(), runId: "completely-different" };
    const run = importRun(sampleResults(), altMeta);
    expect(run.id).toBe("2026-08-30-ec2-cluster-c7g-metal-2-c7g-xlarge");
  });

  test("sections have non-empty tests with expected ids", () => {
    const run = importRun(sampleResults(), sampleMeta());
    const section = run.sections![0]!;

    expect(section.tests).toBeDefined();
    expect(section.tests.length).toBeGreaterThanOrEqual(1);
    const testIds = section.tests.map((t) => t.id);
    expect(testIds).toContain("p50-ttfb");
    expect(testIds).toContain("p99-ttfb");
    for (const t of section.tests) {
      expect(t.results.length).toBe(section.candidates.length);
      for (const r of t.results) {
        expect(typeof r.value).toBe("number");
      }
    }
  });

  test("throws when results produce no sections (partial run)", () => {
    const raw: RawResults = {
      ...sampleResults(),
      results: [sampleResults().results[0]!],
      resultCount: 1,
    };
    expect(() => importRun(raw, sampleMeta())).toThrow("No benchmark sections");
  });
});

describe("validateResults", () => {
  test("accepts valid results", () => {
    const raw = sampleResults();
    expect(() => validateResults(raw)).not.toThrow();
  });

  test("rejects missing resultCount", () => {
    expect(() => validateResults({ results: [] })).toThrow("Invalid results format");
  });

  test("rejects results with invalid entries", () => {
    expect(() => validateResults({
      resultCount: 1,
      results: [{ notALabel: true }],
    })).toThrow("Invalid result entry");
  });
});

describe("validateMetadata", () => {
  test("accepts valid metadata", () => {
    expect(() => validateMetadata(sampleMeta())).not.toThrow();
  });

  test("rejects missing runId", () => {
    expect(() => validateMetadata({ engineType: "c7g.metal" })).toThrow("missing runId");
  });
});

describe("id stability", () => {
  test("same input always produces the same id (no clock dependency)", () => {
    const run1 = importRun(sampleResults(), sampleMeta());
    const run2 = importRun(sampleResults(), sampleMeta());
    expect(run1.id).toBe(run2.id);
    expect(run1.publishedAt).toBe(run2.publishedAt);
  });

  test("id changes when generatedAt date changes", () => {
    const run1 = importRun(sampleResults(), sampleMeta());
    const results2 = { ...sampleResults(), generatedAt: "2026-09-15T00:00:00Z" };
    const run2 = importRun(results2, sampleMeta());
    expect(run1.id).not.toBe(run2.id);
    expect(run2.publishedAt).toBe("2026-09-15");
  });

  test("id changes when machine differs", () => {
    const run1 = importRun(sampleResults(), sampleMeta());
    const meta2 = { ...sampleMeta(), engineType: "c7g.4xlarge", clientType: "c7g.xlarge" };
    const run2 = importRun(sampleResults(), meta2);
    expect(run1.id).not.toBe(run2.id);
  });

  test("rigSlug lowercases and dashes a machine string", () => {
    expect(rigSlug("MacBook Pro")).toBe("macbook-pro");
    expect(rigSlug("EC2 cluster (c7g.metal + 2× c7g.xlarge)")).toBe("ec2-cluster-c7g-metal-2-c7g-xlarge");
  });
});

describe("run file idempotency", () => {
  const tmpDir = join(import.meta.dirname!, ".tmp-test-idempotency");

  function setup() {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(join(tmpDir, "runs"), { recursive: true });
    writeFileSync(join(tmpDir, "benchmark.json"), JSON.stringify({
      schemaVersion: 1,
      id: "proxy-hls-2026-08",
      slug: "http-caching-proxies-hls",
      runs: [],
    }, null, 2) + "\n");
  }

  function writeRun(root: string, run: ReturnType<typeof importRun>) {
    const runPath = `runs/${run.id}.json`;
    writeFileSync(join(root, runPath), JSON.stringify({ schemaVersion: 1, ...run }, null, 2) + "\n");
    const benchmark = JSON.parse(readFileSync(join(root, "benchmark.json"), "utf8"));
    const runs: string[] = benchmark.runs ?? [];
    if (!runs.includes(runPath)) {
      runs.push(runPath);
      benchmark.runs = runs;
      writeFileSync(join(root, "benchmark.json"), JSON.stringify(benchmark, null, 2) + "\n");
    }
    return runPath;
  }

  test("writing the same run twice does not duplicate the runs entry", () => {
    setup();
    const run = importRun(sampleResults(), sampleMeta());

    const path1 = writeRun(tmpDir, run);
    const path2 = writeRun(tmpDir, run);

    expect(path1).toBe(path2);
    const benchmark = JSON.parse(readFileSync(join(tmpDir, "benchmark.json"), "utf8"));
    expect(benchmark.runs.length).toBe(1);
    expect(benchmark.runs[0]).toBe(path1);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("writing two different runs appends both", () => {
    setup();
    const run1 = importRun(sampleResults(), sampleMeta());
    const results2 = { ...sampleResults(), generatedAt: "2026-08-31T00:00:00Z" };
    const run2 = importRun(results2, sampleMeta());

    writeRun(tmpDir, run1);
    writeRun(tmpDir, run2);

    const benchmark = JSON.parse(readFileSync(join(tmpDir, "benchmark.json"), "utf8"));
    expect(benchmark.runs.length).toBe(2);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
