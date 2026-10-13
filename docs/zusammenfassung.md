# Bonys Agents Mission Control — Zusammenfassung

> Bereinigte Fassung der ursprünglichen Projektzusammenfassung (Stand 2026-10-13): Heimnetz-Adresse und private Pfade sind durch Platzhalter ersetzt, Projektpfade sind relativ zum Repo-Ordner.

Stand: 2026-10-13

## Kurzfassung

**Bonys Agents Mission Control** ist ein erstes lauffähiges Open-Source Mission-Control-Dashboard für Agenten-Teams.

Es ist **nicht fest auf Bonys Team verdrahtet**, sondern arbeitet mit konfigurierbaren Profilen und YAML-Dateien. Bonys Agents ist als vorkonfiguriertes Beispiel-/Lokalprofil vorbereitet.

---

## Aktueller Live-Zugriff

Frontend / Board:

```text
http://<HOST-IP>:5173
```

Backend-API:

```text
http://127.0.0.1:8788
```

Wichtige API-Endpunkte:

```text
http://127.0.0.1:8788/api/health
http://127.0.0.1:8788/api/profiles
http://127.0.0.1:8788/api/bootstrap
```

Aktuell laufende Prozesse:

```text
Frontend: npm run dev -- --host 0.0.0.0
Backend:  npm run backend
```

---

## Was das Board aktuell kann

### 1. Agenten-Flotte anzeigen

Aktuell sichtbar:

- Bony
- Phaseone0815
- Barney
- Current
- Lily

Die Daten kommen inzwischen aus:

```text
config/agents.yaml
profiles/bonys-agents.example.yaml
```

Die Agenten sind also nicht mehr hart im Frontend verdrahtet.

---

### 2. Mission Board anzeigen

Aktuell drin:

- Bonys Agents Mission Control
- Konfigurierbares Profil-System
- Bonys vorkonfiguriertes Teamprofil

Das Mission Board ist aktuell noch statisch im Frontend, aber der UI-Bereich ist bereits vorhanden.

---

### 3. Setup-Wizard

Der Wizard kann aktuell ein Profil als YAML erzeugen.

Felder:

- Teamname
- Besitzer / Operator
- Koordinator
- Agentenliste
- Projektpfad
- Notiz-/Obsidian-Pfad
- Output-/Video-Pfad
- Theme
- Hermes-Peers ja/nein
- Obsidian/Markdown ja/nein

Aktionen:

- YAML kopieren
- YAML herunterladen

Noch nicht eingebaut:

- direktes Speichern zurück auf den Server

Das wäre einer der nächsten sinnvollen Schritte.

---

### 4. Backend

Das Backend liest YAML-Dateien zur Laufzeit und liefert sie per API ans Frontend.

Backend-Datei:

```text
server/server.mjs
```

API:

```text
/api/health
/api/profiles
/api/bootstrap
```

`/api/bootstrap` liefert:

- App-Name
- Version
- aktives Profil
- verfügbare Profile
- Agentenliste
- Privacy-/Redaction-Status

---

### 5. Docker

Dockerfile und Compose sind vorbereitet und getestet.

Dateien:

```text
Dockerfile
docker-compose.yml
```

Getestet:

```text
docker build: erfolgreich
docker compose up: erfolgreich
/api/health: erfolgreich
/api/bootstrap: erfolgreich
```

Der Testcontainer wurde nach dem Test wieder gestoppt.

---

## Hauptordner des Projekts

```text
<PROJEKTORDNER>
```

---

## Wichtigste Dateien

### Frontend

```text
src/App.tsx
src/App.css
src/main.tsx
index.html
```

### Backend

```text
server/server.mjs
```

### App-Konfiguration

```text
config/app.yaml
config/agents.yaml
config/paths.example.yaml
config/setup-wizard.schema.yaml
```

### Profile

Öffentliche Profile:

```text
profiles/example-team.yaml
profiles/bonys-agents.example.yaml
```

Lokales privates Bonys-Profil:

```text
profiles/bonys-agents.local.yaml
```

Diese Datei enthält lokale Pfade / interne Werte und ist per `.gitignore` geschützt.

---

## Datenschutz

Öffentliche Dateien enthalten keine echten privaten Pfade oder internen Peer-Adressen.

Öffentlich steht nur sowas wie:

```text
CHANGE_ME_PEER_URL
CHANGE_ME_PRIVATE_PATH
```

Die echten lokalen Werte liegen nur hier:

```text
profiles/bonys-agents.local.yaml
```

und werden standardmäßig nicht veröffentlicht.

Standard im Backend:

```text
MISSION_CONTROL_SHOW_PRIVATE=false
```

Nur wenn explizit gesetzt wird:

```bash
MISSION_CONTROL_SHOW_PRIVATE=true
```

würden lokale private Werte sichtbar gemacht.

---

## Dokumentation in Obsidian

Ordner:

```text
<OBSIDIAN-TRESOR>/01_Projekte/Software/2026-10-13_Bonys-Agents-Mission-Control
```

Dateien dort:

```text
Open-Source-Konzept.md
Projektstand-v0.1-Scaffold.md
Projektstand-v0.2-Setup-Wizard.md
Projektstand-v0.3-Scaffold.md
Projektstand-v0.4-YAML-Konfiguration.md
Projektstand-v0.5-Runtime-Backend-und-Docker.md
```

Wichtigster aktueller Stand:

```text
Projektstand-v0.5-Runtime-Backend-und-Docker.md
```

---

## Aktuelle Version

```text
0.5.0
```

---

## Verifizierter Stand

Build:

```text
npm run build
✓ built
```

Lint:

```text
npm run lint
oxlint ohne Fehler
```

Backend direkt:

```text
Bonys Agents Mission Control 0.5.0
source= backend
activeProfile= bonys-agents.example.yaml
agents= ['Bony', 'Phaseone0815', 'Barney', 'Current', 'Lily']
privateValuesVisible= False
```

Docker-Test:

```text
docker_health= True
docker_version= 0.5.0
docker_active= bonys-agents.example.yaml
docker_agents= 5
```

---

## Nächster sinnvoller Schritt

Empfohlen:

```text
Profil-Auswahl im Frontend
```

Damit kann man im Board zwischen Profilen wechseln, z. B.:

- `example-team.yaml`
- `bonys-agents.example.yaml`
- später lokal: `bonys-agents.local.yaml`

Danach sinnvoll:

```text
Profile speichern
Hermes-Peer-Status anbinden
Obsidian-/Projektindex anzeigen
Missionen persistent speichern
```
