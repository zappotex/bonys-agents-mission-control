import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { attachMissionRun, claimMissionRun, createMission, getMission } from '../server/mission-storage.mjs'
import { normalizeMissionResponse, missionHistoryForDisplay } from '../src/mission-runtime.mjs'

async function setup() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mission-history-'))
  await mkdir(path.join(dataDir, 'profiles'))
  const mission = await createMission(dataDir, { profile: 'test.yaml', title: 'History', owner: 'Agent' })
  return { dataDir, mission }
}

async function cleanup(dataDir) {
  await rm(dataDir, { recursive: true, force: true })
}

const safeKeys = ['attempt', 'runId', 'agentId', 'status', 'startedAt', 'finishedAt']

test('erster Claim legt einen sicheren starting-Snapshot an', async () => {
  const { dataDir, mission } = await setup()
  try {
    const claim = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent-1' })
    assert.equal(claim.mission.runAttempt, 1)
    assert.deepEqual(claim.mission.runHistory, [{
      attempt: 1,
      agentId: 'agent-1',
      status: 'starting',
      startedAt: claim.mission.runStartedAt,
    }])
    assert.deepEqual(Object.keys(claim.mission.runHistory[0]).sort(), ['agentId', 'attempt', 'startedAt', 'status'])
  } finally { await cleanup(dataDir) }
})

test('terminales Attach aktualisiert nur den gefenceten History-Eintrag', async () => {
  const { dataDir, mission } = await setup()
  try {
    const claim = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent-1' })
    const updated = await attachMissionRun(dataDir, mission.id, mission.profile, {
      runId: 'run-1', runStatus: 'completed', runFinishedAt: '2026-10-17T10:00:00.000Z',
    }, { expectedRunAttempt: claim.mission.runAttempt })
    assert.equal(updated.runHistory[0].runId, 'run-1')
    assert.equal(updated.runHistory[0].status, 'completed')
    assert.equal(updated.runHistory[0].finishedAt, '2026-10-17T10:00:00.000Z')
    assert.equal(updated.runHistory[0].runStatus, undefined)
    assert.equal(updated.runHistory[0].runError, undefined)
  } finally { await cleanup(dataDir) }
})

test('replayte parallele Claims erzeugen genau eine Attempt-Zeile', async () => {
  const { dataDir, mission } = await setup()
  try {
    const claims = await Promise.all([
      claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent-1' }),
      claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent-1' }),
    ])
    assert.equal(claims[0].mission.runHistory.length, 1)
    assert.equal(claims[1].mission.runHistory.length, 1)
    assert.deepEqual(claims[0].mission.runHistory, claims[1].mission.runHistory)
  } finally { await cleanup(dataDir) }
})

test('Rerun backfilled den vorherigen Top-Level-Run und erhält beide Attempts', async () => {
  const { dataDir, mission } = await setup()
  try {
    const first = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent-1' })
    await attachMissionRun(dataDir, mission.id, mission.profile, { runId: 'run-1', runStatus: 'completed' }, { expectedRunAttempt: first.mission.runAttempt })
    const second = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent-2' })
    assert.deepEqual(second.mission.runHistory.map((entry) => entry.attempt), [1, 2])
    assert.equal(second.mission.runHistory[0].runId, 'run-1')
    assert.equal(second.mission.runHistory[0].status, 'completed')
    assert.equal(second.mission.runHistory[1].status, 'starting')
  } finally { await cleanup(dataDir) }
})

test('Legacy-Backfill und malformed History bleiben sicher und privat', async () => {
  const { dataDir, mission } = await setup()
  try {
    const storePath = path.join(dataDir, 'missions.json')
    const store = JSON.parse(await readFile(storePath, 'utf8'))
    const stored = store.missions[0]
    Object.assign(stored, { runAttempt: 3, runId: 'legacy-run', runStatus: 'failed', runStartedAt: '2026-10-16T10:00:00.000Z', runFinishedAt: '2026-10-16T10:01:00.000Z', runError: 'secret', peerOutput: 'secret', customSecret: 'secret' })
    stored.runHistory = [{ attempt: 99, status: 'completed', prompt: 'secret' }, { attempt: 3, status: 'failed', runId: 'legacy-run', startedAt: stored.runStartedAt, finishedAt: stored.runFinishedAt, credential: 'secret' }]
    await writeFile(storePath, JSON.stringify(store))
    const current = await getMission(dataDir, mission.id, mission.profile)
    assert.deepEqual(current.runHistory, [{ attempt: 3, runId: 'legacy-run', status: 'failed', startedAt: stored.runStartedAt, finishedAt: stored.runFinishedAt }, { attempt: 99, status: 'completed' }])
    assert.equal(JSON.stringify(current).includes('secret'), false)
  } finally { await cleanup(dataDir) }
})

test('Legacy-Backfill ohne History übernimmt terminalen Top-Level-Run mit finishedAt exakt einmal', async () => {
  const { dataDir, mission } = await setup()
  try {
    const storePath = path.join(dataDir, 'missions.json')
    const store = JSON.parse(await readFile(storePath, 'utf8'))
    const stored = store.missions[0]
    Object.assign(stored, {
      runId: 'legacy-terminal-run',
      runStatus: 'completed',
      agentId: 'legacy-agent',
      runStartedAt: '2026-10-16T10:00:00.000Z',
      runFinishedAt: '2026-10-16T10:01:00.000Z',
      idempotencyKey: `mission:${mission.id}:run:v4`,
    })
    delete stored.runAttempt
    delete stored.runHistory
    await writeFile(storePath, JSON.stringify(store))

    const rerun = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'new-agent' })
    assert.equal(rerun.mission.runAttempt, 5)
    assert.deepEqual(rerun.mission.runHistory.map((entry) => entry.attempt), [4, 5])
    assert.deepEqual(rerun.mission.runHistory[0], {
      attempt: 4,
      runId: 'legacy-terminal-run',
      agentId: 'legacy-agent',
      status: 'completed',
      startedAt: '2026-10-16T10:00:00.000Z',
      finishedAt: '2026-10-16T10:01:00.000Z',
    })

    const storedAfter = await getMission(dataDir, mission.id, mission.profile)
    assert.equal(storedAfter.runHistory.filter((entry) => entry.attempt === 4).length, 1)
    assert.equal(storedAfter.runFinishedAt, undefined)
  } finally { await cleanup(dataDir) }
})

test('Legacy-Top-Level-Run ohne Attempt wird hinter History 1..10 als Attempt 11 archiviert und neuer Claim als 12 angelegt', async () => {
  const { dataDir, mission } = await setup()
  try {
    const storePath = path.join(dataDir, 'missions.json')
    const store = JSON.parse(await readFile(storePath, 'utf8'))
    const stored = store.missions[0]
    stored.runHistory = Array.from({ length: 10 }, (_, index) => ({
      attempt: index + 1,
      runId: `history-${index + 1}`,
      status: 'completed',
      startedAt: `2026-10-17T10:${String(index).padStart(2, '0')}:00.000Z`,
      finishedAt: `2026-10-17T10:${String(index).padStart(2, '0')}:30.000Z`,
    }))
    Object.assign(stored, {
      runId: 'legacy-current',
      runStatus: 'completed',
      agentId: 'legacy-agent',
      runStartedAt: '2026-10-17T11:00:00.000Z',
      runFinishedAt: '2026-10-17T11:00:30.000Z',
      idempotencyKey: 'foreign-key-must-be-ignored',
    })
    delete stored.runAttempt
    await writeFile(storePath, JSON.stringify(store))

    const rerun = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'new-agent' })
    assert.equal(rerun.mission.runAttempt, 12)
    assert.deepEqual(rerun.mission.runHistory.map((entry) => entry.attempt), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    assert.deepEqual(rerun.mission.runHistory.find((entry) => entry.attempt === 11), {
      attempt: 11,
      runId: 'legacy-current',
      agentId: 'legacy-agent',
      status: 'completed',
      startedAt: '2026-10-17T11:00:00.000Z',
      finishedAt: '2026-10-17T11:00:30.000Z',
    })
  } finally { await cleanup(dataDir) }
})

test('Legacy-Top-Level-Run mit bereits historischer runId erzeugt keinen doppelten Attempt', async () => {
  const { dataDir, mission } = await setup()
  try {
    const storePath = path.join(dataDir, 'missions.json')
    const store = JSON.parse(await readFile(storePath, 'utf8'))
    const stored = store.missions[0]
    stored.runHistory = Array.from({ length: 10 }, (_, index) => ({ attempt: index + 1, runId: index === 4 ? 'same-run' : `run-${index + 1}`, status: 'completed' }))
    Object.assign(stored, { runId: 'same-run', runStatus: 'completed', agentId: 'legacy-agent' })
    delete stored.runAttempt
    delete stored.idempotencyKey
    await writeFile(storePath, JSON.stringify(store))

    const rerun = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'new-agent' })
    assert.equal(rerun.mission.runAttempt, 11)
    assert.deepEqual(rerun.mission.runHistory.map((entry) => entry.attempt), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    assert.equal(rerun.mission.runHistory.filter((entry) => entry.runId === 'same-run').length, 1)
  } finally { await cleanup(dataDir) }
})

test('Legacy-Top-Level-Run verwendet einen gültigen missionsgebundenen Key als Identität und ignoriert fremde Keys', async () => {
  const { dataDir, mission } = await setup()
  try {
    const storePath = path.join(dataDir, 'missions.json')
    const store = JSON.parse(await readFile(storePath, 'utf8'))
    const stored = store.missions[0]
    stored.runHistory = [{ attempt: 1, status: 'completed' }, { attempt: 10, status: 'completed' }]
    Object.assign(stored, { runStatus: 'completed', agentId: 'legacy-agent', idempotencyKey: `mission:${mission.id}:run:v7` })
    delete stored.runAttempt
    await writeFile(storePath, JSON.stringify(store))
    const validKeyRerun = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'new-agent' })
    assert.equal(validKeyRerun.mission.runAttempt, 11)
    assert.equal(validKeyRerun.mission.runHistory.find((entry) => entry.attempt === 7)?.status, 'completed')

    const foreignMission = await createMission(dataDir, { profile: 'test.yaml', title: 'Foreign key', owner: 'Agent' })
    const secondStore = JSON.parse(await readFile(storePath, 'utf8'))
    const secondStored = secondStore.missions.find((item) => item.id === foreignMission.id)
    Object.assign(secondStored, {
      runHistory: [{ attempt: 1, status: 'completed' }, { attempt: 10, status: 'completed' }],
      runStatus: 'completed',
      agentId: 'legacy-agent',
      idempotencyKey: 'mission:other:run:v99',
    })
    delete secondStored.runAttempt
    await writeFile(storePath, JSON.stringify(secondStore))
    const foreignKeyRerun = await claimMissionRun(dataDir, foreignMission.id, foreignMission.profile, { agentId: 'newer-agent' })
    assert.equal(foreignKeyRerun.mission.runAttempt, 11)
  } finally { await cleanup(dataDir) }
})

test('Recovery mit vorhandenem History-Eintrag persistiert die vollständige Attempt-Identität atomar', async () => {
  const { dataDir, mission } = await setup()
  try {
    const storePath = path.join(dataDir, 'missions.json')
    const store = JSON.parse(await readFile(storePath, 'utf8'))
    const stored = store.missions[0]
    Object.assign(stored, {
      runStatus: 'starting',
      agentId: 'agent-1',
      runStartedAt: '2026-10-17T10:00:00.000Z',
      idempotencyKey: `mission:${mission.id}:run:v7`,
      runHistory: [{ attempt: 7, agentId: 'agent-1', status: 'starting', startedAt: '2026-10-17T10:00:00.000Z' }],
    })
    delete stored.runAttempt
    delete stored.runId
    await writeFile(storePath, JSON.stringify(store))

    const recovered = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent-1' })
    const persisted = await getMission(dataDir, mission.id, mission.profile)
    assert.equal(recovered.recovery, true)
    assert.equal(recovered.mission.runAttempt, 7)
    assert.equal(recovered.mission.idempotencyKey, `mission:${mission.id}:run:v7`)
    assert.deepEqual(recovered.mission.runHistory.map((entry) => entry.attempt), [7])
    assert.equal(persisted.runAttempt, 7)
    assert.equal(persisted.idempotencyKey, recovered.mission.idempotencyKey)
    assert.deepEqual(persisted.runHistory, recovered.mission.runHistory)
  } finally { await cleanup(dataDir) }
})

test('Recovery verwendet bei widersprüchlicher History deterministisch den missionsgebundenen Key', async () => {
  const { dataDir, mission } = await setup()
  try {
    const storePath = path.join(dataDir, 'missions.json')
    const store = JSON.parse(await readFile(storePath, 'utf8'))
    const stored = store.missions[0]
    Object.assign(stored, {
      runStatus: 'starting',
      agentId: 'agent-1',
      idempotencyKey: `mission:${mission.id}:run:v7`,
      runHistory: [{ attempt: 5, agentId: 'agent-1', status: 'starting' }],
    })
    delete stored.runAttempt
    delete stored.runId
    await writeFile(storePath, JSON.stringify(store))

    const recovered = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent-1' })
    assert.equal(recovered.mission.runAttempt, 7)
    assert.equal(recovered.mission.idempotencyKey, `mission:${mission.id}:run:v7`)
    assert.deepEqual(recovered.mission.runHistory.map((entry) => entry.attempt), [5, 7])
  } finally { await cleanup(dataDir) }
})

test('Recovery nimmt die höchste sichere Grenze aus Top-Level, Key und History und verwendet keinen Recovery-Key doppelt', async () => {
  const { dataDir, mission } = await setup()
  try {
    const storePath = path.join(dataDir, 'missions.json')
    const store = JSON.parse(await readFile(storePath, 'utf8'))
    const stored = store.missions[0]
    Object.assign(stored, {
      runAttempt: 3,
      runStatus: 'starting',
      agentId: 'stale-agent',
      runStartedAt: '2026-10-17T09:00:00.000Z',
      idempotencyKey: `mission:${mission.id}:run:v3`,
      runHistory: [{
        attempt: 4,
        agentId: 'History-Agent',
        status: 'starting',
        startedAt: '2026-10-17T10:00:00.000Z',
      }],
    })
    delete stored.runId
    await writeFile(storePath, JSON.stringify(store))

    const firstRecovery = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'ignored' })
    const repeatedRecovery = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'ignored-again' })
    assert.equal(firstRecovery.recovery, true)
    assert.equal(repeatedRecovery.recovery, true)
    for (const recovered of [firstRecovery, repeatedRecovery]) {
      assert.equal(recovered.mission.runAttempt, 4)
      assert.equal(recovered.mission.idempotencyKey, `mission:${mission.id}:run:v4`)
      assert.equal(recovered.mission.agentId, 'History-Agent')
      assert.equal(recovered.mission.runStartedAt, '2026-10-17T10:00:00.000Z')
      assert.deepEqual(recovered.mission.runHistory, [{
        attempt: 4,
        agentId: 'History-Agent',
        status: 'starting',
        startedAt: '2026-10-17T10:00:00.000Z',
      }])
    }

    const terminal = await attachMissionRun(dataDir, mission.id, mission.profile, {
      runId: 'run-4',
      runStatus: 'completed',
    }, { expectedRunAttempt: 4 })
    assert.equal(terminal.runAttempt, 4)
    const rerun = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'new-agent' })
    assert.equal(rerun.replayed, false)
    assert.equal(rerun.mission.runAttempt, 5)
    assert.equal(rerun.mission.idempotencyKey, `mission:${mission.id}:run:v5`)
  } finally { await cleanup(dataDir) }
})

test('Neuer Claim löscht den alten Top-Level-Abschlusszeitpunkt', async () => {
  const { dataDir, mission } = await setup()
  try {
    const first = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent-1' })
    await attachMissionRun(dataDir, mission.id, mission.profile, { runId: 'old', runStatus: 'completed', runFinishedAt: '2026-10-17T10:00:00.000Z' }, { expectedRunAttempt: first.mission.runAttempt })
    const second = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent-2' })
    assert.equal(second.mission.runFinishedAt, undefined)
  } finally { await cleanup(dataDir) }
})

test('Terminales Attach ohne runFinishedAt erzeugt genau einen gemeinsamen Abschlusszeitpunkt', async () => {
  const { dataDir, mission } = await setup()
  try {
    const claim = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent-1' })
    const first = await attachMissionRun(dataDir, mission.id, mission.profile, { runId: 'run-1', runStatus: 'completed' }, { expectedRunAttempt: claim.mission.runAttempt })
    const second = await attachMissionRun(dataDir, mission.id, mission.profile, { runStatus: 'completed' }, { expectedRunAttempt: claim.mission.runAttempt, expectedRunId: 'run-1' })
    assert.match(first.runFinishedAt, /^2026-/)
    assert.equal(first.runFinishedAt, first.runHistory[0].finishedAt)
    assert.equal(second.runFinishedAt, first.runFinishedAt)
    assert.equal(second.runHistory[0].finishedAt, first.runFinishedAt)
  } finally { await cleanup(dataDir) }
})

test('Stale oder gefencetes Terminal-Attach ändert weder History noch mission.runFinishedAt', async () => {
  const { dataDir, mission } = await setup()
  try {
    const first = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent-1' })
    await attachMissionRun(dataDir, mission.id, mission.profile, { runId: 'old', runStatus: 'completed', runFinishedAt: '2026-10-17T10:00:00.000Z' }, { expectedRunAttempt: first.mission.runAttempt })
    const second = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent-2' })
    const before = JSON.stringify(second.mission)
    const stale = await attachMissionRun(dataDir, mission.id, mission.profile, { runStatus: 'completed' }, { expectedRunAttempt: first.mission.runAttempt, expectedRunId: 'old' })
    assert.equal(JSON.stringify(stale), before)
  } finally { await cleanup(dataDir) }
})

test('Nichtterminaler neuer Run trägt niemals den alten Abschlusszeitpunkt', async () => {
  const { dataDir, mission } = await setup()
  try {
    const first = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent-1' })
    await attachMissionRun(dataDir, mission.id, mission.profile, { runId: 'old', runStatus: 'completed', runFinishedAt: '2026-10-17T10:00:00.000Z' }, { expectedRunAttempt: first.mission.runAttempt })
    const second = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent-2' })
    assert.equal(second.mission.runStatus, 'starting')
    assert.equal(second.mission.runFinishedAt, undefined)
  } finally { await cleanup(dataDir) }
})

test('Veralteter Top-Level-Attempt verwirft keine höhere sichere History und der nächste Claim bleibt monoton', async () => {
  const { dataDir, mission } = await setup()
  try {
    const storePath = path.join(dataDir, 'missions.json')
    const store = JSON.parse(await readFile(storePath, 'utf8'))
    Object.assign(store.missions[0], {
      runAttempt: 3,
      runStatus: 'completed',
      runHistory: [
        { attempt: 4, runId: 'history-4', status: 'completed' },
      ],
      idempotencyKey: `mission:${mission.id}:run:v3`,
    })
    await writeFile(storePath, JSON.stringify(store))

    const claimed = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent-5' })
    assert.equal(claimed.mission.runAttempt, 5)
    assert.deepEqual(claimed.mission.runHistory.map((entry) => entry.attempt), [3, 4, 5])
  } finally { await cleanup(dataDir) }
})

test('Aktueller History-Eintrag ist bei Top-Level-Konflikt autoritativ und erlaubt danach einen sauberen Rerun', async () => {
  for (const order of ['top-level-first', 'history-first']) {
    const { dataDir, mission } = await setup()
    try {
      const storePath = path.join(dataDir, 'missions.json')
      const store = JSON.parse(await readFile(storePath, 'utf8'))
      const stored = store.missions[0]
      const fields = order === 'top-level-first'
        ? { runAttempt: 4, runStatus: 'running', runHistory: [{ attempt: 4, status: 'failed' }] }
        : { runHistory: [{ attempt: 4, status: 'failed' }], runAttempt: 4, runStatus: 'running' }
      Object.assign(stored, fields)
      await writeFile(storePath, JSON.stringify(store))

      const reconciled = await getMission(dataDir, mission.id, mission.profile)
      assert.equal(reconciled.runStatus, 'failed')
      assert.equal(reconciled.runError, 'peer_run_failed')
      const rerun = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent-5' })
      assert.equal(rerun.replayed, false)
      assert.equal(rerun.mission.runAttempt, 5)
    } finally { await cleanup(dataDir) }
  }
})

test('Konfliktterminalisierung persistiert einen gemeinsamen Abschlusszeitpunkt und bleibt unveränderlich', async () => {
  const { dataDir, mission } = await setup()
  try {
    const first = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent-a' })
    await attachMissionRun(dataDir, mission.id, mission.profile, { runId: 'same-run', runStatus: 'completed' }, { expectedRunAttempt: first.mission.runAttempt })

    const second = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent-b' })
    const conflictResult = await attachMissionRun(dataDir, mission.id, mission.profile, { runId: 'same-run', runStatus: 'running' }, { expectedRunAttempt: second.mission.runAttempt })
    const entry = conflictResult.runHistory.find((item) => item.attempt === second.mission.runAttempt)
    assert.equal(conflictResult.runStatus, 'failed')
    assert.match(conflictResult.runFinishedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(entry.finishedAt, conflictResult.runFinishedAt)
    const finishedAt = conflictResult.runFinishedAt
    const stale = await attachMissionRun(dataDir, mission.id, mission.profile, { runStatus: 'failed', runFinishedAt: '2026-10-17T23:59:59.000Z' }, { expectedRunAttempt: second.mission.runAttempt })
    assert.equal(stale.runFinishedAt, finishedAt)
    assert.equal(stale.runHistory.find((item) => item.attempt === second.mission.runAttempt).finishedAt, finishedAt)
  } finally { await cleanup(dataDir) }
})

test('History-Normalisierung dedupliziert, filtert sicher und behält die 25 höchsten Attempts', () => {
  const entries = [
    { attempt: 30, status: 'completed' },
    { attempt: 2, status: 'failed', credential: 'secret' },
    ...Array.from({ length: 28 }, (_, index) => ({ attempt: index + 1, status: 'completed' })),
    { attempt: 30, status: 'failed', arbitrarySecret: 'secret' },
    { attempt: 0, status: 'completed' },
  ]
  const result = normalizeMissionResponse({ missions: [{ id: 'm', runAttempt: 30, runHistory: entries }] })
  const history = result.missions[0].runHistory
  assert.equal(history.length, 25)
  assert.deepEqual(history.map((entry) => entry.attempt), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 30])
  assert.equal(history.at(-1).status, 'failed')
  assert.equal(JSON.stringify(history).includes('secret'), false)
  assert.deepEqual(missionHistoryForDisplay(result.missions[0]).map((entry) => entry.attempt), [30, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5])
})
test('History wird auf 25 Einträge begrenzt und nach Attempt sortiert', async () => {
  const { dataDir, mission } = await setup()
  try {
    const storePath = path.join(dataDir, 'missions.json')
    const store = JSON.parse(await readFile(storePath, 'utf8'))
    store.missions[0].runHistory = Array.from({ length: 30 }, (_, index) => ({ attempt: index + 1, status: 'completed' }))
    await writeFile(storePath, JSON.stringify(store))
    const claim = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent' })
    assert.equal(claim.mission.runHistory.length, 25)
    assert.deepEqual(claim.mission.runHistory.map((entry) => entry.attempt), [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31])
  } finally { await cleanup(dataDir) }
})

test('Cross-Attempt-Race verändert weder Top-Level noch neue History', async () => {
  const { dataDir, mission } = await setup()
  try {
    const first = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent-1' })
    await attachMissionRun(dataDir, mission.id, mission.profile, { runId: 'old', runStatus: 'completed' }, { expectedRunAttempt: first.mission.runAttempt })
    const second = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent-2' })
    const stale = await attachMissionRun(dataDir, mission.id, mission.profile, { runId: 'old', runStatus: 'failed' }, { expectedRunAttempt: first.mission.runAttempt })
    assert.equal(stale.runAttempt, second.mission.runAttempt)
    assert.equal(stale.runId, undefined)
    assert.equal(stale.runHistory.find((entry) => entry.attempt === 2).status, 'starting')
  } finally { await cleanup(dataDir) }
})

test('History-Normalisierung behält bei doppelter runId fail-closed nur den höchsten Attempt', () => {
  const result = normalizeMissionResponse({ missions: [{
    id: 'm',
    runAttempt: 9,
    runHistory: [
      { attempt: 3, runId: 'same-run', status: 'completed' },
      { attempt: 9, runId: 'same-run', status: 'starting' },
      { attempt: 8, runId: 'other-run', status: 'completed' },
    ],
  }] })
  assert.deepEqual(result.missions[0].runHistory, [
    { attempt: 8, runId: 'other-run', status: 'completed' },
    { attempt: 9, runId: 'same-run', status: 'starting' },
  ])
})

test('Nichtterminaler Attach ignoriert runFinishedAt in History und Top-Level', async () => {
  const { dataDir, mission } = await setup()
  try {
    const claim = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent-1' })
    const updated = await attachMissionRun(dataDir, mission.id, mission.profile, {
      runId: 'run-1', runStatus: 'running', runFinishedAt: '2026-10-17T10:00:00.000Z',
    }, { expectedRunAttempt: claim.mission.runAttempt })
    assert.equal(updated.runFinishedAt, undefined)
    assert.equal(updated.runHistory[0].finishedAt, undefined)
  } finally { await cleanup(dataDir) }
})

test('Terminaler Attach synchronisiert runFinishedAt einmalig und ignoriert spätere Werte', async () => {
  const { dataDir, mission } = await setup()
  try {
    const claim = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent-1' })
    const first = await attachMissionRun(dataDir, mission.id, mission.profile, {
      runId: 'run-1', runStatus: 'completed', runFinishedAt: '2026-10-17T10:00:00.000Z',
    }, { expectedRunAttempt: claim.mission.runAttempt })
    const second = await attachMissionRun(dataDir, mission.id, mission.profile, {
      runStatus: 'completed', runFinishedAt: '2026-10-17T11:00:00.000Z',
    }, { expectedRunAttempt: claim.mission.runAttempt, expectedRunId: 'run-1' })
    assert.equal(first.runFinishedAt, '2026-10-17T10:00:00.000Z')
    assert.equal(second.runFinishedAt, first.runFinishedAt)
    assert.equal(second.runHistory[0].finishedAt, first.runFinishedAt)
  } finally { await cleanup(dataDir) }
})

test('Recovery eines starting-Versuchs ohne Key ergänzt denselben Attempt und dieselbe History-Zeile', async () => {
  const { dataDir, mission } = await setup()
  try {
    const storePath = path.join(dataDir, 'missions.json')
    const store = JSON.parse(await readFile(storePath, 'utf8'))
    const stored = store.missions[0]
    Object.assign(stored, {
      runAttempt: 3,
      runStatus: 'starting',
      agentId: 'agent-1',
      runStartedAt: '2026-10-17T10:00:00.000Z',
      runHistory: [{ attempt: 3, agentId: 'agent-1', status: 'starting', startedAt: '2026-10-17T10:00:00.000Z' }],
    })
    delete stored.runId
    delete stored.idempotencyKey
    await writeFile(storePath, JSON.stringify(store))

    const recovered = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'ignored' })
    assert.equal(recovered.recovery, true)
    assert.equal(recovered.mission.runAttempt, 3)
    assert.equal(recovered.mission.idempotencyKey, `mission:${mission.id}:run:v3`)
    assert.deepEqual(recovered.mission.runHistory, [{ attempt: 3, agentId: 'agent-1', status: 'starting', startedAt: '2026-10-17T10:00:00.000Z' }])
  } finally { await cleanup(dataDir) }
})

test('Runtime normalisiert Backend-History auf sichere Felder und sortierte Anzeige', () => {
  const result = normalizeMissionResponse({ missions: [{ id: 'm', runHistory: [{ attempt: 2, status: 'completed', prompt: 'x' }, { attempt: 1, agentId: 'a', status: 'starting' }] }] })
  assert.deepEqual(result.missions[0].runHistory, [{ attempt: 1, agentId: 'a', status: 'starting' }, { attempt: 2, status: 'completed' }])
  assert.deepEqual(missionHistoryForDisplay(result.missions[0]).map((entry) => entry.attempt), [2, 1])
  assert.deepEqual(Object.keys(result.missions[0].runHistory[1]), ['attempt', 'status'])
  assert.equal(new Set(safeKeys).size, 6)
})

test('gleiche sanitizte History-Einträge werden dedupliziert und Konflikte reihenfolgeunabhängig fail-closed markiert', () => {
  const first = normalizeMissionResponse({ missions: [{ id: 'm', runHistory: [
    { attempt: 4, status: 'starting', agentId: 'agent-a', credential: 'secret-a' },
    { attempt: 4, status: 'running', agentId: 'agent-a', peerOutput: 'secret-b' },
    { attempt: 7, status: 'completed' },
  ] }] })
  const reversed = normalizeMissionResponse({ missions: [{ id: 'm', runHistory: [
    { attempt: 7, status: 'completed' },
    { attempt: 4, peerOutput: 'secret-b', agentId: 'agent-a', status: 'running' },
    { attempt: 4, credential: 'secret-a', agentId: 'agent-a', status: 'starting' },
  ] }] })
  assert.deepEqual(first, reversed)
  assert.deepEqual(first.missions[0].runHistory, [
    { attempt: 4, status: 'failed' },
    { attempt: 7, status: 'completed' },
  ])
})

test('Recovery gleicht terminalen und laufenden History-Zustand atomar an, bleibt replay-only und erlaubt danach einen neuen Rerun', async () => {
  for (const historyEntry of [
    { attempt: 4, agentId: 'history-agent', runId: 'history-run', status: 'running', startedAt: '2026-10-17T10:00:00.000Z' },
    { attempt: 4, agentId: 'history-agent', runId: 'history-run', status: 'completed', startedAt: '2026-10-17T10:00:00.000Z', finishedAt: '2026-10-17T10:01:00.000Z' },
    { attempt: 4, agentId: 'history-agent', status: 'failed' },
  ]) {
    const { dataDir, mission } = await setup()
    try {
      const storePath = path.join(dataDir, 'missions.json')
      const store = JSON.parse(await readFile(storePath, 'utf8'))
      Object.assign(store.missions[0], {
        runAttempt: 4,
        runStatus: 'starting',
        agentId: 'top-level-agent',
        runStartedAt: '2026-10-17T09:00:00.000Z',
        idempotencyKey: `mission:${mission.id}:run:v4`,
        runHistory: [historyEntry],
      })
      delete store.missions[0].runId
      await writeFile(storePath, JSON.stringify(store))

      const recovered = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'ignored' })
      if (historyEntry.status === 'running') {
        assert.equal(recovered.replayed, true)
        assert.equal(recovered.mission.runAttempt, 4)
        assert.equal(recovered.mission.runId, historyEntry.runId)
        assert.equal(recovered.mission.runStatus, historyEntry.status)
      } else {
        assert.equal(recovered.replayed, false)
        assert.equal(recovered.mission.runAttempt, 5)
      }
      assert.equal(recovered.mission.idempotencyKey, `mission:${mission.id}:run:v${recovered.mission.runAttempt}`)
      if (historyEntry.status === 'running') {
        assert.equal(recovered.mission.agentId, historyEntry.agentId)
        assert.equal(recovered.mission.runStartedAt, historyEntry.startedAt)
        assert.equal(recovered.mission.runFinishedAt, historyEntry.finishedAt)
        assert.equal(recovered.mission.runError, undefined)
      }

      const rerun = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'new-agent' })
      if (historyEntry.status === 'completed' || historyEntry.status === 'failed') {
        assert.equal(rerun.replayed, true)
        assert.equal(rerun.mission.runAttempt, 5)
      } else {
        assert.equal(rerun.replayed, true)
        assert.equal(rerun.mission.runAttempt, 4)
      }
    } finally { await cleanup(dataDir) }
  }
})

test('Legacy-Terminal-Run ohne runId, Attempt und Key wird als Attempt 1 zurückgeholt und der neuen Claim folgt als 2', async () => {
  const { dataDir, mission } = await setup()
  try {
    const storePath = path.join(dataDir, 'missions.json')
    const store = JSON.parse(await readFile(storePath, 'utf8'))
    Object.assign(store.missions[0], {
      runStatus: 'completed',
      agentId: 'legacy-agent',
      runStartedAt: '2026-10-16T10:00:00.000Z',
      runFinishedAt: '2026-10-16T10:01:00.000Z',
    })
    delete store.missions[0].runAttempt
    delete store.missions[0].runId
    delete store.missions[0].idempotencyKey
    delete store.missions[0].runHistory
    await writeFile(storePath, JSON.stringify(store))

    const rerun = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'new-agent' })
    assert.equal(rerun.mission.runAttempt, 2)
    assert.deepEqual(rerun.mission.runHistory.map((entry) => entry.attempt), [1, 2])
    assert.deepEqual(rerun.mission.runHistory[0], {
      attempt: 1,
      agentId: 'legacy-agent',
      status: 'completed',
      startedAt: '2026-10-16T10:00:00.000Z',
      finishedAt: '2026-10-16T10:01:00.000Z',
    })
    assert.equal(rerun.mission.runHistory[1].status, 'starting')
    assert.equal(rerun.mission.runFinishedAt, undefined)
    assert.equal(rerun.mission.idempotencyKey, `mission:${mission.id}:run:v2`)
  } finally { await cleanup(dataDir) }
})

test('Recovery mit fehlender History erzeugt genau eine sichere starting-Zeile und bleibt ausführbar', async () => {
  const { dataDir, mission } = await setup()
  try {
    const storePath = path.join(dataDir, 'missions.json')
    const store = JSON.parse(await readFile(storePath, 'utf8'))
    Object.assign(store.missions[0], {
      runAttempt: 4,
      runStatus: 'starting',
      agentId: 'top-level-agent',
      runStartedAt: '2026-10-17T09:00:00.000Z',
      idempotencyKey: `mission:${mission.id}:run:v4`,
    })
    delete store.missions[0].runId
    delete store.missions[0].runHistory
    await writeFile(storePath, JSON.stringify(store))
    const recovered = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'ignored' })
    assert.equal(recovered.recovery, true)
    assert.deepEqual(recovered.mission.runHistory, [{
      attempt: 4,
      agentId: 'top-level-agent',
      status: 'starting',
      startedAt: '2026-10-17T09:00:00.000Z',
    }])
  } finally { await cleanup(dataDir) }
})
