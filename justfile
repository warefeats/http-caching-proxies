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

import result="results.json":
    bun run src/import.ts --results={{result}}

import-run result="results.json":
    bun run src/import-run.ts --results={{result}}

# --- cloud benchmark rig ---

export AWS_DEFAULT_REGION := "us-east-1"
export CDK_DEFAULT_ACCOUNT := "735853783919"
export CDK_DEFAULT_REGION := "us-east-1"

rig-deploy:
    cd infra && bunx cdk deploy WarefeatsProxyBench --require-approval never

rig-cloud matrix="smoke" engine="c7g.metal":
    gh workflow run proxy-bench-cloud.yml --ref "$(git branch --show-current)" -f matrix={{matrix}} -f engine_type={{engine}} --repo warefeats/http-caching-proxies

rig-watch:
    gh run watch --repo warefeats/http-caching-proxies "$(gh run list --repo warefeats/http-caching-proxies --workflow proxy-bench-cloud.yml --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status

rig-results:
    #!/usr/bin/env bash
    set -euo pipefail
    BUCKET=$(aws cloudformation describe-stacks --stack-name WarefeatsProxyBench --query "Stacks[0].Outputs[?OutputKey=='ResultsBucketName'].OutputValue" --output text)
    aws s3 ls "s3://$BUCKET/bench-runs/" --recursive | tail -20

rig-destroy:
    cd infra && bunx cdk destroy WarefeatsProxyBench --force

setup-oidc:
    #!/usr/bin/env bash
    set -euo pipefail
    REPO_ID=$(gh api repos/warefeats/http-caching-proxies -q .id)
    aws cloudformation deploy \
        --template-file infra/github-oidc-role.yml \
        --stack-name http-caching-proxies-github-oidc \
        --capabilities CAPABILITY_NAMED_IAM \
        --no-fail-on-empty-changeset \
        --parameter-overrides \
            ExistingOidcProviderArn=arn:aws:iam::735853783919:oidc-provider/token.actions.githubusercontent.com \
            GitHubOrg=warefeats \
            GitHubRepository=http-caching-proxies \
            GitHubOrgId=322872963 \
            GitHubRepositoryId=$REPO_ID
    ROLE_ARN=$(aws cloudformation describe-stacks \
        --stack-name http-caching-proxies-github-oidc \
        --query "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue" \
        --output text)
    gh secret set AWS_DEPLOY_ROLE_ARN --body "$ROLE_ARN" --repo warefeats/http-caching-proxies
    echo "OIDC role: $ROLE_ARN"
