#!/bin/sh
set -eu

lock_file=${2:-spec.lock}
read_lock='const f=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(f[process.argv[2]])'
tag=$(node -e "$read_lock" "$lock_file" tag)
expected_commit=$(node -e "$read_lock" "$lock_file" commit)
expected_digest=$(node -e "$read_lock" "$lock_file" snapshotSha256)

if [ "$#" -eq 0 ]; then
  test "$(node scripts/spec-digest.mjs vendor/spec)" = "$expected_digest" || {
    echo "vendored snapshot verification failed" >&2
    exit 1
  }
  echo "verified vendored ${tag} (${expected_commit})"
  exit 0
fi

spec_repo=$1
actual_commit=$(git -C "$spec_repo" rev-parse "${tag}^{}")

test "$actual_commit" = "$expected_commit" || {
  echo "spec tag commit mismatch" >&2
  exit 1
}

snapshot=$(mktemp -d "${TMPDIR:-/tmp}/openmoat-spec.XXXXXX")
trap 'rm -rf "$snapshot"' EXIT
git -C "$spec_repo" archive "$tag" schemas fixtures cases | tar -x -C "$snapshot"
actual_digest=$(node scripts/spec-digest.mjs "$snapshot")
test "$actual_digest" = "$expected_digest" || {
  echo "spec snapshot digest mismatch" >&2
  exit 1
}
rsync -a --delete "$snapshot/" vendor/spec/
test "$(node scripts/spec-digest.mjs vendor/spec)" = "$expected_digest"
echo "vendored ${tag} (${actual_commit})"
