# Plan – nächste Schritte

Stand: 2026-10-13, Version 0.5.0. Grundlage ist die [Zusammenfassung](zusammenfassung.md)
(Abschnitt „Nächster sinnvoller Schritt“). Jede Sitzung soll mit grünem Lint, Typprüfung, Build
und Tests enden.

## Sitzung 1 – Fundament: Tests, CI, Laufzeit

- Testrahmen einführen (z. B. Vitest) und das Backend testbar machen
  (Funktionen aus `server/server.mjs` exportieren bzw. in ein Modul auslagern).
- Erste Tests: Schwärzung privater Werte, `sanitizeProfileName` (keine `.local.yaml` ohne Freigabe,
  kein Pfad-Ausbruch), statische Auslieferung nur aus `dist/`, `/api/bootstrap` mit Beispielprofil.
- GitHub Actions: `npm ci`, `npm run lint`, `tsc -b`, `npm run build`, Tests, gitleaks.
- Docker-Basisimage von `node:20-alpine` auf eine noch gepflegte LTS-Version (22 oder 24) heben;
  Build mit `npm ci --omit=dev` im Laufzeit-Image (mehrstufiger Build).
- Backend im Dev-Modus standardmäßig nur an `127.0.0.1` binden; Fehlermeldungen an Clients ohne Interna.
- Vite-Vorlagenreste prüfen (`src/assets/react.svg`, `vite.svg`) und entfernen, falls ungenutzt.

## Sitzung 2 – Profilauswahl im Frontend

Empfohlener nächster Schritt laut Zusammenfassung.

- Profilliste aus `/api/profiles` anzeigen, Wechsel lädt `/api/bootstrap?profile=…`.
- Gewähltes Profil im Browser merken; `*.local.yaml` nur, wenn das Backend sie freigibt.
- Kennzeichnung „öffentlich / nur lokal“ in der Oberfläche.

## Sitzung 3 – Profile speichern

- `POST /api/profiles`: Wizard-Ergebnis serverseitig gegen `config/setup-wizard.schema.yaml` prüfen
  und als `profiles/<slug>.local.yaml` speichern (nie als öffentliches Profil überschreiben).
- Schutz: nur von localhost oder mit Token aus `.env`; Dateinamen streng prüfen.
- Tests für Validierung und Dateinamen.

## Sitzung 4 – Hermes-Peer-Status

- Peers aus dem Profil periodisch abfragen (Zeitlimit, Fehler tolerieren) und echten Status statt
  der festen `defaultStatusById`-Werte anzeigen.
- Endpunkte nur aus lokalen Profilen, nie im öffentlichen Repo.

## Sitzung 5 – Obsidian-/Projektindex

- Markdown-Dateien eines konfigurierten Ordners nur lesend indizieren (Titel, Datum, Tags).
- Anzeige im Board; private Pfade bleiben geschwärzt.

## Sitzung 6 – Missionen dauerhaft speichern

- Mission Board von statischen Daten auf eine Datei- oder SQLite-Ablage umstellen.
- Missionen anlegen, Status ändern, Agenten zuweisen.

## Sitzung 7 – Veröffentlichung

- Alles durchsehen, Repo öffentlich schalten, ersten Tag/Release anlegen (nur nach Rückfrage).
- Optional Docker-Image über GitHub Container Registry bereitstellen.
- Verweise in den READMEs von Bony's Agents und Bony's VPN ergänzen.
