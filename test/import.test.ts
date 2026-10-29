import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildRun, buildW1Section, buildW2Section, buildW3Section, buildW4Section } from "../src/import";
import type { BenchmarkTest, RawResult, RawResults, TestStatistic } from "../src/import";
import { agrees, enrich, median, summarize, tolerance } from "../src/enrich";

// Per-pass p99s as the runner writes them to samplesMs: hit path and segment serve per measured pass,
// the miss storm per cold burst, the origin flap per phase of each cycle.
const HIT_PATH: Record<string, number[]> = {
  varnish: [0.5, 0.6, 0.55, 0.52, 0.58], // median 0.55
  vinyl: [0.6, 0.7, 0.65, 0.62, 0.68], // median 0.65
  nginx: [0.7, 0.8, 0.75, 0.72, 0.78], // median 0.75
};
const FULL_GET = [2.0, 2.4, 2.2, 2.6, 2.1, 2.3]; // median 2.25
const RANGE_GET = [0.4, 0.5, 0.45, 0.47, 0.41, 0.52]; // median 0.46
const BURSTS = [700, 760, 720, 810, 690, 750, 740, 800, 730, 770, 710, 790, 745, 755, 735, 765, 725, 775, 715, 785]; // median 747.5, p99 808.1
const PHASES = [6.0, 6.3, 6.9, 5.5, 6.2, 6.5, 6.1, 6.0, 7.1, 6.5, 5.4, 6.1, 6.5, 6.0, 5.3]; // median 6.1

function cell(engine: string, topology: string, workload: string, samplesMs: number[], p50: number, p99: number, metrics: RawResult["metrics"] = {}): RawResult {
  return {
    label: `${engine}/${topology}/${workload}`,
    engine,
    topology,
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

function sampleResults(): RawResults {
  return {
    generatedAt: "2026-08-30T00:00:00Z",
    results: [
      cell("varnish", "plaintext", "hit-path-rps", HIT_PATH.varnish!, 0.3, 0.55),
      cell("vinyl", "plaintext", "hit-path-rps", HIT_PATH.vinyl!, 0.4, 0.65),
      cell("nginx", "plaintext", "hit-path-rps", HIT_PATH.nginx!, 0.5, 0.75),
      cell("varnish", "plaintext", "segment-serve", FULL_GET, 1.9, 2.25),
      cell("varnish", "plaintext", "segment-serve", RANGE_GET, 0.38, 0.46, { variant: { value: 1, unit: "", label: "Range GET" } }),
      cell("varnish", "plaintext", "miss-storm", BURSTS, 747.5, 808.1, { coalescing_efficiency: { value: 200, unit: "x" } }),
      cell("varnish", "plaintext", "origin-flap", PHASES, 6.1, 7.072, { grace_ratio: { value: 100, unit: "%" } }),
    ],
  };
}

function findTest(run: ReturnType<typeof buildRun>, sectionId: string, testId: string): BenchmarkTest {
  const section = run.sections.find((s) => s.id === sectionId);
  if (!section) throw new Error(`no section ${sectionId}`);
  const found = section.tests.find((t) => t.id === testId);
  if (!found) throw new Error(`no test ${sectionId}/${testId}`);
  return found;
}

function serialize(run: ReturnType<typeof buildRun>): string {
  return JSON.stringify(run, null, 2) + "\n";
}

/** The run file as it was published before the contract: no `statistic`, no `samples`. */
function strip(text: string): string {
  const run: unknown = JSON.parse(text, (key, value: unknown) => (key === "statistic" || key === "samples" ? undefined : value));
  return JSON.stringify(run, null, 2) + "\n";
}

interface Expectation {
  section: string;
  test: string;
  statistic: TestStatistic;
  /** The samples each candidate's result must carry, or null when the test carries none. */
  samples: Record<string, number[]> | null;
}

const EXPECTED: Expectation[] = [
  { section: "hit-path-rps", test: "p50-ttfb", statistic: "median", samples: null },
  { section: "hit-path-rps", test: "p99-ttfb", statistic: "median", samples: { "varnish-plaintext": HIT_PATH.varnish!, "vinyl-plaintext": HIT_PATH.vinyl!, "nginx-plaintext": HIT_PATH.nginx! } },
  { section: "segment-serve", test: "p50-full-get", statistic: "median", samples: null },
  { section: "segment-serve", test: "p50-range-get", statistic: "median", samples: null },
  { section: "segment-serve", test: "p99-full-get", statistic: "median", samples: { "varnish-plaintext": FULL_GET } },
  { section: "segment-serve", test: "p99-range-get", statistic: "median", samples: { "varnish-plaintext": RANGE_GET } },
  { section: "miss-storm", test: "p50-ttfb", statistic: "median", samples: { "varnish-plaintext": BURSTS } },
  { section: "miss-storm", test: "p99-ttfb", statistic: "other", samples: { "varnish-plaintext": BURSTS } },
  { section: "miss-storm", test: "coalescing", statistic: "other", samples: null },
  { section: "origin-flap", test: "p50-ttfb", statistic: "median", samples: null },
  { section: "origin-flap", test: "grace-ratio", statistic: "other", samples: null },
];

describe("section builders", () => {
  for (const expected of EXPECTED) {
    test(`${expected.section}/${expected.test} is ${expected.statistic}${expected.samples ? " with samples" : " without samples"}`, () => {
      const found = findTest(buildRun(sampleResults()), expected.section, expected.test);
      expect(found.statistic).toBe(expected.statistic);
      expect(Object.keys(found)).toEqual(["id", "title", "description", "unit", "lowerIsBetter", "results", "statistic"]);
      expect(found.results.length).toBeGreaterThan(0);
      for (const result of found.results) {
        const samples = expected.samples?.[result.candidateId];
        if (samples) {
          expect(result.samples).toEqual(samples);
          expect(Object.keys(result)).toEqual(["candidateId", "value", "samples"]);
          if (expected.statistic !== "other") expect(agrees(result.value, summarize(expected.statistic, samples))).toBe(true);
        } else {
          expect(Object.keys(result)).toEqual(["candidateId", "value"]);
        }
      }
    });
  }

  test("the hit path's p99 is the median of the per-pass p99s it carries", () => {
    const p99 = buildW1Section(sampleResults().results).tests.find((t) => t.id === "p99-ttfb");
    expect(p99?.results.map((r) => r.value)).toEqual([0.55, 0.65, 0.75]);
  });

  test("the segment serve's range p99 carries the Range row's passes, not the full GET's", () => {
    const section = buildW2Section(sampleResults().results);
    expect(section.tests.find((t) => t.id === "p99-full-get")?.results[0]?.samples).toEqual(FULL_GET);
    expect(section.tests.find((t) => t.id === "p99-range-get")?.results[0]?.samples).toEqual(RANGE_GET);
    expect(section.candidates[0]).not.toHaveProperty("_rangeSamples");
  });

  test("a segment serve without a Range row publishes 0 and no samples for the range tests", () => {
    const results = sampleResults().results.filter((r) => !r.metrics.variant);
    const section = buildW2Section(results);
    const rangeP99 = section.tests.find((t) => t.id === "p99-range-get");
    expect(rangeP99?.statistic).toBe("median");
    expect(rangeP99?.results).toEqual([{ candidateId: "varnish-plaintext", value: 0 }]);
    expect(Object.keys(rangeP99!.results[0]!)).toEqual(["candidateId", "value"]);
  });

  test("the miss storm's p50 is the median of the per-burst p99s and its p99 their 99th percentile", () => {
    const section = buildW3Section(sampleResults().results);
    const p50 = section.tests.find((t) => t.id === "p50-ttfb");
    const p99 = section.tests.find((t) => t.id === "p99-ttfb");
    expect(p50?.results[0]).toEqual({ candidateId: "varnish-plaintext", value: 747.5, samples: BURSTS });
    expect(median(BURSTS)).toBe(747.5);
    expect(p99?.statistic).toBe("other");
    expect(p99?.results[0]?.value).toBe(808.1);
    expect(p50?.description).toBe("Median over the 20 bursts of each burst's p99 TTFB with 200 clients on a cold segment");
  });

  test("the origin flap's p50 is a median over phases it does not carry", () => {
    const section = buildW4Section(sampleResults().results);
    const p50 = section.tests.find((t) => t.id === "p50-ttfb");
    expect(p50?.statistic).toBe("median");
    expect(p50?.results).toEqual([{ candidateId: "varnish-plaintext", value: 6.1 }]);
    expect(median(PHASES)).toBe(6.1);
    expect(p50?.description).toBe("Median over five cycles' baseline, flap and recovery phases of each phase's p99 TTFB");
  });
});

describe("buildRun", () => {
  test("keeps the run file's key order", () => {
    const run = buildRun(sampleResults());
    expect(Object.keys(run)).toEqual(["schemaVersion", "id", "label", "publishedAt", "environment", "protocol", "candidates", "sections"]);
    expect(run.schemaVersion).toBe(1);
    expect(run.id).toBe("2026-08-30-macbook-pro");
    expect(run.publishedAt).toBe("2026-08-30");
    expect(run.sections.map((s) => s.id)).toEqual(["hit-path-rps", "segment-serve", "miss-storm", "origin-flap"]);
  });

  test("states the real pass counts per workload", () => {
    const { protocol } = buildRun(sampleResults());
    expect(protocol.warmups).toBe(3);
    expect(protocol.runs).toBe(20);
    expect(protocol.processModel).toContain("3 warmup + 20 measured passes for hit path and segment serve");
    expect(protocol.processModel).toContain("20 cold bursts for the miss storm");
    expect(protocol.processModel).toContain("5 origin cycles of baseline, flap and recovery for origin flap");
  });
});

describe("the site's recomputation", () => {
  test("median interpolates at (n - 1) / 2", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([5])).toBe(5);
  });

  test("summarize covers the four computable statistics", () => {
    expect(summarize("mean", [1, 2, 3, 6])).toBe(3);
    expect(summarize("median", [1, 2, 3, 6])).toBe(2.5);
    expect(summarize("min", [1, 2, 3, 6])).toBe(1);
    expect(summarize("max", [1, 2, 3, 6])).toBe(6);
    expect(() => summarize("mean", [])).toThrow("no samples");
  });

  test("tolerance is half a unit of the value's last printed decimal", () => {
    expect(tolerance(2.575)).toBeCloseTo(0.0005 + 1e-9, 12);
    expect(tolerance(0.45)).toBeCloseTo(0.005 + 1e-9, 12);
    expect(tolerance(200)).toBeCloseTo(0.5 + 1e-9, 12);
    expect(agrees(2.575, 2.575292)).toBe(true);
    expect(agrees(2.575, 2.5756)).toBe(false);
    expect(agrees(0.45, 0.4496455)).toBe(true);
  });
});

describe("enrich", () => {
  test("puts the statistic and samples back into a stripped run file and changes nothing else", () => {
    const raw = sampleResults();
    const fresh = serialize(buildRun(raw));
    const stripped = strip(fresh);
    expect(stripped).not.toBe(fresh);
    expect(stripped).not.toContain('"samples"');

    const dir = mkdtempSync(join(tmpdir(), "http-caching-proxies-enrich-"));
    try {
      const runPath = join(dir, "run.json");
      writeFileSync(runPath, stripped);
      const enriched = enrich(readFileSync(runPath, "utf8"), raw);
      writeFileSync(runPath, enriched.text);
      expect(readFileSync(runPath, "utf8")).toBe(fresh);
      expect(strip(enriched.text)).toBe(stripped);
      expect(enriched.statistics).toBe(11);
      expect(enriched.samples).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is a no-op on a run file that already carries the contract", () => {
    const raw = sampleResults();
    const fresh = serialize(buildRun(raw));
    const enriched = enrich(fresh, raw);
    expect(enriched.text).toBe(fresh);
    expect(enriched.statistics).toBe(0);
    expect(enriched.samples).toBe(0);
  });

  test("the script rewrites the run file in place", () => {
    const raw = sampleResults();
    const fresh = serialize(buildRun(raw));
    const dir = mkdtempSync(join(tmpdir(), "http-caching-proxies-enrich-"));
    try {
      const runPath = join(dir, "run.json");
      const resultsPath = join(dir, "results.json");
      writeFileSync(runPath, strip(fresh));
      writeFileSync(resultsPath, JSON.stringify(raw));
      const proc = Bun.spawnSync([process.execPath, "run", join(import.meta.dirname!, "../src/enrich.ts"), `--run=${runPath}`, `--results=${resultsPath}`]);
      expect(proc.stderr.toString()).toBe("");
      expect(proc.exitCode).toBe(0);
      expect(proc.stdout.toString()).toContain("statistic on 11 tests, samples on 7 results");
      expect(readFileSync(runPath, "utf8")).toBe(fresh);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses raw results that no longer reproduce a published value", () => {
    const stripped = strip(serialize(buildRun(sampleResults())));
    const perturbed = sampleResults();
    perturbed.results[0]!.metrics.p99_ttfb!.value = 0.56;
    expect(() => enrich(stripped, perturbed)).toThrow("result hit-path-rps/p99-ttfb/varnish-plaintext: published value 0.55, rebuilt 0.56");
  });

  test("refuses samples whose median no longer rounds to the published value", () => {
    const stripped = strip(serialize(buildRun(sampleResults())));
    const perturbed = sampleResults();
    const storm = perturbed.results.find((r) => r.workload === "miss-storm")!;
    storm.samplesMs = storm.samplesMs.map((v) => v + 1);
    expect(() => enrich(stripped, perturbed)).toThrow("result miss-storm/p50-ttfb/varnish-plaintext: the median of its samples is 748.5, not 747.5");
  });

  test("refuses a run file that is not in the importer's layout", () => {
    const raw = sampleResults();
    expect(() => enrich(JSON.stringify(buildRun(raw)), raw)).toThrow("not in the importer's layout");
    expect(() => enrich(serialize(buildRun(raw)).trimEnd(), raw)).toThrow("not in the importer's layout");
  });

  test("refuses a published result the rebuilt run does not have", () => {
    const raw = sampleResults();
    const stripped = strip(serialize(buildRun(raw)));
    const extra = stripped.replace('"candidateId": "nginx-plaintext"', '"candidateId": "haproxy-plaintext"');
    expect(extra).not.toBe(stripped);
    expect(() => enrich(JSON.stringify(JSON.parse(extra), null, 2) + "\n", raw)).toThrow("result hit-path-rps/p50-ttfb/haproxy-plaintext: not in the rebuilt run");
  });

  test("refuses to overwrite a statistic or samples that are already there and differ", () => {
    const raw = sampleResults();
    const otherStatistic = buildRun(raw);
    otherStatistic.sections[0]!.tests[0]!.statistic = "mean";
    expect(() => enrich(serialize(otherStatistic), raw)).toThrow("test hit-path-rps/p50-ttfb: already has statistic mean, rebuilt median");
    const otherSamples = buildRun(raw);
    otherSamples.sections[0]!.tests[1]!.results[0]!.samples = [0.5, 0.6, 0.55, 0.53, 0.58];
    expect(() => enrich(serialize(otherSamples), raw)).toThrow("result hit-path-rps/p99-ttfb/varnish-plaintext: already has different samples");
  });
});
