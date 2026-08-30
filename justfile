set dotenv-load

check:
    bun run check

test:
    bun test

bench:
    bun run src/run.ts

smoke:
    bun run src/run.ts --smoke

clean:
    #!/usr/bin/env bash
    set -euo pipefail
    cd compose
    for f in docker-compose.*.yml; do
        p=$(basename "$f" .yml | sed 's/docker-compose\./bench-/')
        docker compose -f "$f" -p "$p" down -v --remove-orphans 2>/dev/null || true
    done

import catalog:
    bun run src/import.ts --catalog={{catalog}}
