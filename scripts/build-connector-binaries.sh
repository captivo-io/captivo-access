#!/usr/bin/env bash
# Builds the connector as a program for hosts without Docker (Windows service,
# Linux systemd unit) and writes, into the output directory:
#   captivo-connector_<version>_<os>_<arch>.tar.gz | .zip
#   SHA256SUMS
# `connector service install` and `connector update` read exactly these names
# (connector/selfupdate.go assetName). Run on a release tag by publish.yml.
#
#   scripts/build-connector-binaries.sh 2.65.0 dist
set -euo pipefail
cd "$(dirname "$0")/.."

version=${1:?version, e.g. 2.65.0}
out=${2:-dist}
case "$version" in [0-9]*.[0-9]*.[0-9]*) ;; *) echo "version must be X.Y.Z" >&2; exit 2 ;; esac
rm -rf "${out:?}"
mkdir -p "$out"
out=$(cd "$out" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

for target in linux/amd64 linux/arm64 windows/amd64; do
  os=${target%/*}
  arch=${target#*/}
  exe=connector
  [ "$os" = windows ] && exe=connector.exe
  dir="$work/$os-$arch/captivo-connector"
  mkdir -p "$dir"
  (cd connector && CGO_ENABLED=0 GOOS=$os GOARCH=$arch \
    go build -trimpath -ldflags "-s -w -X main.Version=$version" -o "$dir/$exe" .)
  cat > "$dir/README.txt" <<TXT
Captivo Access connector $version ($os/$arch), installed as a program.
Serves web apps, databases, Kubernetes clusters and TCP tunnels. Remote
desktops and isolated browsers need the Docker install.

  $exe service install --manager-url URL --dataplane-url URL --pair-code CODE
  $exe update
  $exe service uninstall [--keep-data]

The console's Connectors page shows the install command with these filled in.
TXT
  name="captivo-connector_${version}_${os}_${arch}"
  if [ "$os" = windows ]; then
    (cd "$work/$os-$arch" && zip -qr "$out/$name.zip" captivo-connector)
  else
    tar -C "$work/$os-$arch" -czf "$out/$name.tar.gz" captivo-connector
  fi
done

(cd "$out" && sha256sum captivo-connector_* > SHA256SUMS)
echo "wrote:"; ls -l "$out"
