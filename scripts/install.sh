#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Bony's Agents Mission Control auf einem Agent-PC (Debian 13, amd64/arm64) installieren.
# Läuft ohne Rückfragen, ist idempotent (erneuter Aufruf = reparieren bzw. auf die Version umstellen).
# Dokumentation: docs/installation-agent-pc.md
#
# Exit-Codes: 0 ok · 1 Fehler · 2 Voraussetzung fehlt · 3 zu wenig RAM/Festplatte · 4 Healthcheck rot
set -euo pipefail

DEFAULT_VERSION="0.2.3"
REPO="zappotex/bonys-agents-mission-control"

usage() {
  cat <<'USAGE'
Aufruf: install.sh [Optionen]

  --version X         Release-Version (z. B. 0.1.0 oder v0.1.0, "latest" = neuestes Release)
  --user NAME         Agent-Benutzer für die Desktop-Verknüpfung (Standard: agent, falls vorhanden)
  --desktop-dir DIR   Schreibtisch-Ordner des Benutzers (Standard: aus xdg-user-dirs)
  --port N            Port der Weboberfläche auf 127.0.0.1 (Standard: 8787 bzw. bisheriger Wert)
  --install-deps      fehlende Pakete (docker.io, docker-compose, curl) per apt nachinstallieren
  --bundle DATEI      Release-Archiv lokal verwenden statt herunterladen
  --image-archive F   Docker-Image aus Datei laden (docker load) statt aus der Registry ziehen
  --no-desktop        keine Desktop-Verknüpfung anlegen
  --force             Mindestanforderungen (RAM/Festplatte) nur warnen statt abbrechen
  -h, --help          diese Hilfe
USAGE
}

say() { printf '[mission-control] %s\n' "$*"; }
fail() { local code="$1"; shift; printf '[mission-control] FEHLER: %s\n' "$*" >&2; exit "$code"; }

VERSION="$DEFAULT_VERSION" AGENT_USER="" DESKTOP_DIR="" PORT="" INSTALL_DEPS=0 BUNDLE="" IMAGE_ARCHIVE=""
NO_DESKTOP=0 FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?}"; shift 2 ;;
    --user) AGENT_USER="${2:?}"; shift 2 ;;
    --desktop-dir) DESKTOP_DIR="${2:?}"; shift 2 ;;
    --port) PORT="${2:?}"; shift 2 ;;
    --install-deps) INSTALL_DEPS=1; shift ;;
    --bundle) BUNDLE="$(readlink -f "${2:?}")"; shift 2 ;;
    --image-archive) IMAGE_ARCHIVE="$(readlink -f "${2:?}")"; shift 2 ;;
    --no-desktop) NO_DESKTOP=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail 1 "Unbekannte Option: $1" ;;
  esac
done

TOTAL=10
step() { STEP=$(( ${STEP:-0} + 1 )); printf '[mission-control] (%d/%d) %s\n' "$STEP" "$TOTAL" "$*"; }

[ "$(id -u)" -eq 0 ] || fail 1 "Bitte als root ausführen (z. B. mit sudo)."
if [ -n "$PORT" ]; then
  case "$PORT" in *[!0-9]*) fail 1 "Ungültiger Port: $PORT" ;; esac
  if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then fail 1 "Ungültiger Port: $PORT"; fi
fi

# ---------------------------------------------------------------- 1. System
step "System prüfen"
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) fail 2 "Nicht unterstützte Architektur: $(uname -m) (nur amd64 und arm64)" ;;
esac
os_field() { sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" /etc/os-release 2>/dev/null; }
OS_ID="$(os_field ID)-$(os_field VERSION_ID)"
[ "$OS_ID" = "debian-13" ] || say "Hinweis: getestet für Debian 13, gefunden: $OS_ID"
say "Architektur $ARCH, System $OS_ID"

# ---------------------------------------------------------------- 2. Pakete
step "Voraussetzungen prüfen (Docker, Compose-Plugin, Download-Werkzeug)"
missing=()
if ! command -v docker >/dev/null 2>&1; then
  missing+=(docker.io docker-compose)
elif ! docker compose version >/dev/null 2>&1; then
  missing+=(docker-compose)
fi
# curl: Download, Healthcheck und update.sh
command -v curl >/dev/null 2>&1 || missing+=(curl)
if [ "${#missing[@]}" -gt 0 ]; then
  if [ "$INSTALL_DEPS" -eq 1 ]; then
    say "Installiere fehlende Pakete: ${missing[*]}"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -q
    # ab Debian 13 liegt der docker-Befehl im eigenen Paket docker-cli (nur "empfohlen")
    if [[ " ${missing[*]} " == *" docker.io "* ]] && apt-cache show docker-cli >/dev/null 2>&1; then
      missing+=(docker-cli)
    fi
    apt-get install -y -q --no-install-recommends ca-certificates "${missing[@]}"
  elif [ "${missing[*]}" = curl ] && { [ -n "$BUNDLE" ] || command -v wget >/dev/null 2>&1; }; then
    say "Hinweis: curl fehlt – geht auch ohne, update.sh braucht es aber später"
  else
    fail 2 "Es fehlt: ${missing[*]} – nachinstallieren (z. B. apt-get install ${missing[*]}) oder install.sh mit --install-deps aufrufen."
  fi
fi
if [ -d /run/systemd/system ]; then
  systemctl enable --now containerd.service docker.service >/dev/null 2>&1 || true
fi
for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null 2>&1 || fail 2 "Docker-Dienst läuft nicht (systemctl status docker)."
docker compose version >/dev/null 2>&1 || fail 2 "Docker-Compose-Plugin fehlt (Paket docker-compose bzw. docker-compose-plugin)."
say "$(docker --version), Compose $(docker compose version --short)"

download() {  # $1 = URL, $2 = Ziel
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  else
    wget -q --tries=3 -O "$2" "$1"
  fi
}

# "latest" auflösen (Weiterleitung von GitHub auf den neuesten Tag)
if [ "$VERSION" = latest ]; then
  if command -v curl >/dev/null 2>&1; then
    VERSION="$(curl -fsSI "https://github.com/$REPO/releases/latest" | sed -n 's|^[Ll]ocation: .*/tag/v\{0,1\}\([^[:space:]]*\).*|\1|p')"
  else
    VERSION="$(wget -S --spider "https://github.com/$REPO/releases/latest" 2>&1 | sed -n 's|^ *[Ll]ocation: .*/tag/v\{0,1\}\([^[:space:]]*\).*|\1|p' | tail -n 1)"
  fi
  [ -n "$VERSION" ] || fail 1 "Neuestes Release konnte nicht ermittelt werden."
fi
VERSION="${VERSION#v}"
case "$VERSION" in [0-9]*.[0-9]*.[0-9]*) ;; *) fail 1 "Ungültige Version: $VERSION" ;; esac

# ---------------------------------------------------------------- 3. Release holen
step "Release v$VERSION holen und prüfen"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
NAME="bonys-mission-control-$VERSION"
if [ -z "$BUNDLE" ]; then
  BASE="https://github.com/$REPO/releases/download/v$VERSION"
  download "$BASE/$NAME.tar.gz" "$WORK/$NAME.tar.gz" || fail 1 "Download fehlgeschlagen: $BASE/$NAME.tar.gz"
  download "$BASE/SHA256SUMS" "$WORK/SHA256SUMS" || fail 1 "Prüfsummen fehlen: $BASE/SHA256SUMS"
  BUNDLE="$WORK/$NAME.tar.gz"
  SUMS="$WORK/SHA256SUMS"
else
  [ -f "$BUNDLE" ] || fail 1 "Archiv nicht gefunden: $BUNDLE"
  SUMS="$(dirname "$BUNDLE")/SHA256SUMS"
fi
if [ -f "$SUMS" ]; then
  expected="$(awk -v f="$(basename "$BUNDLE")" '$2 == f || $2 == "*" f { print $1 }' "$SUMS")"
  [ -n "$expected" ] || fail 1 "Keine Prüfsumme für $(basename "$BUNDLE") in SHA256SUMS."
  [ "$(sha256sum "$BUNDLE" | cut -d' ' -f1)" = "$expected" ] || fail 1 "Prüfsumme stimmt nicht – Archiv beschädigt oder manipuliert."
  say "Prüfsumme ok"
else
  say "Hinweis: keine SHA256SUMS neben dem lokalen Archiv – Prüfung übersprungen"
fi
tar -xzf "$BUNDLE" -C "$WORK"
SRC="$WORK/$NAME"
if [ ! -f "$SRC/compose.yaml" ] || [ ! -f "$SRC/scripts/lib.sh" ]; then
  fail 1 "Archiv unvollständig: $(basename "$BUNDLE")"
fi

# ab hier die gemeinsamen Hilfsfunktionen aus dem Release
# shellcheck source=lib.sh
. "$SRC/scripts/lib.sh"

# ---------------------------------------------------------------- 4. Mindestanforderungen
step "Mindestanforderungen prüfen"
json_num() { sed -n "s/.*\"$1\": *\([0-9]*\).*/\1/p" "$SRC/agentpc.json" | head -n 1; }
MIN_RAM="$(json_num min_ram_mb)"
MIN_DISK="$(json_num min_free_disk_gb)"
ram_mb=$(( $(sed -n 's/^MemTotal: *\([0-9]*\) kB/\1/p' /proc/meminfo) / 1024 ))
docker_root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
disk_path="$docker_root"; [ -d "$disk_path" ] || disk_path=/var/lib
disk_gb=$(( $(df -Pk "$disk_path" | awk 'NR == 2 { print $4 }') / 1024 / 1024 ))
say "RAM ${ram_mb} MB (mind. ${MIN_RAM} MB), frei ${disk_gb} GB unter $disk_path (mind. ${MIN_DISK} GB)"
if [ "$ram_mb" -lt "$MIN_RAM" ] || [ "$disk_gb" -lt "$MIN_DISK" ]; then
  if [ "$FORCE" -eq 1 ]; then
    warn "Mindestanforderungen nicht erfüllt – wegen --force geht es trotzdem weiter."
  else
    die 3 "Mindestanforderungen nicht erfüllt (mit --force trotzdem installieren)."
  fi
fi

# ---------------------------------------------------------------- 5. Dateien
step "Dateien nach $MC_DIR kopieren"
PREVIOUS="$(cat "$MC_DIR/VERSION" 2>/dev/null || true)"
install -d -m 755 "$MC_DIR" "$MC_DIR/scripts" "$MC_DIR/share"
install -m 644 "$SRC/compose.yaml" "$SRC/agentpc.json" "$MC_DIR/"
install -m 600 "$SRC/.env.example" "$MC_DIR/.env.example"
install -m 755 "$SRC"/scripts/*.sh "$MC_DIR/scripts/"
install -m 644 "$SRC/share/mission-control.svg" "$MC_DIR/share/"
[ -f "$SRC/LICENSE" ] && install -m 644 "$SRC/LICENSE" "$MC_DIR/"
printf '%s\n' "$VERSION" > "$MC_DIR/VERSION"
if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$VERSION" ]; then
  say "Umstellung von $PREVIOUS auf $VERSION (Daten und Einstellungen bleiben)"
fi

# ---------------------------------------------------------------- 6. Einstellungen
step "Einstellungen (.env) und Geheimnisse"
ensure_env
env_set "$MC_DIR/.env" MISSION_CONTROL_VERSION "$VERSION"
if [ -n "$PORT" ]; then env_set "$MC_DIR/.env" MISSION_CONTROL_PORT "$PORT"; fi
PORT="$(env_get "$MC_DIR/.env" MISSION_CONTROL_PORT)"
PORT="${PORT:-8787}"
say "Weboberfläche: http://127.0.0.1:$PORT/ (nur lokal)"

# ---------------------------------------------------------------- 7. Image
step "Docker-Image bereitstellen"
IMAGE="$(env_get "$MC_DIR/.env" MISSION_CONTROL_IMAGE):$VERSION"
if [ -n "$IMAGE_ARCHIVE" ]; then
  docker load -i "$IMAGE_ARCHIVE" >/dev/null || die 1 "Image-Archiv konnte nicht geladen werden."
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die 1 "Archiv enthält nicht $IMAGE."
  say "Image aus Datei geladen: $IMAGE"
else
  compose pull --quiet || die 1 "docker compose pull fehlgeschlagen ($IMAGE)."
  say "Image geladen: $IMAGE"
fi

# ---------------------------------------------------------------- 8. Autostart
step "Autostart einrichten (systemd)"
if has_systemd; then
  DOCKER_BIN="$(command -v docker)"
  cat > "/etc/systemd/system/$MC_UNIT" <<UNIT
[Unit]
Description=Bony's Agents Mission Control
Documentation=https://github.com/$REPO
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$MC_DIR
ExecStartPre=$MC_DIR/scripts/ensure-secrets.sh
ExecStart=$DOCKER_BIN compose --project-directory $MC_DIR --env-file $MC_DIR/.env up -d --remove-orphans
ExecStop=$DOCKER_BIN compose --project-directory $MC_DIR --env-file $MC_DIR/.env down
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable "$MC_UNIT" >/dev/null 2>&1
  say "systemd-Unit $MC_UNIT aktiviert"
else
  warn "kein systemd gefunden – Autostart übernimmt nur Dockers restart-Regel."
fi

# ---------------------------------------------------------------- 9. Starten
step "Dienste starten"
if has_systemd; then
  # restart, damit geänderte Einstellungen sicher übernommen werden
  systemctl restart "$MC_UNIT" || die 1 "Start fehlgeschlagen (journalctl -u $MC_UNIT)."
else
  compose up -d --remove-orphans || die 1 "docker compose up fehlgeschlagen."
fi

if [ "$NO_DESKTOP" -eq 0 ]; then
  if [ -z "$AGENT_USER" ]; then
    if id agent >/dev/null 2>&1; then AGENT_USER=agent
    elif [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then AGENT_USER="$SUDO_USER"
    fi
  fi
  if [ -n "$AGENT_USER" ] && ! id "$AGENT_USER" >/dev/null 2>&1; then
    die 1 "Benutzer nicht gefunden: $AGENT_USER"
  fi
  shortcut="$(install_desktop_shortcut "$AGENT_USER" "$PORT" "$DESKTOP_DIR")"
  [ -n "$shortcut" ] && DESKTOP_DIR="$(dirname "$shortcut")" && say "Desktop-Verknüpfung: $shortcut"
  say "Menüeintrag: /usr/share/applications/bonys-mission-control.desktop"
fi
cat > "$MC_DIR/install.conf" <<CONF
# von install.sh geschrieben – wird von update.sh und uninstall.sh gelesen
AGENT_USER=$AGENT_USER
DESKTOP_DIR=$DESKTOP_DIR
NO_DESKTOP=$NO_DESKTOP
CONF

# ---------------------------------------------------------------- 10. Healthcheck
step "Healthcheck"
if wait_healthy "$PORT" "$VERSION" 120; then
  say "Mission Control $VERSION läuft: http://127.0.0.1:$PORT/"
  say "FERTIG"
else
  compose ps >&2 || true
  compose logs --tail 30 >&2 || true
  die 4 "Healthcheck rot – Mission Control antwortet nicht auf http://127.0.0.1:$PORT/api/health"
fi
