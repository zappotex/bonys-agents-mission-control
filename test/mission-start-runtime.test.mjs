import assert from 'node:assert/strict'
import test from 'node:test'
import { createMissionRunStarter } from '../server/mission-start-runtime.mjs'

test('in-flight Start koalesziert parallele Requests zu genau einer Operation', async () => {
  let claims = 0
  let posts = 0
  let release
  const blocked = new Promise((resolve) => { release = resolve })
  const starter = createMissionRunStarter({
    claim: async () => { claims += 1; return { mission: { runAttempt: 4, idempotencyKey: 'mission:m:run:v4' }, replayed: false } },
    execute: async ({ claim }) => {
      posts += 1
      await blocked
      return claim.mission
    },
  })

  const first = starter({ profile: 'p', missionId: 'm', agentId: 'a' })
  const second = starter({ profile: 'p', missionId: 'm', agentId: 'a' })
  await Promise.resolve()
  assert.equal(claims, 1)
  assert.equal(posts, 1)
  release()
  assert.strictEqual(await first, await second)
})

test('persistierter starting-Claim ohne runId wird als Recovery ausführbar, running bleibt replay-only', async () => {
  const executions = []
  const starter = createMissionRunStarter({
    claim: async () => ({ mission: { runAttempt: 2, runStatus: 'starting', idempotencyKey: 'mission:m:run:v2' }, replayed: true, recovery: true }),
    execute: async ({ claim }) => { executions.push(claim.mission.idempotencyKey); return claim.mission },
  })
  await starter({ profile: 'p', missionId: 'm', agentId: 'a' })
  assert.deepEqual(executions, ['mission:m:run:v2'])

  const replayOnly = createMissionRunStarter({
    claim: async () => ({ mission: { runAttempt: 2, runStatus: 'running', runId: 'remote-2' }, replayed: true }),
    execute: async () => { throw new Error('must not execute') },
  })
  const result = await replayOnly({ profile: 'p', missionId: 'm', agentId: 'a' })
  assert.equal(result.replayed, true)
})

test('Recovery aus running, terminalem und Konfliktmarker bleibt replay-only und sendet keinen Peer-Request', async () => {
  for (const mission of [
    { runAttempt: 4, runStatus: 'running', runId: 'run-4' },
    { runAttempt: 4, runStatus: 'completed', runId: 'run-4', runFinishedAt: '2026-10-17T10:01:00.000Z' },
    { runAttempt: 4, runStatus: 'failed', runError: 'peer_run_failed' },
  ]) {
    let peerRequests = 0
    const starter = createMissionRunStarter({
      claim: async () => ({ mission, replayed: true }),
      execute: async () => { peerRequests += 1 },
    })
    const result = await starter({ profile: 'p', missionId: 'm', agentId: 'a' })
    assert.equal(result.replayed, true)
    assert.equal(peerRequests, 0)
  }
})
