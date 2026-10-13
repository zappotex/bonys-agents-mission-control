#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Baut das Release-Archiv für Agent-PCs: dist-release/bonys-mission-control-<version>.tar.gz,
# dazu install.sh und SHA256SUMS. Nur für Entwicklung/CI – nicht Teil der Installation.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$ROOT/package.json")"
OUT="${1:-$ROOT/dist-release}"
NAME="bonys-mission-control-$VERSION"

# Versionen müssen überall übereinstimmen
grep -q "^DEFAULT_VERSION=\"$VERSION\"$" "$ROOT/scripts/install.sh" || { echo "install.sh: DEFAULT_VERSION ≠ $VERSION" >&2; exit 1; }
grep -q "\"version\": \"$VERSION\"" "$ROOT/agentpc.json" || { echo "agentpc.json: version ≠ $VERSION" >&2; exit 1; }
grep -q "/v$VERSION/install.sh" "$ROOT/agentpc.json" || { echo "agentpc.json: install_url ≠ v$VERSION" >&2; exit 1; }
grep -q "^MISSION_CONTROL_VERSION=$VERSION$" "$ROOT/.env.example" || { echo ".env.example: Version ≠ $VERSION" >&2; exit 1; }

rm -rf "$OUT"
STAGE="$OUT/$NAME"
mkdir -p "$STAGE/scripts" "$STAGE/share"
cp "$ROOT/deploy/compose.yaml" "$ROOT/.env.example" "$ROOT/agentpc.json" "$ROOT/LICENSE" "$STAGE/"
cp "$ROOT/deploy/mission-control.svg" "$STAGE/share/"
for script in install update uninstall reset-secrets ensure-secrets lib; do
  cp "$ROOT/scripts/$script.sh" "$STAGE/scripts/"
done
chmod 755 "$STAGE"/scripts/*.sh
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='2026-01-01 00:00Z' \
  -C "$OUT" -czf "$OUT/$NAME.tar.gz" "$NAME"
rm -rf "$STAGE"
cp "$ROOT/scripts/install.sh" "$ROOT/agentpc.json" "$OUT/"
(cd "$OUT" && sha256sum "$NAME.tar.gz" install.sh agentpc.json > SHA256SUMS)
echo "$OUT/$NAME.tar.gz"
