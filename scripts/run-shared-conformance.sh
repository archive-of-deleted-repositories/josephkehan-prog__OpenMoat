#!/bin/sh
set -eu

set -- --binary node --binary dist/cli.js
for case_file in vendor/spec/cases/*.json; do
  set -- "$@" --case "$case_file"
done

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor/spec uv run --with pyyaml --with jsonschema \
  python -m conformance.runner "$@" --timeout 10 --json
