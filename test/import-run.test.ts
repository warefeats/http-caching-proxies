import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { importRun, rigSlug, validateResults, validateMetadata } from "../src/import-run";
import type { RawResult, RawResults, RunMetadata } from "../src/import-run";
import { agrees, median } from "../src/enrich";

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
        p50Ms: 0.3,
        p99Ms: 0.55,
        achievedRps: 5000,
        errorRate: 0,
        engineStats: { rssMb: 100 },
        metrics: { p50_ttfb: { value: 0.3, unit: "ms" }, p99_ttfb: { value: 0.55, unit: "ms" } },
      },
      {
        label: "vinyl/plaintext/hit-path-rps",
        engine: "vinyl",
        topology: "plaintext",
        workload: "hit-path-rps",
        samplesMs: [0.6, 0.7, 0.65, 0.62, 0.68],
        p50Ms: 0.4,
        p99Ms: 0.65,
        achievedRps: 5000,
        errorRate: 0,
        engineStats: { rssMb: 110 },
        metrics: { p50_ttfb: { value: 0.4, unit: "ms" }, p99_ttfb: { value: 0.65, unit: "ms" } },
      },
      {
        label: "nginx/plaintext/hit-path-rps",
        engine: "nginx",
        topology: "plaintext",
        workload: "hit-path-rps",
        samplesMs: [0.7, 0.8, 0.75, 0.72, 0.78],
        p50Ms: 0.5,
        p99Ms: 0.75,
        achievedRps: 5000,
        errorRate: 0,
        engineStats: { rssMb: 6 },
        metrics: { p50_ttfb: { value: 0.5, unit: "ms" }, p99_ttfb: { value: 0.75, unit: "ms" } },
      },
    ],
    failures: [],
  };
}

// Per-burst p99s for the miss storm and per-phase p99s for the origin flap, as the runner writes them to samplesMs.
const BURSTS = [700, 760, 720, 810, 690, 750, 740, 800, 730, 770, 710, 790, 745, 755, 735, 765, 725, 775, 715, 785]; // median 747.5, p99 808.1
const PHASES = [6.0, 6.3, 6.9, 5.5, 6.2, 6.5, 6.1, 6.0, 7.1, 6.5, 5.4, 6.1, 6.5, 6.0, 5.3]; // median 6.1, p99 7.072

function plaintextCell(engine: string, workload: string, samplesMs: number[], p50: number, p99: number, metrics: RawResult["metrics"]): RawResult {
  return {
    label: `${engine}/plaintext/${workload}`,
    engine,
    topology: "plaintext",
    workload,
    samplesMs,
    p50Ms: p50,
    p99Ms: p99,
    achievedRps: 0,
    errorRate: 0,
    engineStats: { rssMb: 100 },
    metrics: { p50_ttfb: { value: p50, unit: "ms" }, p99_ttfb: { value: p99, unit: "ms" }, ...metrics },
  };
}

function stormResults(): RawResults {
  const shifted = (samples: number[], by: number) => samples.map((v) => v + by);
  return {
    ...sampleResults(),
    sessionCount: 4,
    resultCount: 4,
    results: [
      plaintextCell("varnish", "miss-storm", BURSTS, 747.5, 808.1, { coalescing_efficiency: { value: 200, unit: "x" } }),
      plaintextCell("vinyl", "miss-storm", shifted(BURSTS, -100), 647.5, 708.1, { coalescing_efficiency: { value: 200, unit: "x" } }),
      plaintextCell("varnish", "origin-flap", PHASES, 6.1, 7.072, { grace_ratio: { value: 100, unit: "%" } }),
      plaintextCell("vinyl", "origin-flap", shifted(PHASES, 1), 7.1, 8.072, { grace_ratio: { value: 100, unit: "%" } }),
    ],
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

describe("per-pass samples", () => {
  test("the hit path's p99 carries each candidate's per-pass p99s as the array its median was taken over", () => {
    const raw = sampleResults();
    const section = importRun(raw, sampleMeta()).sections![0]!;
    const p99 = section.tests.find((t) => t.id === "p99-ttfb")!;
    expect(p99.statistic).toBe("median");
    expect(Object.keys(p99)).toEqual(["id", "title", "description", "unit", "lowerIsBetter", "results", "statistic"]);
    for (const result of p99.results) {
      const cell = raw.results.find((r) => `${r.engine}-${r.topology}` === result.candidateId)!;
      expect(result.samples).toEqual(cell.samplesMs);
      expect(Object.keys(result)).toEqual(["candidateId", "value", "samples"]);
      expect(agrees(result.value, median(result.samples!))).toBe(true);
    }
  });

  test("the hit path's p50 is a median over per-pass p50s that are not on disk, so it carries none", () => {
    const section = importRun(sampleResults(), sampleMeta()).sections![0]!;
    const p50 = section.tests.find((t) => t.id === "p50-ttfb")!;
    expect(p50.statistic).toBe("median");
    for (const result of p50.results) {
      expect(Object.keys(result)).toEqual(["candidateId", "value"]);
    }
  });

  test("the miss storm's p50 and p99 both carry the per-burst p99s; the p99 is a percentile the site cannot recompute", () => {
    const raw = stormResults();
    const storm = importRun(raw, sampleMeta()).sections!.find((s) => s.id === "miss-storm")!;
    const p50 = storm.tests.find((t) => t.id === "p50-ttfb")!;
    const p99 = storm.tests.find((t) => t.id === "p99-ttfb")!;
    const coalescing = storm.tests.find((t) => t.id === "coalescing")!;
    expect(p50.statistic).toBe("median");
    expect(p99.statistic).toBe("other");
    expect(coalescing.statistic).toBe("other");
    for (const result of [...p50.results, ...p99.results]) {
      const cell = raw.results.find((r) => r.workload === "miss-storm" && `${r.engine}-${r.topology}` === result.candidateId)!;
      expect(result.samples).toEqual(cell.samplesMs);
    }
    for (const result of p50.results) expect(agrees(result.value, median(result.samples!))).toBe(true);
    for (const result of coalescing.results) expect(Object.keys(result)).toEqual(["candidateId", "value"]);
  });

  test("the origin flap mixes baseline, flap and recovery phases, so none of its tests carry samples", () => {
    const flap = importRun(stormResults(), sampleMeta()).sections!.find((s) => s.id === "origin-flap")!;
    expect(flap.tests.map((t) => [t.id, t.statistic])).toEqual([["p50-ttfb", "median"], ["p99-ttfb", "other"], ["grace-ratio", "other"]]);
    for (const t of flap.tests) {
      for (const result of t.results) expect(Object.keys(result)).toEqual(["candidateId", "value"]);
    }
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
