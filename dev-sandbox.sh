#!/usr/bin/env bash
# Isolated omp sandbox (HOME=./.sandbox) wired to the mock endpoint + this extension.
# Usage: ./dev-sandbox.sh [omp args...]   e.g. ./dev-sandbox.sh -p --model character/alice--mock-small "hi"
set -e; cd "$(dirname "$0")"; ROOT=$PWD; SB=$ROOT/.sandbox; PORT=${MOCK_PORT:-18555}
export PATH=$HOME/.bun/bin:$PATH
mkdir -p $SB/.omp/agent $SB/proj/.omp
[ -f $SB/.omp/agent/models.yml ] || sed "s/__PORT__/$PORT/" examples/models.yml > $SB/.omp/agent/models.yml
[ -f $SB/.omp/agent/config.yml ] && grep -q "setupWizard: false" $SB/.omp/agent/config.yml || cp examples/sandbox-config.yml $SB/.omp/agent/config.yml
[ -f $SB/.omp/agent/system-inject.yml ] || cp examples/system-inject.yml examples/alice.md $SB/.omp/agent/
curl -s localhost:$PORT/v1/models >/dev/null || (MOCK_PORT=$PORT MOCK_CAPTURE=$SB/capture.jsonl nohup bun test/mock-server.ts >/dev/null 2>&1 &) ; sleep 0.5
cd $SB/proj && HOME=$SB omp -e $ROOT/src/index.ts "$@"
