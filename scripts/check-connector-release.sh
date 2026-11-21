#!/usr/bin/env bash
# Fails when connector code changed since the release named in
# src/lib/updates/connector-release.ts (CONNECTOR_RELEASE) without that marker
# being raised: the console would then tell admins their connectors are current
# while the published connector image has something new. Run on a release tag
# (publish.yml) and before tagging. Needs the tags fetched.
set -euo pipefail
cd "$(dirname "$0")/.."

file=src/lib/updates/connector-release.ts
marker=$(sed -n 's/^export const CONNECTOR_RELEASE = "\([0-9.]*\)";$/\1/p' "$file")
paths=$(sed -n 's/^export const CONNECTOR_PATHS = \[\(.*\)\] as const;$/\1/p' "$file" | tr -d '"' | tr ',' ' ')
if [ -z "$marker" ] || [ -z "$paths" ]; then
  echo "check-connector-release: cannot read CONNECTOR_RELEASE / CONNECTOR_PATHS from $file" >&2
  exit 1
fi
if ! git rev-parse -q --verify "refs/tags/v$marker" >/dev/null; then
  # The marker names the release being tagged: nothing to compare yet.
  if [ "$(cat VERSION)" = "$marker" ]; then echo "connector release $marker (this release)"; exit 0; fi
  echo "check-connector-release: CONNECTOR_RELEASE $marker is neither a tag nor VERSION" >&2
  exit 1
fi
# shellcheck disable=SC2086
changed=$(git diff --name-only "v$marker" HEAD -- $paths)
if [ -n "$changed" ]; then
  echo "check-connector-release: connector code changed since v$marker; set CONNECTOR_RELEASE in $file to $(cat VERSION):" >&2
  echo "$changed" | sed 's/^/  /' >&2
  exit 1
fi
echo "connector release $marker: no connector change since"
