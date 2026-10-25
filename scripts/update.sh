#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Mission Control auf ein anderes Release umstellen. Einstellungen (.env), Geheimnisse und Daten bleiben.
# Holt das install.sh des Ziel-Release (Prüfsumme aus SHA256SUMS) und führt es mit den bisherigen
# Optionen aus install.conf aus.
#
# Aufruf: update.sh --version X|latest [--bundle DATEI] [--image-archive DATEI] [--force]
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"
require_root

VERSION="" BUNDLE="" EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?}"; shift 2 ;;
    --bundle) BUNDLE="$(readlink -f "${2:?}")"; shift 2 ;;
    --image-archive) EXTRA+=(--image-archive "$(readlink -f "${2:?}")"); shift 2 ;;
    --force) EXTRA+=(--force); shift ;;
    -h|--help) sed -n '3,7p' "$0"; exit 0 ;;
    *) die 1 "Unbekannte Option: $1" ;;
  esac
done
[ -n "$VERSION" ] || die 1 "Bitte --version angeben (z. B. --version 0.3.0 oder --version latest)."
[ -f "$MC_DIR/VERSION" ] || die 1 "Mission Control ist nicht installiert ($MC_DIR fehlt) – install.sh verwenden."

CONF="$MC_DIR/install.conf"
AGENT_USER="$(env_get "$CONF" AGENT_USER)"
DESKTOP_DIR="$(env_get "$CONF" DESKTOP_DIR)"
ARGS=(--version "$VERSION")
[ -n "$AGENT_USER" ] && ARGS+=(--user "$AGENT_USER")
[ -n "$DESKTOP_DIR" ] && ARGS+=(--desktop-dir "$DESKTOP_DIR")
[ "$(env_get "$CONF" NO_DESKTOP)" = 1 ] && ARGS+=(--no-desktop)

log "Installiert: $(cat "$MC_DIR/VERSION"), Ziel: ${VERSION#v}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ -n "$BUNDLE" ]; then
  tar -xzf "$BUNDLE" -C "$WORK"
  INSTALLER="$(find "$WORK" -mindepth 3 -maxdepth 3 -path '*/scripts/install.sh' | head -n 1)"
  [ -n "$INSTALLER" ] || die 1 "Kein scripts/install.sh im Archiv."
  ARGS+=(--bundle "$BUNDLE")
else
  if [ "$VERSION" = latest ]; then
    VERSION="$(curl -fsSI "https://github.com/$MC_REPO/releases/latest" | sed -n 's|^[Ll]ocation: .*/tag/v\{0,1\}\([^[:space:]]*\).*|\1|p')"
    [ -n "$VERSION" ] || die 1 "Neuestes Release konnte nicht ermittelt werden."
    ARGS[1]="$VERSION"
  fi
  BASE="https://github.com/$MC_REPO/releases/download/v${VERSION#v}"
  curl -fsSL --retry 3 -o "$WORK/install.sh" "$BASE/install.sh" || die 1 "Download fehlgeschlagen: $BASE/install.sh"
  curl -fsSL --retry 3 -o "$WORK/SHA256SUMS" "$BASE/SHA256SUMS" || die 1 "Download fehlgeschlagen: $BASE/SHA256SUMS"
  (cd "$WORK" && grep ' \*\{0,1\}install.sh$' SHA256SUMS | sha256sum -c --quiet -) || die 1 "Prüfsumme von install.sh stimmt nicht."
  INSTALLER="$WORK/install.sh"
fi

bash "$INSTALLER" "${ARGS[@]}" "${EXTRA[@]}"
