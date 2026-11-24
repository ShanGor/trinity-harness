#!/usr/bin/env bash
# Requires a separately provisioned, empty disposable PostgreSQL + pgvector DB.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
: "${TRINITY_MEMORY_TEST_DATABASE_URL:?Set an empty disposable pgvector database URL}"
: "${MEMORY_EMBEDDING_MODEL:?Set the explicitly selected embedding provider/model}"
DATABASE_URL="$TRINITY_MEMORY_TEST_DATABASE_URL" pnpm db:migrate
TRINITY_RUN_MEMORY_EVAL=1 pnpm test apps/control-worker/test/memory-real-provider.test.ts
