# HTTP Caching Proxies Benchmark

The benchmark runner behind [warefeats.com/benchmarks/http-caching-proxies-hls/](https://warefeats.com/benchmarks/http-caching-proxies-hls/). Measures Varnish Cache, Vinyl Cache, and NGINX head-to-head across four HLS delivery workloads: hit-path TTFB, segment serve, miss-storm coalescing, and origin-flap grace.

Source: [github.com/warefeats/http-caching-proxies](https://github.com/warefeats/http-caching-proxies)

## Requirements

- [Bun](https://bun.sh) 1.4+
- Docker Compose v2.17+ (for `additional_contexts` support in the Vinyl engine build)
- [oha](https://github.com/hatoo/oha) — the HTTP load generator used by the runner
- A [Vinyl Cache](https://vinyl-cache.org) source checkout for the vinyl engine (set `VINYL_CACHE_DIR` in `.env`, see `.env.example`)

## Running

Smoke test (plaintext hit-path only, one session per engine):

```sh
bun run smoke
```

Full benchmark (all 22 sessions across 14 compose cycles):

```sh
bun run bench
```

Per-engine batches with incremental saves:

```sh
bun run src/run.ts --engine=varnish
bun run src/run.ts --engine=vinyl
bun run src/run.ts --engine=nginx
```

Resume a partial run (skips already-completed cells):

```sh
bun run src/run.ts --resume
bun run src/run.ts --engine=vinyl --resume
```

Filter by workload:

```sh
bun run src/run.ts --workload=miss-storm
```

Results are written incrementally to `results.json`.

## Importing results into the site

The import script reads `results.json` and writes a benchmark entry into the warefeats.com catalog:

```sh
just import ../warefeats.com/web/public/data/benchmarks.json
```

Or directly:

```sh
bun run src/import.ts --catalog=../warefeats.com/web/public/data/benchmarks.json
```

## Results

See [RESULTS.md](RESULTS.md) for the published run data, rig specs, version table, and anomaly notes.

## Cleanup

Tear down all benchmark Docker Compose projects:

```sh
just clean
```
