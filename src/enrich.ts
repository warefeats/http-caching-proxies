import { readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { buildRun, type RawResults, type TestStatistic } from "./import";

/** A statistic the site recomputes from a result's samples. */
export type ComputedStatistic = Exclude<TestStatistic, "other">;

export interface Enriched {
  text: string;
  /** Tests that received a `statistic`. */
  statistics: number;
  /** Results that received `samples`. */
  samples: number;
}

/** The median the site recomputes: linear interpolation at (n - 1) / 2 of the sorted samples. */
export function median(samples: number[]): number {
  const s = [...samples].sort((a, b) => a - b);
  const idx = (s.length - 1) / 2;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo]!;
  return s[lo]! + (s[hi]! - s[lo]!) * (idx - lo);
}

/** The value the site recomputes from `samples` for a statistic. */
export function summarize(statistic: ComputedStatistic, samples: number[]): number {
  if (samples.length === 0) throw new Error(`cannot take the ${statistic} of no samples`);
  switch (statistic) {
    case "mean": return samples.reduce((a, b) => a + b, 0) / samples.length;
    case "median": return median(samples);
    case "min": return Math.min(...samples);
    case "max": return Math.max(...samples);
  }
}

/** The site's tolerance for a recomputed value: half a unit in the value's last printed decimal, plus float slack. */
export function tolerance(value: number): number {
  const decimals = String(value).split(".")[1]?.length ?? 0;
  return 0.5 * 10 ** -decimals + 1e-9;
}

export function agrees(value: number, computed: number): boolean {
  return Math.abs(computed - value) <= tolerance(value);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function recordsOf(x: unknown, what: string): Record<string, unknown>[] {
  if (!Array.isArray(x)) throw new Error(`${what} is not an array`);
  return x.map((item, i) => {
    if (!isRecord(item)) throw new Error(`${what}[${i}] is not an object`);
    return item;
  });
}

function sameNumbers(a: unknown, b: number[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Adds each test's `statistic` and each result's `samples` to a run file that was published without them.
 * The run is rebuilt from the raw results; every published value must match the rebuild exactly, and every
 * sample array must reproduce its value under the site's recomputation, or nothing is written. Nothing else changes.
 */
export function enrich(text: string, raw: RawResults): Enriched {
  const old: unknown = JSON.parse(text);
  if (JSON.stringify(old, null, 2) + "\n" !== text) {
    throw new Error("the run file is not in the importer's layout (JSON.stringify(run, null, 2) plus a newline); refusing to rewrite it");
  }
  if (!isRecord(old)) throw new Error("the run file is not an object");

  const fresh = buildRun(raw);
  let statistics = 0;
  let samples = 0;

  for (const oldSection of recordsOf(old.sections, "sections")) {
    const sectionId = String(oldSection.id);
    const freshSection = fresh.sections.find((s) => s.id === oldSection.id);
    if (!freshSection) throw new Error(`section ${sectionId}: not in the rebuilt run`);

    for (const oldTest of recordsOf(oldSection.tests, `${sectionId}.tests`)) {
      const testId = `${sectionId}/${String(oldTest.id)}`;
      const freshTest = freshSection.tests.find((t) => t.id === oldTest.id);
      if (!freshTest) throw new Error(`test ${testId}: not in the rebuilt run`);

      for (const oldResult of recordsOf(oldTest.results, `${testId}.results`)) {
        const resultId = `${testId}/${String(oldResult.candidateId)}`;
        const freshResult = freshTest.results.find((r) => r.candidateId === oldResult.candidateId);
        if (!freshResult) throw new Error(`result ${resultId}: not in the rebuilt run`);
        if (freshResult.value !== oldResult.value) {
          throw new Error(`result ${resultId}: published value ${String(oldResult.value)}, rebuilt ${freshResult.value}`);
        }
        if (!freshResult.samples) continue;
        if (freshTest.statistic && freshTest.statistic !== "other") {
          const computed = summarize(freshTest.statistic, freshResult.samples);
          if (!agrees(freshResult.value, computed)) {
            throw new Error(`result ${resultId}: the ${freshTest.statistic} of its samples is ${computed}, not ${freshResult.value}`);
          }
        }
        if ("samples" in oldResult) {
          if (!sameNumbers(oldResult.samples, freshResult.samples)) throw new Error(`result ${resultId}: already has different samples`);
          continue;
        }
        oldResult.samples = freshResult.samples;
        samples += 1;
      }

      if (!freshTest.statistic) continue;
      if ("statistic" in oldTest) {
        if (oldTest.statistic !== freshTest.statistic) {
          throw new Error(`test ${testId}: already has statistic ${String(oldTest.statistic)}, rebuilt ${freshTest.statistic}`);
        }
        continue;
      }
      oldTest.statistic = freshTest.statistic;
      statistics += 1;
    }
  }

  return { text: JSON.stringify(old, null, 2) + "\n", statistics, samples };
}

if (import.meta.main) {
  const root = join(import.meta.dirname!, "..");
  const runArg = process.argv.find((a) => a.startsWith("--run="))?.split("=")[1];
  const resultsArg = process.argv.find((a) => a.startsWith("--results="))?.split("=")[1];
  if (!runArg) {
    console.error("usage: bun run src/enrich.ts --run=runs/<id>.json [--results=results.json]");
    process.exit(1);
  }
  const runPath = resolve(runArg);
  const resultsPath = resultsArg ? resolve(resultsArg) : join(root, "results.json");

  const raw: RawResults = JSON.parse(readFileSync(resultsPath, "utf8"));
  const enriched = enrich(readFileSync(runPath, "utf8"), raw);
  writeFileSync(runPath, enriched.text);
  console.log(`Enriched ${runArg}: statistic on ${enriched.statistics} tests, samples on ${enriched.samples} results`);
}
