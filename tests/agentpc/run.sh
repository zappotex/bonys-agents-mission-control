#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Installationstest in einem frischen Debian-13-Container mit systemd und eigenem Docker:
# install.sh (mit --install-deps), Healthcheck, Idempotenz, update, hermes-team.sh, reset-secrets, uninstall, --purge.
# Das App-Image wird lokal gebaut und per --image-archive übergeben (keine Registry nötig).
# Aufruf aus dem Repo-Wurzelordner: tests/agentpc/run.sh   (braucht Docker mit --privileged)
# shellcheck disable=SC2016  # Prüfbefehle laufen bewusst erst im Container
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$ROOT/package.json")"
IMAGE="ghcr.io/zappotex/bonys-agents-mission-control:$VERSION"
WORK="$ROOT/dist-release"
BOX="mc-agentpc-test"

step() { printf '\n=== %s ===\n' "$*"; }
in_box() { docker exec "$BOX" bash -c "$*"; }
check() {  # $1 = Beschreibung, Rest = Befehl im Container
  local what="$1"; shift
  if in_box "$*" >/dev/null 2>&1; then echo "OK    $what"; else echo "FEHLER $what"; FAILED=1; fi
}
secret_hash() { in_box "sed -n 's/^MISSION_CONTROL_API_TOKEN=//p' /opt/bonys-mission-control/.env | sha256sum | cut -c1-12"; }
FAILED=0

step "Bauen: App-Image, Release-Archiv, Test-PC"
docker build -q -t "$IMAGE" "$ROOT" >/dev/null
bash "$ROOT/scripts/make-bundle.sh" "$WORK" >/dev/null
docker save -o "$WORK/image.tar" "$IMAGE"
docker build -q -t mc-agentpc-debian13 "$ROOT/tests/agentpc" >/dev/null

docker rm -f "$BOX" >/dev/null 2>&1 || true
trap 'docker rm -f -v "$BOX" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$BOX" --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw -v /var/lib/docker \
  --tmpfs /run --tmpfs /run/lock mc-agentpc-debian13 >/dev/null
for _ in $(seq 1 30); do
  in_box 'systemctl is-system-running 2>/dev/null | grep -qE "running|degraded"' && break
  sleep 1
done
docker cp "$WORK" "$BOX:/root/release"

step "install.sh ohne Docker und ohne --install-deps muss mit Exit-Code 2 abbrechen"
set +e
in_box "/root/release/install.sh --bundle /root/release/bonys-mission-control-$VERSION.tar.gz" >/dev/null 2>&1
code=$?
set -e
if [ "$code" -eq 2 ]; then echo "OK    Exit-Code 2 bei fehlendem Docker"; else echo "FEHLER Exit-Code $code statt 2"; FAILED=1; fi

step "install.sh (frisch, ohne Docker)"
in_box "/root/release/install.sh --install-deps --bundle /root/release/bonys-mission-control-$VERSION.tar.gz --image-archive /root/release/image.tar"
check "systemd-Unit aktiv und aktiviert" 'systemctl is-active bonys-mission-control && systemctl is-enabled bonys-mission-control'
check "Healthcheck grün" "curl -fsS http://127.0.0.1:8787/api/health | grep -q '\"version\": \"$VERSION\"'"
check "Oberfläche liefert HTML" 'curl -fsS http://127.0.0.1:8787/ | grep -qi "<html"'
check "Port nur an 127.0.0.1" 'ss -ltnH "sport = :8787" | awk "{print \$4}" | grep -qx "127.0.0.1:8787" && ! ss -ltnH "sport = :8787" | grep -qv "127.0.0.1:8787"'
check ".env nur für root (600)" 'test "$(stat -c %a /opt/bonys-mission-control/.env)" = 600'
check "Geheimnis erzeugt" '! grep -q =__GENERATE__ /opt/bonys-mission-control/.env && grep -qE "^MISSION_CONTROL_API_TOKEN=[0-9a-f]{64}$" /opt/bonys-mission-control/.env'
check "Desktop-Verknüpfung für agent" 'test -x /home/agent/Schreibtisch/bonys-mission-control.desktop && stat -c %U /home/agent/Schreibtisch/bonys-mission-control.desktop | grep -qx agent'
check "Menüeintrag" 'grep -q "Exec=xdg-open http://127.0.0.1:8787/" /usr/share/applications/bonys-mission-control.desktop'
FIRST="$(secret_hash)"

step "install.sh erneut (idempotent)"
in_box "/root/release/install.sh --bundle /root/release/bonys-mission-control-$VERSION.tar.gz --image-archive /root/release/image.tar" >/dev/null
check "Geheimnis unverändert" "test \"\$(sed -n 's/^MISSION_CONTROL_API_TOKEN=//p' /opt/bonys-mission-control/.env | sha256sum | cut -c1-12)\" = $FIRST"
check "Healthcheck grün" 'curl -fsS http://127.0.0.1:8787/api/health | grep -q "\"ok\": true"'

step "Daten anlegen, Neustart der Unit"
in_box 'docker exec bonys-mission-control sh -c "printf \"name: Testteam\nteam:\n  owner: Testerin\n\" > /app/data/profiles/testteam.yaml"'
in_box 'systemctl restart bonys-mission-control'
check "Daten überleben Neustart" 'for i in $(seq 30); do curl -fsS http://127.0.0.1:8787/api/profiles | grep -q testteam.yaml && exit 0; sleep 1; done; exit 1'

step "update.sh (gleiches Release als lokales Archiv)"
in_box "/opt/bonys-mission-control/scripts/update.sh --version $VERSION --bundle /root/release/bonys-mission-control-$VERSION.tar.gz --image-archive /root/release/image.tar" >/dev/null
check "Daten nach Update vorhanden" 'curl -fsS http://127.0.0.1:8787/api/profiles | grep -q testteam.yaml'
check "Geheimnis nach Update unverändert" "test \"\$(sed -n 's/^MISSION_CONTROL_API_TOKEN=//p' /opt/bonys-mission-control/.env | sha256sum | cut -c1-12)\" = $FIRST"

step "Standardprofil und Hermes-Agenten anbinden (hermes-team.sh, Hermes-Ersatz)"
check "Standardprofil ist das neutrale Beispielteam" 'curl -fsS http://127.0.0.1:8787/api/bootstrap | python3 -c "import json,sys; d=json.load(sys.stdin); n=[a[\"name\"] for a in d[\"agents\"]]; sys.exit(not (\"Atlas\" in n and \"Barney\" not in n))"'
ADD_OUT="$(in_box '/opt/bonys-mission-control/scripts/hermes-team.sh add atlas --description "Koordination"' 2>&1)" || { echo "$ADD_OUT"; FAILED=1; }
in_box '/opt/bonys-mission-control/scripts/hermes-team.sh add nova' >/dev/null
KEY="$(in_box "sed -n 's/^HERMES_PEER_ATLAS_KEY=//p' /opt/bonys-mission-control/peers.env")"
if [ -n "$KEY" ] && ! printf '%s' "$ADD_OUT" | grep -qF "$KEY"; then echo "OK    Schlüssel erzeugt, nicht ausgegeben"; else echo "FEHLER Schlüssel fehlt oder wurde ausgegeben"; FAILED=1; fi
check "peers.env nur für root (600)" 'test "$(stat -c %a /opt/bonys-mission-control/peers.env)" = 600'
check "Profil-.env gehört agent (600) mit gleichem Schlüssel" 'f=/home/agent/.hermes/profiles/atlas/.env; test "$(stat -c %U:%a $f)" = agent:600 && grep -q "^API_SERVER_KEY=$(sed -n "s/^HERMES_PEER_ATLAS_KEY=//p" /opt/bonys-mission-control/peers.env)$" $f'
check "eigene Ports 8641/8642" 'grep -qx "atlas 8641" /opt/bonys-mission-control/hermes-team.conf && grep -qx "nova 8642" /opt/bonys-mission-control/hermes-team.conf'
check "Dienste laufen" 'systemctl is-active bonys-hermes-peer@atlas bonys-hermes-peer@nova && systemctl is-enabled bonys-hermes-peer@atlas'
check "peers.yaml im Daten-Volume (600)" 'f="$(docker volume inspect -f "{{.Mountpoint}}" bonys-mission-control-data)/peers.yaml"; test "$(stat -c %a "$f")" = 600 && grep -q "api_key_env: HERMES_PEER_ATLAS_KEY" "$f"'
check "Container kennt den Schlüssel" 'docker exec bonys-mission-control sh -c "test -n \"\$HERMES_PEER_ATLAS_KEY\""'
check "Atlas in Mission Control online" 'for i in $(seq 60); do curl -fsS http://127.0.0.1:8787/api/bootstrap | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(not any(a[\"name\"]==\"Atlas\" and a.get(\"status\")==\"online\" for a in d[\"agents\"]))" && exit 0; sleep 2; done; exit 1'
check "list zeigt die Agenten" '/opt/bonys-mission-control/scripts/hermes-team.sh list | grep -E "^atlas +8641 +active +erreichbar"'
in_box '/opt/bonys-mission-control/scripts/hermes-team.sh remove nova' >/dev/null
check "remove: Dienst aus, Schlüssel weg" '! systemctl is-active bonys-hermes-peer@nova && ! grep -q HERMES_PEER_NOVA_KEY /opt/bonys-mission-control/peers.env && grep -q "^API_SERVER_ENABLED=false$" /home/agent/.hermes/profiles/nova/.env'
check "Hand-angelegte peers.yaml wird nicht überschrieben" 'f="$(docker volume inspect -f "{{.Mountpoint}}" bonys-mission-control-data)/peers.yaml"; cp "$f" /root/peers.bak; echo "peers: {}" > "$f"; ! /opt/bonys-mission-control/scripts/hermes-team.sh add nova; r=$?; cp /root/peers.bak "$f"; exit $r'

step "reset-secrets.sh (Vorlage) und erster Start danach"
in_box '/opt/bonys-mission-control/scripts/reset-secrets.sh'
check "Geheimnis zurückgesetzt" 'grep -q "^MISSION_CONTROL_API_TOKEN=__GENERATE__$" /opt/bonys-mission-control/.env'
check "Daten-Volume gelöscht" '! docker volume inspect bonys-mission-control-data'
in_box 'systemctl start bonys-mission-control'
check "neues Geheimnis beim Start" "grep -qE '^MISSION_CONTROL_API_TOKEN=[0-9a-f]{64}$' /opt/bonys-mission-control/.env && test \"\$(sed -n 's/^MISSION_CONTROL_API_TOKEN=//p' /opt/bonys-mission-control/.env | sha256sum | cut -c1-12)\" != $FIRST"
check "Healthcheck grün, Daten leer" 'for i in $(seq 60); do curl -fsS http://127.0.0.1:8787/api/health >/dev/null 2>&1 && break; sleep 1; done; ! curl -fsS http://127.0.0.1:8787/api/profiles | grep -q testteam.yaml'

step "uninstall.sh (ohne --purge)"
in_box '/opt/bonys-mission-control/scripts/uninstall.sh'
check "Dienst weg" '! systemctl cat bonys-mission-control && ! docker ps -a --format "{{.Names}}" | grep -qx bonys-mission-control'
check ".env und Daten-Volume behalten" 'test -f /opt/bonys-mission-control/.env && docker volume inspect bonys-mission-control-data'
check "Hermes-Dienste weg, peers.env behalten" '! systemctl is-active bonys-hermes-peer@atlas && ! test -e /etc/systemd/system/bonys-hermes-peer@.service && test -f /opt/bonys-mission-control/peers.env'
check "Verknüpfungen weg" '! test -e /home/agent/Schreibtisch/bonys-mission-control.desktop && ! test -e /usr/share/applications/bonys-mission-control.desktop'

step "Neuinstallation, dann uninstall.sh --purge"
in_box "/root/release/install.sh --bundle /root/release/bonys-mission-control-$VERSION.tar.gz --image-archive /root/release/image.tar" >/dev/null
check "Healthcheck nach Neuinstallation" 'curl -fsS http://127.0.0.1:8787/api/health | grep -q "\"ok\": true"'
in_box '/opt/bonys-mission-control/scripts/uninstall.sh --purge'
check "alles entfernt" '! test -e /opt/bonys-mission-control && ! docker volume inspect bonys-mission-control-data'

echo
if [ "$FAILED" -eq 0 ]; then echo "ALLE PRÜFUNGEN GRÜN"; else echo "PRÜFUNGEN FEHLGESCHLAGEN"; exit 1; fi
