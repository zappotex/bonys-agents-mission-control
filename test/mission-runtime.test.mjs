import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canStartMissionRun,
  createMissionRunPoller,
  filterMissions,
  filterMissionsByState,
  missionEmptyState,
  missionFilterSummary,
  missionStateClass,
  missionStateLabel,
  missionDescriptionForDisplay,
  missionOwnerForDisplay,
  missionTitleForDisplay,
  resultKindLabelForMission,
  missionStateCounts,
  missionRunActionLabel,
  normalizeMissionResponse,
  outboxMissions,
  missionResultForClipboard,
  resultKindForMission,
  formatMissionTimestamp,
  replaceMission,
} from '../src/mission-runtime.mjs'

const mission = {
  id: 'mission-11111111-1111-4111-8111-111111111111',
  profile: 'example-team.yaml',
  title: 'Frontend anbinden',
  description: 'Mission Board mit der API verbinden.',
  owner: 'Atlas',
  state: 'running',
  createdAt: '2026-10-16T20:00:00.000Z',
  updatedAt: '2026-10-16T20:00:00.000Z',
}

test('Mission-Filter zeigt alle Missionen oder nur den gewählten Status', () => {
  const missions = [
    mission,
    { ...mission, id: 'mission-22222222-2222-4222-8222-222222222222', state: 'review' },
    { ...mission, id: 'mission-33333333-3333-4333-8333-333333333333', state: 'done' },
  ]

  assert.deepEqual(filterMissionsByState(missions, 'all'), missions)
  assert.deepEqual(filterMissionsByState(missions, 'review'), [missions[1]])
  assert.deepEqual(filterMissionsByState(missions, 'unknown'), [])
})

test('Outbox-Ergebnis wird für Zwischenablage sicher als Text bereitgestellt', () => {
  assert.equal(missionResultForClipboard({ result: '  Ergebnisnotiz  ' }), 'Ergebnisnotiz')
  assert.equal(missionResultForClipboard({ result: 42 }), '')
  assert.equal(missionResultForClipboard({ result: '   ' }), '')
})
test('Mission-Suche, Statuszahlen und Outbox-Sortierung bleiben deterministisch', () => {
  const missions = [
    { ...mission, id: 'mission-44444444-4444-4444-8444-444444444444', title: 'Video planen', owner: 'Barney', updatedAt: '2026-10-21T10:00:00.000Z', result: 'video.mp4', resultKind: 'file', state: 'done' },
    { ...mission, id: 'mission-55555555-5555-4555-8555-555555555555', title: 'Recherche prüfen', owner: 'Lily', updatedAt: '2026-10-21T11:00:00.000Z', state: 'review' },
  ]

  assert.deepEqual(filterMissions(missions, 'all', 'barney').map((item) => item.id), [missions[0].id])
  assert.deepEqual(missionStateCounts(missions), { all: 2, running: 0, planned: 0, review: 1, done: 1 })
  assert.deepEqual(outboxMissions(missions).map((item) => item.id), [missions[0].id])
})

test('Outbox sortiert ungültige Zeitstempel hinter gültige Ergebnisse', () => {
  const missions = [
    { ...mission, id: 'mission-valid', state: 'done', result: 'gültig', updatedAt: '2026-10-21T11:00:00.000Z' },
    { ...mission, id: 'mission-invalid', state: 'done', result: 'alt', updatedAt: 'not-a-date' },
  ]
  assert.deepEqual(outboxMissions(missions).map((item) => item.id), ['mission-valid', 'mission-invalid'])
})
test('Mission-Filter fasst Suchtext und Status verständlich zusammen', () => {
  assert.equal(missionFilterSummary({ total: 4, visible: 2, query: 'barney', state: 'done' }), '2 von 4 Missionen · Suche „barney“ · Status „Fertig“')
  assert.equal(missionFilterSummary({ total: 4, visible: 4, query: '', state: 'all' }), '4 Missionen')
})
test('Mission-Status erhält für unbekannte Werte eine sichere Anzeige', () => {
  assert.equal(missionStateLabel('running'), 'Aktiv')
  assert.equal(missionStateLabel('unexpected'), 'Unbekannt')
})
test('Mission-Anzeige-Helfer normalisieren Status, Titel und Ergebnisart sicher', () => {
  assert.equal(missionStateClass('unexpected'), 'unknown')
  assert.equal(missionTitleForDisplay({ title: '  Auftrag  ' }), 'Auftrag')
  assert.equal(missionTitleForDisplay({ title: '' }), 'Unbenannte Mission')
  assert.equal(resultKindLabelForMission({ result: 'x', resultKind: 'script' }), 'Notiz')
  assert.equal(resultKindLabelForMission({ result: '', resultKind: 'link' }), '')
  assert.equal(missionDescriptionForDisplay({ description: '  Ziel  ' }), 'Ziel')
  assert.equal(missionDescriptionForDisplay({ description: '' }), 'Keine Beschreibung hinterlegt.')
  assert.equal(missionOwnerForDisplay({ owner: '  Atlas  ' }), 'Atlas')
  assert.equal(missionOwnerForDisplay({ owner: '' }), 'Nicht zugewiesen')
})
test('Mission-Leerzustand unterscheidet fehlende Missionen von leeren Suchtreffern', () => {
  assert.equal(missionEmptyState({ total: 0, visible: 0, query: '', state: 'all' }), 'Noch keine Missionen für dieses Profil.')
  assert.equal(missionEmptyState({ total: 3, visible: 0, query: 'barney', state: 'all' }), 'Keine Mission passt zu dieser Suche.')
  assert.equal(missionEmptyState({ total: 3, visible: 0, query: '', state: 'review' }), 'Keine Mission im Status „Review“.')
})

test('Ergebnisart bleibt nur bei vorhandener Ergebnisnotiz sichtbar und fällt sicher zurück', () => {
  assert.equal(resultKindForMission({ result: 'note', resultKind: 'link' }), 'link')
  assert.equal(resultKindForMission({ result: 'note', resultKind: 'script' }), 'note')
  assert.equal(resultKindForMission({ result: '', resultKind: 'file' }), '')
})

test('Mission-Zeitstempel bleiben für gültige und ungültige Werte sicher lesbar', () => {
  assert.match(formatMissionTimestamp('2026-10-21T12:34:00.000Z'), /21\.10\.26/)
  assert.equal(formatMissionTimestamp('not-a-date'), '—')
})

test('Rerun-Aktion ist nur ohne Run oder nach terminalem Run möglich und wird eindeutig beschriftet', () => {
  assert.equal(canStartMissionRun(mission), true)
  assert.equal(missionRunActionLabel(mission), 'Auftrag starten')
  assert.equal(canStartMissionRun({ ...mission, runId: 'run-1', runStatus: 'starting' }), false)
  assert.equal(canStartMissionRun({ ...mission, runId: 'run-1', runStatus: 'running' }), false)
  assert.equal(canStartMissionRun({ ...mission, runStatus: 'starting' }), true)
  assert.equal(missionRunActionLabel({ ...mission, runStatus: 'starting' }), 'Start wiederholen')
  assert.equal(canStartMissionRun({ ...mission, runStatus: 'running' }), false)

  for (const status of ['completed', 'failed', 'cancelled', 'interrupted']) {
    const terminal = { ...mission, runId: 'old-run', runStatus: status }
    assert.equal(canStartMissionRun(terminal), true)
    assert.equal(missionRunActionLabel(terminal), 'Erneut starten')
  }
})

test('Mission-Antworten werden in einen stabilen UI-Zustand normalisiert', () => {
  assert.deepEqual(normalizeMissionResponse({ missions: [mission], storageAvailable: true }), {
    missions: [{ ...mission, runHistory: [] }],
    storageAvailable: true,
  })
  assert.deepEqual(normalizeMissionResponse({ missions: 'invalid', storageAvailable: false }), {
    missions: [],
    storageAvailable: false,
  })
})

test('Browser-Normalisierung verwendet eine explizite Allowlist und schützt runError', () => {
  const result = normalizeMissionResponse({ missions: [{
    ...mission,
    runError: 'unsafe-details',
    credential: 'secret',
    peerOutput: 'secret',
    endpoint: 'https://internal.invalid',
    authorization: 'Bearer secret',
    arbitrarySecret: 'secret',
    runHistory: [{
      attempt: 1,
      status: 'failed',
      credential: 'secret',
      peerOutput: 'secret',
      endpoint: 'https://internal.invalid',
      authorization: 'Bearer secret',
      arbitrarySecret: 'secret',
      runError: 'unsafe-details',
    }],
  }] })

  assert.deepEqual(result.missions[0], {
    ...mission,
    runHistory: [{ attempt: 1, status: 'failed' }],
  })
  assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.equal(JSON.stringify(result).includes('unsafe-details'), false)

  const safe = normalizeMissionResponse({ missions: [{ ...mission, runError: 'peer_run_failed' }] })
  assert.equal(safe.missions[0].runError, 'peer_run_failed')

  const invalidKind = normalizeMissionResponse({ missions: [{ ...mission, result: 'result', resultKind: 'script' }] })
  assert.equal(invalidKind.missions[0].resultKind, 'note')
})

test('aktualisierte Missionen ersetzen exakt ihren bisherigen Listeneintrag', () => {
  const other = { ...mission, id: 'mission-22222222-2222-4222-8222-222222222222', title: 'Zweite Mission' }
  const updated = { ...mission, owner: 'Nova', state: 'review', updatedAt: '2026-10-16T20:01:00.000Z' }

  assert.deepEqual(replaceMission([mission, other], updated), [updated, other])
  assert.deepEqual(replaceMission([other], updated), [other, updated])
})

test('Stop-Invalidierung übernimmt keine verspätete Poll-Antwort', async () => {
  const updates = []
  let resolveStatus
  const poller = createMissionRunPoller({
    getMissions: () => [{ ...mission, runId: 'run-123', runStatus: 'running' }],
    fetchStatus: () => new Promise((resolve) => { resolveStatus = resolve }),
    onMission: (updated) => updates.push(updated),
  })

  poller.start('example-team.yaml')
  await Promise.resolve()
  poller.invalidate(mission.id)
  resolveStatus({ ...mission, runId: 'run-123', runStatus: 'running' })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(updates, [])
  poller.stop()
})


test('Run-Status-Polling bleibt single-flight, aktualisiert Missionen und stoppt terminale Runs', async () => {
  let missions = [{ ...mission, runId: 'run-123', runStatus: 'running' }]
  const requests = []
  const scheduled = []
  const updates = []
  let resolveFirst

  const poller = createMissionRunPoller({
    getMissions: () => missions,
    fetchStatus: (pendingMission, profile, signal) => {
      requests.push({ pendingMission, profile, signal })
      if (requests.length === 1) {
        return new Promise((resolve) => { resolveFirst = resolve })
      }
      return new Promise(() => {})
    },
    onMission: (updated) => {
      updates.push(updated)
      missions = replaceMission(missions, updated)
    },
    schedule: (callback) => {
      scheduled.push(callback)
      return callback
    },
    clearSchedule: () => {},
    intervalMs: 5,
  })

  poller.start('example-team.yaml')
  poller.start('example-team.yaml')
  await Promise.resolve()
  assert.equal(requests.length, 1)
  assert.equal(scheduled.length, 0)

  resolveFirst({ ...missions[0], runStatus: 'completed' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(updates[0].runStatus, 'completed')
  assert.equal(scheduled.length, 1)

  scheduled[0]()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(requests.length, 1)

  poller.stop()
})
