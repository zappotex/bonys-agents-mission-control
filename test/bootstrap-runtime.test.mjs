import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyBootstrapFailure,
  applyBootstrapSuccess,
  createBootstrapPoller,
  deriveWizardIdentity,
  persistSelectedProfile,
  readStoredProfile,
  rollbackProfileAfterFailure,
} from '../src/bootstrap-runtime.mjs'

const fallback = {
  source: 'fallback',
  activeProfile: { file: 'fallback.yaml' },
  agents: [{ id: 'fallback', status: 'standby', statusSource: 'configured' }],
}

const liveBootstrap = {
  source: 'backend',
  activeProfile: { file: 'confirmed.yaml' },
  agents: [
    { id: 'live', status: 'busy', statusSource: 'live' },
    { id: 'configured', status: 'online', statusSource: 'configured' },
  ],
}

test('erster Backendfehler verwendet veröffentlichungssichere Fallback-Daten', () => {
  const result = applyBootstrapFailure(liveBootstrap, fallback, false)
  assert.equal(result.apiState, 'fallback')
  assert.equal(result.bootstrap, fallback)
})

test('späterer Backendfehler behält Daten und markiert nur Live-Zustände als stale', () => {
  const result = applyBootstrapFailure(liveBootstrap, fallback, true)
  assert.equal(result.apiState, 'degraded')
  assert.deepEqual(result.bootstrap.agents, [
    { id: 'live', status: 'offline', statusSource: 'stale' },
    { id: 'configured', status: 'online', statusSource: 'configured' },
  ])
  assert.equal(liveBootstrap.agents[0].status, 'busy')
})

test('erfolgreiche Folgeabfrage stellt Backend-Zustand wieder her', () => {
  const recovered = {
    ...liveBootstrap,
    agents: [{ id: 'live', status: 'online', statusSource: 'live' }],
  }
  const result = applyBootstrapSuccess(recovered)
  assert.equal(result.apiState, 'backend')
  assert.equal(result.bootstrap.source, 'backend')
  assert.equal(result.bootstrap.agents[0].statusSource, 'live')
})

test('ältere Bootstrap-Antworten ohne projectIndex werden zentral deaktiviert normalisiert', () => {
  const legacyBootstrap = {
    activeProfile: { file: 'legacy.yaml' },
    agents: [],
  }

  const result = applyBootstrapSuccess(legacyBootstrap)

  assert.deepEqual(result.bootstrap.projectIndex, { status: 'disabled', documents: [] })
  assert.equal(result.apiState, 'backend')
})

test('Wizard übernimmt den expliziten Koordinator auch wenn er nicht der erste Agent ist', () => {
  const identity = deriveWizardIdentity({
    team: { owner: 'Alice', coordinator: 'Atlas' },
    agents: [
      { id: 'alice', name: 'Alice', type: 'human' },
      { id: 'nova', name: 'Nova', type: 'hermes-peer' },
      { id: 'atlas', name: 'Atlas', type: 'hermes-peer' },
    ],
  }, {
    ownerName: 'Fallback Owner',
    coordinatorName: 'Fallback Coordinator',
  })

  assert.deepEqual(identity, {
    ownerName: 'Alice',
    coordinatorName: 'Atlas',
    agentNames: 'Nova, Atlas',
  })
})

test('fehlgeschlagener Profilwechsel rollt auf das bestätigte Profil zurück', () => {
  assert.equal(rollbackProfileAfterFailure('pending.yaml', 'confirmed.yaml'), 'confirmed.yaml')
  assert.equal(rollbackProfileAfterFailure('confirmed.yaml', 'confirmed.yaml'), undefined)
  assert.equal(rollbackProfileAfterFailure('', 'confirmed.yaml'), undefined)
})

test('Polling startet den nächsten Lauf erst nach Abschluss des aktuellen Requests', async () => {
  let resolveRequest
  let fetchCalls = 0
  let clearedRequestTimers = 0
  const timers = []
  const poller = createBootstrapPoller({
    fetchBootstrap: () => {
      fetchCalls += 1
      return new Promise((resolve) => { resolveRequest = resolve })
    },
    onSuccess: () => {},
    onFailure: () => {},
    setTimer: (callback) => {
      timers.push(callback)
      return timers.length
    },
    clearTimer: () => {},
    setRequestTimer: () => ({ type: 'request-timeout' }),
    clearRequestTimer: () => { clearedRequestTimers += 1 },
  })

  poller.start('confirmed.yaml')
  await Promise.resolve()
  assert.equal(fetchCalls, 1)
  assert.equal(timers.length, 0)

  resolveRequest(liveBootstrap)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(timers.length, 1)
  assert.equal(clearedRequestTimers, 1)

  timers[0]()
  await Promise.resolve()
  assert.equal(fetchCalls, 2)
  poller.stop()
})

test('Stoppen bricht den Request ab und verhindert Zustandsupdates und weitere Timer', async () => {
  let capturedSignal
  let successes = 0
  let failures = 0
  let timers = 0
  let clearedRequestTimers = 0
  const poller = createBootstrapPoller({
    fetchBootstrap: (_profile, signal) => {
      capturedSignal = signal
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    },
    onSuccess: () => { successes += 1 },
    onFailure: () => { failures += 1 },
    setTimer: () => { timers += 1; return timers },
    clearTimer: () => {},
    setRequestTimer: () => ({ type: 'request-timeout' }),
    clearRequestTimer: () => { clearedRequestTimers += 1 },
  })

  poller.start('confirmed.yaml')
  await Promise.resolve()
  poller.stop()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(capturedSignal.aborted, true)
  assert.equal(successes, 0)
  assert.equal(failures, 0)
  assert.equal(timers, 0)
  assert.equal(clearedRequestTimers, 1)
})

test('Polling übernimmt das gewählte Profil und räumt einen geplanten Folgelauf auf', async () => {
  let requestedProfile
  let scheduledTimer
  let clearedTimer
  const poller = createBootstrapPoller({
    fetchBootstrap: async (profile) => {
      requestedProfile = profile
      return liveBootstrap
    },
    onSuccess: () => {},
    onFailure: () => {},
    setTimer: (callback) => {
      scheduledTimer = { callback }
      return scheduledTimer
    },
    clearTimer: (timer) => { clearedTimer = timer },
  })

  poller.start('example-team.yaml')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(requestedProfile, 'example-team.yaml')
  assert.ok(scheduledTimer)

  poller.stop()
  assert.equal(clearedTimer, scheduledTimer)
})

test('wiederholtes Starten erzeugt keine zweite Polling-Kette', async () => {
  let fetchCalls = 0
  const poller = createBootstrapPoller({
    fetchBootstrap: async () => {
      fetchCalls += 1
      return liveBootstrap
    },
    onSuccess: () => {},
    onFailure: () => {},
    setTimer: () => 1,
    clearTimer: () => {},
  })

  poller.start('confirmed.yaml')
  poller.start('confirmed.yaml')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fetchCalls, 1)
  poller.stop()
})

test('Stoppen und Neustarten ignoriert verspätete Fehler der alten Polling-Generation', async () => {
  let fetchCalls = 0
  let failures = 0
  let timers = 0
  const poller = createBootstrapPoller({
    fetchBootstrap: (_profile, signal) => {
      fetchCalls += 1
      if (fetchCalls === 1) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('old request aborted')), { once: true })
        })
      }
      return new Promise(() => {})
    },
    onSuccess: () => {},
    onFailure: () => { failures += 1 },
    setTimer: () => { timers += 1; return timers },
    clearTimer: () => {},
  })

  poller.start('first.yaml')
  await Promise.resolve()
  poller.stop()
  poller.start('second.yaml')
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(fetchCalls, 2)
  assert.equal(failures, 0)
  assert.equal(timers, 0)
  poller.stop()
})

test('ein hängender Bootstrap-Request wird nach dem Timeout abgebrochen und Polling läuft weiter', async () => {
  let timeoutCallback
  let capturedSignal
  let failures = 0
  let scheduledPolls = 0
  const poller = createBootstrapPoller({
    fetchBootstrap: (_profile, signal) => {
      capturedSignal = signal
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('request timeout')), { once: true })
      })
    },
    onSuccess: () => {},
    onFailure: () => { failures += 1 },
    setTimer: () => { scheduledPolls += 1; return scheduledPolls },
    clearTimer: () => {},
    setRequestTimer: (callback) => { timeoutCallback = callback; return 1 },
    clearRequestTimer: () => {},
    requestTimeout: 10_000,
  })

  poller.start('confirmed.yaml')
  await Promise.resolve()
  assert.ok(timeoutCallback)

  timeoutCallback()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(capturedSignal.aborted, true)
  assert.equal(failures, 1)
  assert.equal(scheduledPolls, 1)
  poller.stop()
})

test('nur sichere YAML-Profilnamen werden aus dem Browser-Speicher übernommen', () => {
  const storage = {
    getItem: () => 'example-team.yaml',
  }
  assert.equal(readStoredProfile(storage), 'example-team.yaml')
  assert.equal(readStoredProfile({ getItem: () => '../private.local.yaml' }), '')
  assert.equal(readStoredProfile({ getItem: () => 'not-yaml.txt' }), '')
  assert.equal(readStoredProfile({ getItem: () => { throw new Error('blocked') } }), '')
})

test('bestätigte Profile werden gespeichert und ein leerer Rollback entfernt die Auswahl', () => {
  const operations = []
  const storage = {
    setItem: (key, value) => operations.push(['set', key, value]),
    removeItem: (key) => operations.push(['remove', key]),
  }

  persistSelectedProfile(storage, 'example-team.yaml')
  persistSelectedProfile(storage, '')
  persistSelectedProfile(storage, '../private.local.yaml')

  assert.deepEqual(operations, [
    ['set', 'bonys-mission-control.profile', 'example-team.yaml'],
    ['remove', 'bonys-mission-control.profile'],
    ['remove', 'bonys-mission-control.profile'],
  ])
})
