#!/usr/bin/env bash
set -euo pipefail

# FIFO queues with a redrive policy: the JSON payload for RedrivePolicy
# contains commas, so it cannot go through the CLI `--attributes` shorthand.
awslocal sqs create-queue --cli-input-json file:///etc/localstack/queues/dlq.json
echo "[init] ensured wager-transactions-dlq.fifo"

awslocal sqs create-queue --cli-input-json file:///etc/localstack/queues/main.json
echo "[init] ensured wager-transactions.fifo"
