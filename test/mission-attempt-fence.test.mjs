import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { attachMissionRun, claimMissionRun, createMission } from '../server/mission-storage.mjs'

async function setupMission() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mission-attempt-fence-'))
  await mkdir(path.join(dataDir, 'profiles'))
  const mission = await createMission(dataDir, {
    profile: 'test.yaml',
    title: 'Fence test',
    owner: 'Agent',
  })
  const first = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent' })
  await attachMissionRun(dataDir, mission.id, mission.profile, {
    runId: 'old-run',
    runStatus: 'completed',
  }, { expectedRunAttempt: first.mission.runAttempt })
  const second = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent' })
  return { dataDir, mission: second.mission, oldAttempt: first.mission.runAttempt }
}

async function cleanup(dataDir) {
  await rm(dataDir, { recursive: true, force: true })
}

test('verspätete alte Startantwort schreibt keine alte runId nach neuem Claim', async () => {
  const { dataDir, mission, oldAttempt } = await setupMission()
  try {
    const current = await attachMissionRun(dataDir, mission.id, mission.profile, {
      runId: 'new-run',
      runStatus: 'running',
    }, { expectedRunAttempt: mission.runAttempt })
    const stale = await attachMissionRun(dataDir, mission.id, mission.profile, {
      runId: 'old-run',
      runStatus: 'running',
    }, { expectedRunAttempt: oldAttempt })

    assert.equal(current.runId, 'new-run')
    assert.equal(stale.runId, 'new-run')
    assert.equal(stale.runAttempt, mission.runAttempt)
  } finally {
    await cleanup(dataDir)
  }
})

test('historisch verwendete runId darf nicht an neuen Attempt gebunden werden und scheitert generisch', async () => {
  const { dataDir, mission, oldAttempt } = await setupMission()
  try {
    await attachMissionRun(dataDir, mission.id, mission.profile, { runId: 'same-run', runStatus: 'completed' }, { expectedRunAttempt: mission.runAttempt })
    const second = await claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent' })
    const rejected = await attachMissionRun(dataDir, mission.id, mission.profile, {
      runId: 'same-run', runStatus: 'running',
    }, { expectedRunAttempt: second.mission.runAttempt })
    assert.equal(rejected.runStatus, 'failed')
    assert.equal(rejected.runError, 'peer_run_failed')
    assert.equal(rejected.runId, undefined)
    assert.equal(rejected.runHistory.filter((entry) => entry.runId === 'same-run').length, 1)
    assert.equal(rejected.runHistory.find((entry) => entry.attempt === oldAttempt).status, 'completed')
  } finally {
    await cleanup(dataDir)
  }
})

test('andere runId für denselben Attempt liefert den bestätigten Stand unverändert zurück', async () => {
  const { dataDir, mission } = await setupMission()
  try {
    const current = await attachMissionRun(dataDir, mission.id, mission.profile, {
      runId: 'confirmed-run', runStatus: 'running', agentId: 'agent',
    }, { expectedRunAttempt: mission.runAttempt })
    const before = JSON.stringify(current)
    const stale = await attachMissionRun(dataDir, mission.id, mission.profile, {
      runId: 'different-run', runStatus: 'completed', agentId: 'other-agent',
    }, { expectedRunAttempt: mission.runAttempt })

    assert.deepEqual(stale, JSON.parse(before))
  } finally {
    await cleanup(dataDir)
  }
})

test('Run-Status bleibt pro Attempt monoton und terminal unveränderlich', async () => {
  const { dataDir, mission } = await setupMission()
  try {
    await attachMissionRun(dataDir, mission.id, mission.profile, { runId: 'monotonic-run', runStatus: 'running' }, { expectedRunAttempt: mission.runAttempt })
    const starting = await attachMissionRun(dataDir, mission.id, mission.profile, { runId: 'monotonic-run', runStatus: 'starting' }, { expectedRunAttempt: mission.runAttempt })
    assert.equal(starting.runStatus, 'running')

    const completed = await attachMissionRun(dataDir, mission.id, mission.profile, { runId: 'monotonic-run', runStatus: 'completed' }, { expectedRunAttempt: mission.runAttempt })
    const staleTerminal = await attachMissionRun(dataDir, mission.id, mission.profile, { runId: 'monotonic-run', runStatus: 'failed', runError: 'peer_run_failed' }, { expectedRunAttempt: mission.runAttempt })
    assert.equal(completed.runStatus, 'completed')
    assert.deepEqual(staleTerminal, completed)
  } finally {
    await cleanup(dataDir)
  }
})

test('Claim verweigert bei geändertem Owner ohne Mutation', async () => {
  const { dataDir, mission } = await setupMission()
  try {
    const before = await import('node:fs/promises').then(({ readFile }) => readFile(`${dataDir}/missions.json`, 'utf8'))
    await assert.rejects(
      claimMissionRun(dataDir, mission.id, mission.profile, { agentId: 'agent', expectedOwner: 'Andere' }),
      (error) => error?.code === 'mission_changed',
    )
    const after = await import('node:fs/promises').then(({ readFile }) => readFile(`${dataDir}/missions.json`, 'utf8'))
    assert.equal(after, before)
  } finally {
    await cleanup(dataDir)
  }
})

test('Status- und Stop-Attach mit expectedRunId bleiben für denselben Attempt erlaubt', async () => {
  const { dataDir, mission } = await setupMission()
  try {
    const current = await attachMissionRun(dataDir, mission.id, mission.profile, { runId: 'same-run', runStatus: 'running' }, { expectedRunAttempt: mission.runAttempt })
    const updated = await attachMissionRun(dataDir, mission.id, mission.profile, { runStatus: 'completed' }, { expectedRunAttempt: mission.runAttempt, expectedRunId: 'same-run' })
    assert.equal(updated.runId, current.runId)
    assert.equal(updated.runStatus, 'completed')
  } finally {
    await cleanup(dataDir)
  }
})

test('verspäteter alter Status-Poll terminalisiert den neuen Versuch nicht', async () => {
  const { dataDir, mission, oldAttempt } = await setupMission()
  try {
    const current = await attachMissionRun(dataDir, mission.id, mission.profile, {
      runId: 'new-run',
      runStatus: 'running',
    }, { expectedRunAttempt: mission.runAttempt })
    const stale = await attachMissionRun(dataDir, mission.id, mission.profile, {
      runStatus: 'completed',
    }, { expectedRunAttempt: oldAttempt, expectedRunId: 'old-run' })

    assert.equal(current.runStatus, 'running')
    assert.equal(stale.runStatus, 'running')
    assert.equal(stale.runId, 'new-run')
  } finally {
    await cleanup(dataDir)
  }
})

test('verspätete alte Stop-Antwort und alter Startfehler setzen neuen Versuch nicht terminal', async () => {
  const { dataDir, mission, oldAttempt } = await setupMission()
  try {
    const current = await attachMissionRun(dataDir, mission.id, mission.profile, {
      runId: 'new-run',
      runStatus: 'running',
    }, { expectedRunAttempt: mission.runAttempt })
    const staleStop = await attachMissionRun(dataDir, mission.id, mission.profile, {
      runStatus: 'cancelled',
    }, { expectedRunAttempt: oldAttempt, expectedRunId: 'old-run' })
    const staleStartError = await attachMissionRun(dataDir, mission.id, mission.profile, {
      runStatus: 'failed',
      runError: 'peer_run_failed',
    }, { expectedRunAttempt: oldAttempt })

    assert.equal(current.runStatus, 'running')
    assert.equal(staleStop.runStatus, 'running')
    assert.equal(staleStartError.runStatus, 'running')
    assert.equal(staleStartError.runId, 'new-run')
  } finally {
    await cleanup(dataDir)
  }
})
