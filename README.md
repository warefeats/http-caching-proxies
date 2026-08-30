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

## Publishing results

The import script reads `results.json` and writes a run file under `runs/`, updating `benchmark.json` to reference it:

```sh
just import
```

Or with an explicit results path:

```sh
bun run src/import.ts --results=results.json
```

To publish to the site, commit the new run file and `benchmark.json`, then in the site repo (`warefeats/warefeats.com`) bump this slug's `ref` in `web/data/registry.json` to the new SHA, run `bun run sync`, and merge.

## Results

See [RESULTS.md](RESULTS.md) for the published run data, rig specs, version table, and anomaly notes.

## Cloud rig

An opt-in CDK stack (`WarefeatsProxyBench`) that creates launch templates, a cluster placement group, a security group, an IAM instance role, and a private S3 results bucket for ephemeral EC2 benchmark runs. No instances are created at deploy time; the `proxy-bench-cloud.yml` workflow launches and terminates them per run.

### Architecture

Three arm64 EC2 instances in one AZ, connected via a cluster placement group for consistent sub-microsecond network latency:

| Role | Default type | vCPU | Purpose |
|---|---|---|---|
| engine | c7g.metal | 64 | Proxy under test (+ haproxy for PROXYv2 topology). Bare metal eliminates noisy-neighbor variance. |
| client | c7g.xlarge | 4 | Load generator (oha) and benchmark orchestrator. |
| origin | c7g.xlarge | 4 | TS origin server serving synthetic HLS manifests and segments. |

Uses the default VPC (zero cost, no NAT gateway). Security group allows only intra-group traffic. SSM Session Manager for access (no SSH keys). All instances auto-terminate after 120 minutes (`shutdown -h +120` in user data + `InstanceInitiatedShutdownBehavior=terminate`).

### vCPU quota

c7g.metal requires 64 vCPUs. The full rig (64 + 4 + 4 = 72 vCPUs) exceeds the default On-Demand Standard quota of 64 vCPUs (quota code `L-1216C47A`).

Check current quota:

```sh
aws service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A --query 'Quota.Value'
```

Request increase to 128 vCPUs (one-time):

```sh
aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-1216C47A --desired-value 128
```

Fallback: pass `engine_type=c7g.4xlarge` (16 vCPU, total 24) to the workflow. Results will still be noise-free relative to Docker-on-laptop, but not bare-metal isolated.

### Cost estimate (us-east-1 on-demand)

| Instance | $/hr | Full run (~1 hr) | Smoke (~20 min) |
|---|---|---|---|
| 1x c7g.metal | $1.9264 | $1.93 | $0.64 |
| 2x c7g.xlarge | $0.2408 | $0.24 | $0.08 |
| **Total** | **$2.1672** | **$2.17** | **$0.72** |

With c7g.4xlarge fallback: $0.4816 + $0.2408 = **$0.72/hr** ($0.24 smoke).

S3 storage and SSM are negligible. No NAT gateway, no load balancer, no EBS beyond the 30 GB gp3 root volume included in each launch template.

### Guardrails against runaway spend

1. `shutdown -h +120` in user data — hard 2-hour wall clock.
2. `InstanceInitiatedShutdownBehavior=terminate` — shutdown deletes the instance.
3. `if: always()` cleanup step in the workflow terminates all three instances.
4. Scheduled reaper job runs after every workflow and terminates anything tagged `Component=proxy-bench` older than 3 hours.
5. Tags (`Project=warefeats`, `Component=proxy-bench`) on all resources for cost-dashboard filtering.
6. Concurrency group prevents parallel runs from stacking up instances.

### Setup

One-time OIDC role creation (reads the repo's numeric ID automatically):

```sh
just setup-oidc
```

Deploy the stack:

```sh
just rig-deploy
```

### Run a benchmark

```sh
just rig-cloud              # smoke run (~20 min, ~$0.72)
just rig-cloud full         # full run (~1 hr, ~$2.17)
just rig-cloud smoke c7g.4xlarge  # fallback instance type
just rig-watch              # tail the latest run
just rig-results            # list results in S3
```

### Build the Vinyl GHCR image

The metal instance pulls a prebuilt Vinyl image instead of compiling from source:

```sh
gh workflow run build-vinyl.yml -f vinyl_ref=main
```

This pushes `ghcr.io/warefeats/vinyl-cache:<ref>` and `:latest`.

### Import cloud results

Download the results artifact from the workflow run, then:

```sh
just import-run
```

Or with explicit paths:

```sh
bun run src/import-run.ts --results=results.json --metadata=metadata.json
```

This writes a run file under `runs/` and updates `benchmark.json`. Commit and follow the publish flow described above.

### Tear down

```sh
just rig-destroy
```

## Cleanup

Tear down all benchmark Docker Compose projects:

```sh
just clean
```
