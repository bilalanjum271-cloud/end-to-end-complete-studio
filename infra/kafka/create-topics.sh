#!/usr/bin/env bash
# Creates the topics in topics.yaml (and their .dlq twins) on the local single-broker cluster.
# Usage: BROKER=localhost:9092 ./infra/kafka/create-topics.sh   (run inside or against the redpanda container)
set -euo pipefail
BROKER="${BROKER:-localhost:9092}"
RF="${REPLICATION:-1}"
dir="$(cd "$(dirname "$0")" && pwd)"
grep -E '^\s+- \{ name:' "$dir/topics.yaml" | while read -r line; do
  name=$(sed -E 's/.*name: ([^,]+),.*/\1/' <<<"$line")
  parts=$(sed -E 's/.*partitions: ([0-9]+),.*/\1/' <<<"$line")
  days=$(sed -E 's/.*retention_days: ([0-9]+),.*/\1/' <<<"$line")
  rpk topic create "$name" --brokers "$BROKER" -p "$parts" -r "$RF" -c "retention.ms=$((days*86400000))" || true
  if grep -q 'dlq: true' <<<"$line"; then
    rpk topic create "$name.dlq" --brokers "$BROKER" -p "$parts" -r "$RF" -c "retention.ms=$((30*86400000))" || true
  fi
done
