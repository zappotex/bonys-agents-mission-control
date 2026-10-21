# Installation auf Agent-PCs (Schnittstelle für Bony's Agents)

Diese Seite beschreibt, wie Bony's Agents Mission Control automatisch in einen Agent-PC installiert –
beim Erstellen und nachträglich. Zielsystem: **Debian 13**, Benutzer **`agent`**, **amd64 und arm64**.

## Kurz

```bash
# als root im Agent-PC (Bony's-Agents-App-Snippets laufen bereits als root)
curl -fsSLo /tmp/mc-install.sh \
  https://github.com/zappotex/bonys-agents-mission-control/releases/download/v0.2.0/install.sh
bash /tmp/mc-install.sh --version 0.2.0 --user agent --install-deps
```

Danach läuft Mission Control unter **http://127.0.0.1:8787/** (nur lokal erreichbar), startet mit dem
System und hat eine Verknüpfung „Mission Control“ auf dem Schreibtisch des Agent-Benutzers.

## Eckdaten

| | |
|---|---|
| Installationsordner | `/opt/bonys-mission-control` |
| Weboberfläche | `http://127.0.0.1:8787/` – Port nur an **127.0.0.1** gebunden, nicht im Netz |
| Healthcheck | `http://127.0.0.1:8787/api/health` → `{"ok": true, "version": "0.2.0", …}` |
| Image | `ghcr.io/zappotex/bonys-agents-mission-control:<version>` (amd64 + arm64) |
| Container | `bonys-mission-control` (Compose-Projekt `bonys-mission-control`) |
| Daten | Docker-Volume `bonys-mission-control-data` (im Container `/app/data`, eigene Profile in `profiles/`) |
| Einstellungen | `/opt/bonys-mission-control/.env` (Rechte 600, nur root) |
| Autostart | systemd-Unit `bonys-mission-control.service` |
| Verknüpfungen | `~agent/<Schreibtisch>/bonys-mission-control.desktop` und `/usr/share/applications/bonys-mission-control.desktop` |
| Mindestanforderungen | `agentpc.json` (siehe unten) |

## Mindestanforderungen: `agentpc.json`

Liegt im Repo, als Release-Datei und nach der Installation in `/opt/bonys-mission-control/agentpc.json`.
Bony's Agents kann sie vorab laden (`…/releases/download/v<version>/agentpc.json`), um RAM und Platte des
Agent-PCs zu prüfen:

```json
{
  "name": "bonys-mission-control",
  "version": "0.2.0",
  "port": 8787,
  "min_ram_mb": 512,
  "min_free_disk_gb": 2,
  "architectures": ["amd64", "arm64"],
  "install_url": "https://github.com/zappotex/bonys-agents-mission-control/releases/download/v0.2.0/install.sh"
}
```

(gekürzt – die Datei enthält zusätzlich `bind`, `url`, `health_url`, `os`, `requires`, `install_dir`,
`image`, `systemd_unit`, `data_volume`.)

Die Werte sind **zusätzlicher** Bedarf inklusive Docker, nicht der Bedarf des ganzen Agent-PCs. Gemessen:
der Container braucht im Leerlauf rund 20 MB RAM (begrenzt auf 256 MB), das Image ist komprimiert 62 MB,
entpackt rund 240 MB; Docker aus Debian (docker.io, docker-cli, docker-compose) belegt rund 300 MB.

## Skripte

Alle Skripte laufen als root, ohne Rückfragen, mit Fortschrittszeilen auf stdout und Fehlern auf stderr.
Nach der Installation liegen sie in `/opt/bonys-mission-control/scripts/`.

### `install.sh` – installieren oder reparieren

```text
install.sh [--version X|latest] [--user NAME] [--desktop-dir DIR] [--port N] [--install-deps]
           [--bundle DATEI] [--image-archive DATEI] [--no-desktop] [--force]
```

| Option | Bedeutung |
|---|---|
| `--version X` | Release-Version, z. B. `0.2.0` oder `v0.2.0`; `latest` = neuestes Release. Standard: die Version, zu der das Skript gehört |
| `--user NAME` | Benutzer für die Desktop-Verknüpfung. Standard: `agent`, falls vorhanden |
| `--desktop-dir DIR` | Schreibtisch-Ordner (Standard: aus `~/.config/user-dirs.dirs`, sonst `~/Schreibtisch` bzw. `~/Desktop`). Bony's Agents kann hier sein `$DESKTOP_DIR` übergeben |
| `--port N` | anderer Port auf 127.0.0.1 (Standard 8787, bei Wiederholung der bisherige) |
| `--install-deps` | fehlende Pakete per apt nachinstallieren: `docker.io`, `docker-cli`, `docker-compose`, `curl` |
| `--bundle DATEI` | Release-Archiv `bonys-mission-control-<version>.tar.gz` lokal verwenden (Prüfung über `SHA256SUMS` daneben, falls vorhanden) |
| `--image-archive DATEI` | Image per `docker load` aus Datei statt aus GHCR (offline) |
| `--no-desktop` | keine Verknüpfungen anlegen |
| `--force` | Mindestanforderungen nur warnen statt abbrechen |

Ablauf (10 Schritte, jede Zeile beginnt mit `[mission-control] (n/10)`):

1. System prüfen (Architektur amd64/arm64, Debian-Version)
2. Voraussetzungen prüfen: Docker, Compose-Plugin, curl (mit `--install-deps` nachinstallieren)
3. Release-Archiv und `SHA256SUMS` holen, Prüfsumme kontrollieren
4. Mindestanforderungen aus `agentpc.json` prüfen (RAM, freier Platz unter Dockers Datenordner)
5. Dateien nach `/opt/bonys-mission-control` kopieren
6. `.env` aus `.env.example` anlegen bzw. um neue Schlüssel ergänzen; Geheimnisse (`__GENERATE__`)
   zufällig erzeugen – **es gibt keine festen Standardpasswörter**, Werte werden nie ausgegeben
7. Image holen (`docker compose pull`) bzw. aus Datei laden
8. systemd-Unit schreiben und aktivieren
9. Dienste starten, Desktop-Verknüpfung und Menüeintrag anlegen
10. Healthcheck: wartet bis 120 s, bis `/api/health` mit der richtigen Version antwortet und der
    Container „healthy“ ist; letzte Zeile bei Erfolg: `[mission-control] FERTIG`

Idempotent: ein zweiter Aufruf repariert die Installation; `.env`, Geheimnisse und Daten bleiben.
Mit anderer `--version` stellt er auf dieses Release um (wie `update.sh`).

**Exit-Codes**

| Code | Bedeutung |
|---|---|
| 0 | installiert, Healthcheck grün |
| 1 | allgemeiner Fehler (Download, Prüfsumme, Start …) |
| 2 | Voraussetzung fehlt (Architektur, Docker, Compose-Plugin) – ggf. mit `--install-deps` erneut |
| 3 | zu wenig RAM oder freier Platz (mit `--force` übergehen) |
| 4 | Healthcheck rot (Container-Status und letzte Logzeilen stehen auf stderr) |

Für eine Prozentanzeige kann Bony's Agents die Zeilen `^\[mission-control\] \((\d+)/(\d+)\)` auswerten.

### `update.sh` – auf ein anderes Release umstellen

```bash
/opt/bonys-mission-control/scripts/update.sh --version 0.2.0      # oder --version latest
```

Lädt `install.sh` des Ziel-Release (geprüft über dessen `SHA256SUMS`) und führt es mit den bisherigen
Optionen aus `/opt/bonys-mission-control/install.conf` aus. `.env`, Geheimnisse und Daten bleiben; neue
Schlüssel aus der neuen `.env.example` werden ergänzt. Optionen: `--bundle`, `--image-archive`, `--force`.

### `uninstall.sh` – entfernen

```bash
/opt/bonys-mission-control/scripts/uninstall.sh            # Daten bleiben
/opt/bonys-mission-control/scripts/uninstall.sh --purge    # alles weg
```

Ohne Option: Dienst stoppen, Unit, Container, Verknüpfungen und Programmdateien entfernen; **`.env` und das
Daten-Volume bleiben**, eine spätere Neuinstallation übernimmt sie. `--purge` löscht zusätzlich Volume,
`.env`, Image und den ganzen Ordner. Docker selbst bleibt installiert.

### `reset-secrets.sh` – für Vorlagen

```bash
/opt/bonys-mission-control/scripts/reset-secrets.sh [--keep-data] [--restart]
```

Gedacht für das Verallgemeinern einer Vorlage (vor dem Herunterfahren): stoppt Mission Control, entfernt
den Container, setzt alle Geheimnisse in `.env` auf `__GENERATE__` zurück und löscht das Daten-Volume
(außer mit `--keep-data`). Programm, Image, Autostart und Einstellungen wie der Port bleiben.
Beim nächsten Start (systemd ruft vorher `ensure-secrets.sh` auf) bekommt jeder aus der Vorlage geklonte
Agent-PC **eigene neue Geheimnisse** und leere Daten. `--restart` startet sofort neu.

### `ensure-secrets.sh`

Wird von der systemd-Unit vor jedem Start ausgeführt (`ExecStartPre`): legt `.env` an, ergänzt fehlende
Schlüssel und erzeugt fehlende Geheimnisse. Muss nicht von Hand aufgerufen werden.

## Einbindung in Bony's Agents (Vorschlag)

- **App-Snippet** (läuft als root, `$AGENT_USER`, `$DESKTOP_DIR` vorhanden):
  ```bash
  curl -fsSLo /tmp/mc-install.sh \
    https://github.com/zappotex/bonys-agents-mission-control/releases/download/v0.2.0/install.sh
  bash /tmp/mc-install.sh --version 0.2.0 --user "$AGENT_USER" --desktop-dir "$DESKTOP_DIR" --install-deps
  rm -f /tmp/mc-install.sh
  ```
- **Prüfung** (`check`): `curl -fsS http://127.0.0.1:8787/api/health`
- **Update**: `/opt/bonys-mission-control/scripts/update.sh --version latest`
- **Vorlage verallgemeinern**: `/opt/bonys-mission-control/scripts/reset-secrets.sh` vor dem Herunterfahren
- **Gewicht** für die Fortschrittsanzeige: mit `--install-deps` ähnlich wie eine größere apt-Installation
  (Docker ≈ 75 MB Download, Image ≈ 62 MB)

## Konfiguration (`.env`)

| Schlüssel | Standard | Bedeutung |
|---|---|---|
| `MISSION_CONTROL_VERSION` | Release-Version | Image-Tag, setzen install.sh/update.sh |
| `MISSION_CONTROL_IMAGE` | `ghcr.io/zappotex/bonys-agents-mission-control` | Image ohne Tag |
| `MISSION_CONTROL_PORT` | `8787` | Port auf 127.0.0.1 |
| `MISSION_CONTROL_PROFILE` | `bonys-agents.example.yaml` | aktives Teamprofil |
| `MISSION_CONTROL_SHOW_PRIVATE` | `false` | Werte aus `*.local.yaml` ungeschwärzt zeigen |
| `MISSION_CONTROL_API_TOKEN` | `__GENERATE__` → Zufallswert | Token für künftige schreibende API-Zugriffe (Profile speichern); in 0.2.0 noch ungenutzt |

Nach Änderungen: `systemctl restart bonys-mission-control`.

## Externe Zugriffe

Mission Control 0.2.0 braucht **keinen** Zugriff auf Hermes, OpenClaw, Telegram oder andere Dienste und
keine Zugangsdaten. Netzwerk wird nur für die Installation gebraucht (GitHub-Release, GHCR, ggf. apt).
Hermes-Peer-Status wird serverseitig aus privaten Profil-/Peer-Daten geprüft; Endpunkte und Credentials werden nicht an das Frontend ausgeliefert.

## Sicherheit

- Weboberfläche nur an 127.0.0.1; der Container lauscht intern auf 8787 und ist nur über diese Portfreigabe
  erreichbar.
- Container: läuft als Benutzer `node` (UID 1000), Dateisystem schreibgeschützt (außer `/app/data` und
  `/tmp`), alle Linux-Capabilities entfernt, `no-new-privileges`, Speicher auf 256 MB begrenzt.
- `.env` nur für root lesbar; Geheimnisse werden zufällig erzeugt und von keinem Skript ausgegeben.
- Release-Archiv und `install.sh` werden über `SHA256SUMS` geprüft.

## Test

`tests/agentpc/run.sh` spielt alles in einem frischen Debian-13-Container mit systemd und eigenem Docker
durch (install mit `--install-deps`, Healthcheck, Port nur lokal, Geheimnis, Verknüpfungen, Idempotenz,
Daten nach Neustart und Update, reset-secrets, uninstall, `--purge`). Läuft auch in der CI.
