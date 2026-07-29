#!/bin/sh
set -eu

lock_file=spec.lock
read_lock='const f=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(f[process.argv[2]])'

if [ "$#" -eq 0 ]; then
  tag=$(node -e "$read_lock" "$lock_file" tag)
  expected_commit=$(node -e "$read_lock" "$lock_file" commit)
  expected_digest=$(node -e "$read_lock" "$lock_file" snapshotSha256)
  test "$(node scripts/spec-digest.mjs vendor/spec)" = "$expected_digest" || {
    echo "vendored snapshot verification failed" >&2
    exit 1
  }
  echo "verified vendored ${tag} (${expected_commit})"
  exit 0
fi

if [ "$#" -ne 2 ]; then
  echo "usage: update-spec.sh /path/to/OpenMoat-Spec <signed-tag>" >&2
  exit 2
fi

spec_repo=$1
tag=$2
git -C "$spec_repo" tag -v "$tag" >/dev/null
actual_commit=$(git -C "$spec_repo" rev-parse "${tag}^{}")
snapshot=$(mktemp -d "${TMPDIR:-/tmp}/openmoat-spec.XXXXXX")
trap 'rm -rf "$snapshot"' EXIT
git -C "$spec_repo" archive "$tag" schemas fixtures cases conformance | tar -x -C "$snapshot"
actual_digest=$(node scripts/spec-digest.mjs "$snapshot")
rsync -a --delete "$snapshot/" vendor/spec/
test "$(node scripts/spec-digest.mjs vendor/spec)" = "$actual_digest"
node -e '
const fs = require("fs");
const [, file, tag, commit, snapshotSha256] = process.argv;
fs.writeFileSync(file, JSON.stringify({ tag, commit, snapshotSha256 }, null, 2) + "\n");
' "$lock_file" "$tag" "$actual_commit" "$actual_digest"
echo "vendored ${tag} (${actual_commit})"
