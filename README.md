# Bony's Agents Mission Control

Open-Source-Dashboard („Mission Control“) für frei konfigurierbare Agenten-Teams.

> **Stand:** Entwicklungsversion 0.2.2 – lauffähiges Grundgerüst mit automatisierten Tests und lokalen Sicherheitsprüfungen, noch kein fertiges Produkt.

## Was ist Mission Control?

Mission Control zeigt ein Agenten-Team auf einen Blick: welche Agenten es gibt, welche Rolle sie haben,
woran gerade gearbeitet wird. Das Projekt ist **nicht fest auf Bonys Team verdrahtet** – Agenten, Rollen,
Pfade, Profile und Integrationen kommen aus YAML-Dateien und lassen sich für jedes Team anpassen.
Bonys Team wird als vorkonfiguriertes Beispielprofil mitgeliefert (`profiles/bonys-agents.example.yaml`).

## Die Bony's-Agents-Familie

Mission Control ist ein eigenständiges Projekt neben:

- **[Bony's Agents](https://github.com/zappotex/BonysAgents)** – virtuelle Agent-PCs mit Brave, Telegram und Hermes Agent
- **[Bony's VPN](https://github.com/zappotex/bonys-vpn)** – WireGuard-VPN mit Kill-Switch für Debian, Ubuntu und Linux Mint

Die Projekte teilen Herkunft und Stil, hängen technisch aber nicht voneinander ab.

## Was schon funktioniert

- React + Vite + TypeScript-Frontend im Bonys-Agents-Cyberpunk-Look
- Agenten-Flotte, geladen aus `config/agents.yaml` und dem aktiven Profil
- Profilwähler im Dashboard; Agenten-Flotte und Setup-Wizard wechseln gemeinsam zwischen den verfügbaren Profilen
- Node-Backend, liest die YAML-Dateien zur Laufzeit (`/api/health`, `/api/profiles`, `/api/bootstrap`)
- Live-Erreichbarkeit über `/health`; mit privatem Peer-Schlüssel zusätzlich echter Hermes-Arbeitsstatus über `/health/detailed` (`busy`/`online`)
- Frontend fällt ohne Backend auf veröffentlichungssichere Beispieldaten zurück
- Mission Board mit profilbezogener lokaler Speicherung: Missionen anlegen, Agenten zuweisen und Status ändern
- read-only Markdown-/Obsidian-Projektindex mit Titel, Datum und Tags ohne Ausgabe privater Dateipfade
- Setup-Wizard mit Live-YAML-Vorschau, Kopieren, Herunterladen und geschütztem Speichern als lokales Profil
- Private Werte aus `*.local.yaml`-Profilen werden standardmäßig geschwärzt
- Docker-Image für amd64 und arm64, Installation auf Agent-PCs per Skript (siehe unten)

**Enthalten:** Auftragshistorie mit begrenzten, sicheren Run-Snapshots und eine zugängliche Detailansicht pro Mission. Missionen werden lokal profilbezogen gespeichert; ein Auftrag kann aus einer Mission gestartet, sein Status automatisch abgefragt, historisiert und ein laufender Run gestoppt werden. Der Stand ist als Mission Control **0.2.2** veröffentlicht. Die Oberfläche enthält unter „Updates“ eine sichere Release-Prüfung und kopiert den passenden manuellen Update-Befehl.

## Installation mit Bony's Agents

[Bony's Agents](https://github.com/zappotex/BonysAgents) installiert Mission Control automatisch in
Agent-PCs (Debian 13, amd64 und arm64) – beim Erstellen oder nachträglich. Dabei läuft im Agent-PC als root:

```bash
curl -fsSLo /tmp/mc-install.sh \
  https://github.com/zappotex/bonys-agents-mission-control/releases/download/v0.2.2/install.sh
bash /tmp/mc-install.sh --version 0.2.2 --user agent --install-deps
```

Ergebnis: Mission Control läuft als Docker-Container unter **http://127.0.0.1:8787/** (nur lokal), startet
mit dem System (`bonys-mission-control.service`) und hat die Desktop-Verknüpfung **„Mission Control“**,
die die Oberfläche im Standardbrowser (Brave) öffnet. Geheimnisse werden beim ersten Start zufällig erzeugt.

Update, Deinstallation, Vorlagen und alle Optionen: **[docs/installation-agent-pc.md](docs/installation-agent-pc.md)**.
Mindestanforderungen maschinenlesbar: [`agentpc.json`](agentpc.json).

## Manuelle Installation

Auf einem eigenen Debian-/Ubuntu-Rechner mit systemd:

```bash
curl -fsSLO https://github.com/zappotex/bonys-agents-mission-control/releases/download/v0.2.2/install.sh
curl -fsSLO https://github.com/zappotex/bonys-agents-mission-control/releases/download/v0.2.2/SHA256SUMS
grep ' install.sh$' SHA256SUMS | sha256sum -c -
sudo bash install.sh --version 0.2.2 --install-deps          # --user NAME für die Desktop-Verknüpfung
```

Ohne `--install-deps` bricht das Skript ab, wenn Docker oder das Compose-Plugin fehlen (Exit-Code 2).
Danach im Browser `http://127.0.0.1:8787/` öffnen.

### Manuelles Update

Das Update-Skript lädt das gewünschte offizielle GitHub-Release, prüft dessen `install.sh` über `SHA256SUMS` und übernimmt die bestehende Konfiguration. Das Docker-Datenvolume und `.env` bleiben erhalten.

```bash
# feste Version, empfohlen
sudo /opt/bonys-mission-control/scripts/update.sh --version 0.2.2

# alternativ: neuestes Release
sudo /opt/bonys-mission-control/scripts/update.sh --version latest

# danach prüfen
curl -fsS http://127.0.0.1:8787/api/health
```

Für ein lokales Bundle:

```bash
sudo /opt/bonys-mission-control/scripts/update.sh \
  --version 0.2.2 \
  --bundle /pfad/bonys-mission-control-0.2.2.tar.gz
```

`--purge` nicht verwenden: Das gehört ausschließlich zur vollständigen Deinstallation und löscht Benutzerdaten.

Mission Control bietet zusätzlich unter **Updates** eine Release-Prüfung. Die Oberfläche führt das Update nicht selbst mit Root-Rechten aus; sie zeigt den geprüften Befehl an und kann ihn kopieren. Dadurch bleiben Privilegien und die Entscheidung beim Administrator.

### Deinstallation

```bash
sudo /opt/bonys-mission-control/scripts/uninstall.sh         # Programm entfernen, Daten behalten
sudo /opt/bonys-mission-control/scripts/uninstall.sh --purge # Programm und Daten löschen
```


Ganz ohne Skript geht es mit `deploy/compose.yaml` und einer `.env` (aus `.env.example`, Geheimnisse
selbst setzen, z. B. mit `openssl rand -hex 32`):

```bash
docker compose -f deploy/compose.yaml --project-directory . --env-file .env up -d
```

## Voraussetzungen (Entwicklung)

- Node.js **20.19+** oder **22.12+** (wegen Vite 8)
- optional Docker mit Compose

## Entwicklung

```bash
npm install
npm run backend                # API auf http://127.0.0.1:8788
npm run dev                    # Frontend auf http://127.0.0.1:5173, leitet /api an das Backend weiter
```

## Build prüfen

```bash
npm run build
npm run lint
npm test
tests/agentpc/run.sh           # Installationstest in frischem Debian 13 (braucht Docker)
MISSION_CONTROL_API_PORT=8790 npm run backend
```

Danach liefert `http://127.0.0.1:8790` das gebaute Frontend und `http://127.0.0.1:8790/api/bootstrap` die Daten.

## Docker

```bash
docker compose up --build
```

Danach: `http://127.0.0.1:8787` (Port nur lokal freigegeben)

## Konfiguration

| Datei | Zweck |
|---|---|
| `config/app.yaml` | App-Einstellungen und Feature-Schalter |
| `config/agents.yaml` | neutrale Standard-Agentenliste (`Atlas`, `Nova`, `Scribe`) |
| `config/peers.example.yaml` | Muster für private Hermes-Peer-Endpunkte |
| `config/paths.example.yaml` | Beispiel für lokale Pfade |
| `config/setup-wizard.schema.yaml` | Felder des Setup-Wizards |
| `profiles/*.yaml` | Teamprofile (`example-team.yaml`, `bonys-agents.example.yaml`) |

Ein Profil kann seine eigene vollständige `agents:`-Liste enthalten. Diese hat Vorrang vor
`config/agents.yaml`. Dadurch bleibt die allgemeine Beispielkonfiguration neutral, während
`bonys-agents.example.yaml` Bonys Team als getrenntes, veröffentlichungssicheres Preset mitliefert.

Umgebungsvariablen des Backends:

| Variable | Standard | Bedeutung |
|---|---|---|
| `MISSION_CONTROL_API_HOST` | `127.0.0.1` | Adresse, auf der das Backend lauscht (im Container `0.0.0.0`) |
| `MISSION_CONTROL_API_PORT` | `8788` | Port |
| `MISSION_CONTROL_PROFILE` | `bonys-agents.example.yaml` | aktives Profil |
| `MISSION_CONTROL_SHOW_PRIVATE` | `false` | `true` zeigt Werte aus `*.local.yaml` ungeschwärzt |
| `MISSION_CONTROL_DATA_DIR` | – (im Container `/app/data`) | Datenordner; eigene Profile in `<Datenordner>/profiles/` |
| `MISSION_CONTROL_API_TOKEN` | automatisch erzeugt | Bearer-Token für Schreibzugriffe außerhalb von Loopback |

### Betriebsgrenzen der lokalen Mission-Ablage

Die unterstützte Architektur ist genau ein Mission-Control-Node-Prozess pro Datenordner. Eine gemeinsame
Missionsablage mit mehreren Backend-Prozessen oder Cluster-Koordination ist nicht Bestandteil der Unterstützung;
dafür wird keine fragile Lockdatei nachgebaut.

Wenn `MISSION_CONTROL_API_HOST` nicht auf Loopback (`127.0.0.1`, `::1` oder `localhost`) bindet, verlangt
`GET /api/missions` denselben serverseitigen Bearer-Token wie die geschützten Schreibzugriffe. Bei Loopback
bleibt der Missionslesezugriff ohne Token möglich. Das Token wird nicht an Vite oder in das Browser-Bundle
übergeben.

### Hermes-Peer-Erreichbarkeit

Private Peer-Adressen kommen in `<MISSION_CONTROL_DATA_DIR>/peers.yaml` (im Container `/app/data/peers.yaml`):

```yaml
peers:
  barney:
    endpoint: http://barney.internal:8377
    api_key_env: HERMES_PEER_BARNEY_KEY
```

Der Schlüssel (`barney`) entspricht `peer:` in der Agentenkonfiguration. Ohne `api_key_env` ruft Mission Control
`GET /health` mit 1,5 Sekunden Zeitlimit ab; das beweist ausschließlich Erreichbarkeit (`online`). Mit einem
serverseitig gesetzten Peer-Schlüssel fragt das Backend zusätzlich das authentifizierte `GET /health/detailed`
ab. `busy` wird nur gemeldet, wenn Hermes `gateway_busy: true`, `active_agents > 0` oder mindestens
einen aktiven API-Run meldet. Ein authentifiziert erreichbarer, aber untätiger Peer bleibt `online`.

Als `api_key_env` werden ausschließlich dedizierte Namen mit `HERMES_PEER_…_KEY` oder
`MISSION_CONTROL_PEER_…_KEY` akzeptiert. Die Werte gehören in die Serverumgebung, niemals in YAML. Sind
Detaildaten oder Schlüssel nicht verfügbar, fällt Mission Control auf die reine Erreichbarkeitsprüfung zurück
und erfindet keinen Arbeitsstatus. Peer-Adressen, Variablennamen und Schlüsselwerte werden nicht an das
Frontend ausgeliefert.

### Hermes-Mission-Run-Lifecycle

Missionen werden profilbezogen im lokalen Datenordner gespeichert. „Auftrag starten“ reserviert zuerst einen
stabilen Idempotency-Schlüssel und startet danach serverseitig einen asynchronen Hermes-Run über `POST /v1/runs`.
`runId`, Ziel-Agent, Startzeit und normalisierter Status werden an der Mission gespeichert. Solange der Run
`starting` oder `running` ist, fragt das Frontend den Status regelmäßig über `/api/missions/<id>/run/status` ab.
Ein laufender Run kann über `/api/missions/<id>/run/stop` gestoppt werden. Peer-Endpunkte und Credentials
bleiben ausschließlich im Backend; sie werden weder in das Browser-Bundle noch in API-Antworten übernommen.

## Datenschutz

Private Pfade, Peer-Adressen, Tokens und andere Geheimnisse gehören **nicht** ins Repository.
Eigene Werte kommen in eine Datei `profiles/<name>.local.yaml` – diese ist per `.gitignore` ausgeschlossen.
Öffentliche Profile verwenden Platzhalter wie `CHANGE_ME_PEER_URL` und `CHANGE_ME_PRIVATE_PATH`.
Private Peer-Adressen und die Namen dedizierter Peer-Schlüsselvariablen liegen ausschließlich im Daten-Volume
als `peers.yaml`; Schlüsselwerte bleiben in der Serverumgebung.

### Lokale Profile aus dem Setup-Wizard speichern

`POST /api/profiles` nimmt die validierten Wizard-Felder als JSON entgegen und erzeugt ausschließlich eine neue
`<slug>.local.yaml` unter `<MISSION_CONTROL_DATA_DIR>/profiles/`. Vorhandene Dateien werden nie überschrieben;
die neue Datei erhält Modus `600`. Der Server normalisiert das Profil selbst, erzwingt
`privacy.publish_safe: false` und übernimmt keine freien YAML-Strukturen vom Browser.

Der Vite-Entwicklungsproxy authentifiziert serverseitig sämtliche geschützten Schreibendpunkte: `POST /api/profiles`,
Missionen über `POST /api/missions` und `PATCH /api/missions/<id>` sowie Run-Start, Run-Status und Run-Stop
über die entsprechenden `POST /api/missions/<id>/run...`-Endpunkte. Er übernimmt `MISSION_CONTROL_API_TOKEN`
ausschließlich auf dem Server; der Token gelangt nicht in das Browser-Bundle. Ohne Token sind Schreibzugriffe
nur über eine direkte, passend geprüfte Loopback-Verbindung erlaubt. Anfragen ohne `Origin` sowie Anfragen
über einen Proxy werden ohne Token abgelehnt. `npm run dev` und `npm run preview` binden deshalb standardmäßig
nur an `127.0.0.1`.

Für bewusst entfernte oder anderweitig weitergeleitete Schreibzugriffe muss `MISSION_CONTROL_API_TOKEN` gesetzt
und als `Authorization: Bearer <TOKEN>` gesendet werden. Profiltexte dürfen keine Unicode-Steuerzeichen enthalten;
normalisierte Agenten-IDs müssen eindeutig sein und der Koordinator muss Teil der Agentenliste sein. Lokale
Profile erscheinen nur dann in API und Profilwähler, wenn `MISSION_CONTROL_SHOW_PRIVATE=true` ausdrücklich
aktiviert wurde.

Der private Datenordner, sein Profil-Unterverzeichnis sowie einzelne Profil- und Peer-Dateien werden ohne
Symlink-Following über verifizierte Verzeichnis-Handles geöffnet. Unsichere oder ausgetauschte Pfade werden
nicht gelesen; Mission Control fällt in diesem Fall auf die mitgelieferte öffentliche Konfiguration zurück und
verwendet keine privaten Peer-Zugangsdaten.

### Markdown-/Obsidian-Projektindex

Ist im aktiven Profil `integrations.notes` oder `integrations.obsidian` aktiviert, liest Mission Control den
konfigurierten Ordner ausschließlich lesend und zeigt im Mission Board Metadaten aus Markdown-Dateien an:
Titel, Datum und Tags. Der Index ist auf 100 Dateien, vier Verzeichnisebenen und 256 KiB pro Datei begrenzt.
Dateiinhalte, Dateinamen und private Pfade werden nicht an das Frontend ausgeliefert. Verlinkte Basisordner,
Unterordner und Dateien werden nicht verfolgt; nicht sicher erreichbare Ordner erscheinen als `unavailable`.

## Lizenz

Freie Software unter der **GNU General Public License, Version 3 oder neuer** (GPL-3.0-or-later),
wie Bony's Agents – siehe [LICENSE](LICENSE).

## YouTube

Mehr zu Bony's Agents auf YouTube: **[@BonysAgents](https://www.youtube.com/@BonysAgents)**

---

## English (short)

**Bony's Agents Mission Control** is an open-source dashboard for configurable AI-agent teams. Agents,
roles, paths and integrations are defined in YAML profiles; Bony's own team ships as an example profile.
It is a sibling of [Bony's Agents](https://github.com/zappotex/BonysAgents) and
[Bony's VPN](https://github.com/zappotex/bonys-vpn), but technically independent.

**Status:** development version 0.2.2 – React/Vite/TypeScript frontend, Node backend reading YAML at
runtime, setup wizard, resilient profile switching, Docker files, live Hermes peer reachability and
authenticated busy/idle detection, safe local profile persistence, and profile-scoped persisted missions.
A mission can start a real asynchronous Hermes run, poll its status, and stop a running run. Publication
and final release verification are still pending; this version is not published.

**Private Hermes peer credentials:** configure private peer endpoints in the server-side
`<MISSION_CONTROL_DATA_DIR>/peers.yaml` and reference credentials with a dedicated environment variable such
as `HERMES_PEER_EXAMPLE_KEY` or `MISSION_CONTROL_PEER_EXAMPLE_KEY` via `api_key_env`. Values stay out of YAML,
the browser bundle, and API responses.

**Run lifecycle:** starting a mission reserves a stable idempotency key, calls the peer's `POST /v1/runs`,
stores the returned run ID and status, polls `GET /v1/runs/<run-id>` while active, and can request
`POST /v1/runs/<run-id>/stop`. The dashboard exposes this through its mission endpoints; credentials remain
server-side.

**Install (Debian/Ubuntu, amd64/arm64):** the currently documented installer is the published `0.2.2`
release. Install with `sudo bash install.sh --version 0.2.2 --install-deps`, then open `http://127.0.0.1:8787/`.
Details: [docs/installation-agent-pc.md](docs/installation-agent-pc.md).
**Development:** Node.js 20.19+ or 22.12+, then `npm install`, `npm run backend`, `npm run dev`.

**License:** GPL-3.0-or-later. **YouTube:** [@BonysAgents](https://www.youtube.com/@BonysAgents)
