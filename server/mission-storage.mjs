import { constants } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { openVerifiedDataDirectory } from './verified-profile-directories.mjs'

const storageFile = 'missions.json'
const maxStorageBytes = 1024 * 1024
const validStates = new Set(['planned', 'running', 'review', 'done'])
const validResultKinds = new Set(['note', 'link', 'file'])
const terminalRunStatuses = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const validRunStatuses = new Set(['starting', 'running', ...terminalRunStatuses])
const maxRunHistoryEntries = 25
let writeQueue = Promise.resolve()

export async function listMissions(dataDir, profile) {
  if (!dataDir) return []
  const store = await readStore(dataDir)
  return store.missions.filter((mission) => mission.profile === profile)
}

export async function getMission(dataDir, id, profile) {
  const store = await readStore(dataDir)
  return store.missions.find((mission) => mission.id === id && mission.profile === profile)
}

export async function createMission(dataDir, input) {
  return withWriteLock(async () => {
    const store = await readStore(dataDir)
    const now = new Date().toISOString()
    const mission = {
      id: `mission-${randomUUID()}`,
      profile: requiredText(input.profile, 128),
      title: requiredText(input.title, 160),
      description: optionalText(input.description, 2000),
      ...(optionalText(input.result, 4000) ? {
        result: optionalText(input.result, 4000),
        resultKind: validResultKinds.has(input.resultKind) ? input.resultKind : 'note',
      } : {}),
      owner: requiredText(input.owner, 80),
      state: validStates.has(input.state) ? input.state : 'planned',
      createdAt: now,
      updatedAt: now,
    }
    store.missions.push(mission)
    await writeStore(dataDir, store)
    return mission
  })
}

export async function claimMissionRun(dataDir, id, profile, run) {
  return withWriteLock(async () => {
    const store = await readStore(dataDir)
    const mission = store.missions.find((item) => item.id === id && item.profile === profile)
    if (!mission) return undefined
    if (run.expectedOwner !== undefined && mission.owner !== run.expectedOwner) throw missionChangedError()
    const history = normalizeRunHistory(mission.runHistory)
    if (mission.runStatus === 'starting' && !mission.runId) {
      const historyAttempt = Math.max(
        normalizeRunAttempt(mission.runAttempt),
        missionRunKeyVersion(mission.idempotencyKey, id) || 0,
        history.reduce((highest, entry) => Math.max(highest, entry.attempt), 0),
      )
      if (historyAttempt > 0) {
        const recoveredKey = missionRunKeyVersion(mission.idempotencyKey, id) === historyAttempt
          ? mission.idempotencyKey
          : `mission:${id}:run:v${historyAttempt}`
        const historyEntry = history.find((entry) => entry.attempt === historyAttempt)
        mission.runAttempt = historyAttempt
        mission.idempotencyKey = recoveredKey
        if (!historyEntry) {
          history.push({
            attempt: historyAttempt,
            ...(typeof mission.agentId === 'string' ? { agentId: mission.agentId } : {}),
            status: 'starting',
            ...(normalizeTimestamp(mission.runStartedAt) ? { startedAt: normalizeTimestamp(mission.runStartedAt) } : {}),
          })
          mission.runHistory = limitRunHistory(history)
          mission.updatedAt = new Date(Math.max(Date.now(), Date.parse(mission.updatedAt) + 1)).toISOString()
          await writeStore(dataDir, store)
          return { mission, replayed: true, recovery: true }
        }
        const recoverable = historyEntry.status === 'starting' && !historyEntry.runId
        synchronizeTopLevelRun(mission, historyEntry)
        mission.runHistory = limitRunHistory(history)
        mission.updatedAt = new Date(Math.max(Date.now(), Date.parse(mission.updatedAt) + 1)).toISOString()
        await writeStore(dataDir, store)
        return recoverable
          ? { mission, replayed: true, recovery: true }
          : { mission, replayed: true }
      }
    }
    if (['starting', 'running'].includes(mission.runStatus) || (mission.runId && !isTerminalRunStatus(mission.runStatus))) {
      return { mission, replayed: true }
    }
    const now = new Date().toISOString()
    const runAttempt = nextRunAttempt(mission, id, history)
    const previous = snapshotTopLevelRun(mission, id, history)
    if (previous && !history.some((entry) => entry.attempt === previous.attempt)) history.push(previous)
    const agentId = requiredText(run.agentId, 128)
    history.push({ attempt: runAttempt, agentId, status: 'starting', startedAt: now })
    mission.runHistory = limitRunHistory(history)
    mission.runAttempt = runAttempt
    delete mission.runId
    delete mission.runError
    delete mission.runFinishedAt
    mission.agentId = agentId
    mission.runStatus = 'starting'
    mission.runStartedAt = now
    mission.idempotencyKey = `mission:${id}:run:v${runAttempt}`
    mission.updatedAt = new Date(Math.max(Date.now(), Date.parse(mission.updatedAt) + 1)).toISOString()
    await writeStore(dataDir, store)
    return { mission, replayed: false }
  })
}

export async function attachMissionRun(dataDir, id, profile, run, fence = {}) {
  return withWriteLock(async () => {
    const store = await readStore(dataDir)
    const mission = store.missions.find((item) => item.id === id && item.profile === profile)
    if (!mission) return undefined
    if (fence.expectedRunAttempt !== undefined && mission.runAttempt !== fence.expectedRunAttempt) return mission
    if (fence.expectedRunId !== undefined && mission.runId !== fence.expectedRunId) return mission
    if (isTerminalRunStatus(mission.runStatus) && run.runStatus !== undefined && run.runStatus !== mission.runStatus) return mission
    const entry = normalizeRunHistory(mission.runHistory).find((item) => item.attempt === mission.runAttempt)
    if (!entry || !Number.isSafeInteger(mission.runAttempt) || mission.runAttempt < 1) return mission
    const incomingRunId = run.runId === undefined ? undefined : requiredText(run.runId, 256)
    if (entry.runId && incomingRunId && entry.runId !== incomingRunId) return mission
    if (!entry.runId && incomingRunId && normalizeRunHistory(mission.runHistory).some((item) => item.runId === incomingRunId && item.attempt !== mission.runAttempt)) {
      markRunConflict(mission, entry)
      await writeStore(dataDir, store)
      return mission
    }
    if (incomingRunId) entry.runId = incomingRunId

    const incomingStatus = run.runStatus !== undefined && validRunStatuses.has(run.runStatus) ? run.runStatus : undefined
    if (incomingStatus && !canAdvanceRunStatus(entry.status, incomingStatus)) return mission
    if (incomingStatus) entry.status = incomingStatus
    if (run.runStartedAt !== undefined) entry.startedAt = normalizeTimestamp(run.runStartedAt)
    const effectiveStatus = entry.status || mission.runStatus
    const terminalUpdate = isTerminalRunStatus(effectiveStatus)
    if (terminalUpdate) {
      if (!entry.finishedAt) entry.finishedAt = normalizeTimestamp(run.runFinishedAt) || new Date().toISOString()
    } else {
      delete entry.finishedAt
    }
    if (run.agentId !== undefined) entry.agentId = requiredText(run.agentId, 128)
    mission.runHistory = limitRunHistory([...normalizeRunHistory(mission.runHistory).filter((item) => item.attempt !== entry.attempt), entry])
    synchronizeTopLevelRun(mission, entry)
    if (run.runError === 'peer_run_failed' && effectiveStatus === 'failed') mission.runError = 'peer_run_failed'
    mission.updatedAt = new Date(Math.max(Date.now(), Date.parse(mission.updatedAt) + 1)).toISOString()
    await writeStore(dataDir, store)
    return mission
  })
}
export async function updateMission(dataDir, id, profile, changes) {
  return withWriteLock(async () => {
    const store = await readStore(dataDir)
    const mission = store.missions.find((item) => item.id === id && item.profile === profile)
    if (!mission) return undefined
    if (changes.title !== undefined) mission.title = requiredText(changes.title, 160)
    if (changes.description !== undefined) mission.description = optionalText(changes.description, 2000)
    if (changes.result !== undefined) {
      mission.result = optionalText(changes.result, 4000)
      if (!mission.result) {
        delete mission.result
        delete mission.resultKind
      }
    }
    if (changes.resultKind !== undefined) {
      if (!validResultKinds.has(changes.resultKind)) throw invalidMissionError()
      mission.resultKind = changes.resultKind
    }
    if (changes.owner !== undefined) mission.owner = requiredText(changes.owner, 80)
    if (changes.state !== undefined) {
      if (!validStates.has(changes.state)) throw invalidMissionError()
      mission.state = changes.state
    }
    const previous = Date.parse(mission.updatedAt) || 0
    mission.updatedAt = new Date(Math.max(Date.now(), previous + 1)).toISOString()
    await writeStore(dataDir, store)
    return mission
  })
}
async function readStore(dataDir) {
  if (!dataDir) return { missions: [] }
  const directory = await openVerifiedDataDirectory(dataDir)
  let file
  try {
    try {
      file = await open(`/proc/self/fd/${directory.fd}/${storageFile}`, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if (error?.code === 'ENOENT') return { missions: [] }
      throw error
    }
    const stats = await file.stat()
    if (!stats.isFile() || stats.size > maxStorageBytes) throw invalidMissionStoreError()
    const raw = await file.readFile({ encoding: 'utf8' })
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.missions)) throw invalidMissionStoreError()
    return { missions: parsed.missions.filter(isStoredMission).map(normalizeStoredMission) }
  } catch (error) {
    if (error?.code === 'profile_storage_unsafe' || error?.code === 'mission_store_invalid') throw error
    throw invalidMissionStoreError()
  } finally {
    await file?.close().catch(() => {})
    await directory.close().catch(() => {})
  }
}

async function writeStore(dataDir, store) {
  if (!dataDir) throw unavailableMissionStoreError()
  const directory = await openVerifiedDataDirectory(dataDir)
  const temporaryFile = `.missions-${randomUUID()}.tmp`
  const temporaryPath = `/proc/self/fd/${directory.fd}/${temporaryFile}`
  const finalPath = `/proc/self/fd/${directory.fd}/${storageFile}`
  let file
  try {
    file = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    await file.writeFile(`${JSON.stringify(store, null, 2)}\n`, 'utf8')
    await file.sync()
    await file.close()
    file = undefined
    await rename(temporaryPath, finalPath)
  } finally {
    await file?.close().catch(() => {})
    await unlink(temporaryPath).catch(() => {})
    await directory.close().catch(() => {})
  }
}

function withWriteLock(operation) {
  const next = writeQueue.then(operation, operation)
  writeQueue = next.catch(() => {})
  return next
}

function nextRunAttempt(mission, id, history = normalizeRunHistory(mission.runHistory)) {
  const currentAttempt = currentTopLevelAttempt(mission, id, history)
  const historyAttempt = history.reduce((highest, entry) => Math.max(highest, entry.attempt), 0)
  return Math.max(currentAttempt, historyAttempt) + 1
}

function currentTopLevelAttempt(mission, id, history) {
  const storedAttempt = normalizeRunAttempt(mission.runAttempt)
  if (storedAttempt > 0) return storedAttempt
  const runId = typeof mission.runId === 'string' && mission.runId.trim() ? mission.runId.trim() : undefined
  if (runId) {
    const historicalMatch = history.find((entry) => entry.runId === runId)
    if (historicalMatch) return historicalMatch.attempt
  }
  const keyVersion = missionRunKeyVersion(mission.idempotencyKey, id)
  if (keyVersion !== undefined) return keyVersion
  const historyAttempt = history.reduce((highest, entry) => Math.max(highest, entry.attempt), 0)
  if (runId) return historyAttempt + 1
  if (hasTopLevelRunEvidence(mission)) return historyAttempt + 1
  return 0
}

function hasTopLevelRunEvidence(mission) {
  return Boolean(normalizeTimestamp(mission.runStartedAt) || normalizeTimestamp(mission.runFinishedAt))
}

function missionRunKeyVersion(value, id) {
  if (typeof value !== 'string') return undefined
  const prefix = `mission:${id}:run:v`
  if (!value.startsWith(prefix)) return undefined
  const versionText = value.slice(prefix.length)
  if (!/^[1-9]\d*$/.test(versionText)) return undefined
  const version = Number(versionText)
  return Number.isSafeInteger(version) ? version : undefined
}

function markRunConflict(mission, entry) {
  const finishedAt = entry.finishedAt || new Date().toISOString()
  entry.status = 'failed'
  delete entry.runId
  entry.finishedAt = finishedAt
  mission.runHistory = limitRunHistory([...normalizeRunHistory(mission.runHistory).filter((item) => item.attempt !== entry.attempt), entry])
  mission.runStatus = 'failed'
  mission.runError = 'peer_run_failed'
  delete mission.runId
  mission.runFinishedAt = finishedAt
  mission.updatedAt = new Date(Math.max(Date.now(), Date.parse(mission.updatedAt) + 1)).toISOString()
}
function canAdvanceRunStatus(current, incoming) {
  if (!validRunStatuses.has(incoming)) return false
  if (!validRunStatuses.has(current)) return true
  if (isTerminalRunStatus(current)) return incoming === current
  if (incoming === 'starting' && current === 'running') return false
  if (incoming === 'starting' && isTerminalRunStatus(current)) return false
  return true
}

function isTerminalRunStatus(value) {
  return terminalRunStatuses.has(value)
}
function synchronizeTopLevelRun(mission, entry) {
  const status = validRunStatuses.has(entry.status) ? entry.status : 'failed'
  mission.runStatus = status
  if (entry.runId) mission.runId = entry.runId
  else delete mission.runId
  if (entry.agentId) mission.agentId = entry.agentId
  else delete mission.agentId
  if (entry.startedAt) mission.runStartedAt = entry.startedAt
  else delete mission.runStartedAt
  if (isTerminalRunStatus(status) && entry.finishedAt) mission.runFinishedAt = entry.finishedAt
  else delete mission.runFinishedAt
  if (status === 'failed') mission.runError = 'peer_run_failed'
  else delete mission.runError
}

function normalizeStoredMission(mission) {
  const currentAttempt = normalizeRunAttempt(mission.runAttempt)
  const runHistory = limitRunHistory(normalizeRunHistory(mission.runHistory))
  const normalized = {
    id: mission.id,
    profile: mission.profile,
    title: mission.title,
    description: mission.description,
    owner: mission.owner,
    state: mission.state,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
  }
  if (typeof mission.runId === 'string' && mission.runId.trim()) normalized.runId = mission.runId.trim().slice(0, 256)
  if (Number.isSafeInteger(mission.runAttempt) && mission.runAttempt >= 1) normalized.runAttempt = mission.runAttempt
  if (typeof mission.idempotencyKey === 'string' && mission.idempotencyKey.trim()) normalized.idempotencyKey = mission.idempotencyKey.trim().slice(0, 256)
  const runStartedAt = normalizeTimestamp(mission.runStartedAt)
  const runFinishedAt = normalizeTimestamp(mission.runFinishedAt)
  if (runStartedAt) normalized.runStartedAt = runStartedAt
  if (runFinishedAt && isTerminalRunStatus(mission.runStatus)) normalized.runFinishedAt = runFinishedAt
  if (typeof mission.agentId === 'string' && mission.agentId.trim()) normalized.agentId = mission.agentId.trim().slice(0, 128)
  if (validRunStatuses.has(mission.runStatus)) normalized.runStatus = mission.runStatus
  if (mission.runError === 'peer_run_failed') normalized.runError = mission.runError
  if (runHistory.length > 0 || Array.isArray(mission.runHistory)) normalized.runHistory = runHistory
  const currentEntry = currentAttempt > 0 ? runHistory.find((entry) => entry.attempt === currentAttempt) : undefined
  if (currentEntry) synchronizeTopLevelRun(normalized, currentEntry)
  return normalized
}

function normalizeRunHistory(value, maximumAttempt) {
  if (!Array.isArray(value)) return []
  const byAttempt = new Map()
  for (const item of value) {
    if (!item || !Number.isSafeInteger(item.attempt) || item.attempt < 1 || (maximumAttempt !== undefined && item.attempt > maximumAttempt)) continue
    const entry = { attempt: item.attempt }
    if (typeof item.runId === 'string' && item.runId.trim()) entry.runId = item.runId.trim().slice(0, 256)
    if (typeof item.agentId === 'string' && item.agentId.trim()) entry.agentId = item.agentId.trim().slice(0, 128)
    if (validRunStatuses.has(item.status)) entry.status = item.status
    if (item.startedAt !== undefined) {
      const timestamp = normalizeTimestamp(item.startedAt)
      if (timestamp) entry.startedAt = timestamp
    }
    if (item.finishedAt !== undefined && isTerminalRunStatus(entry.status)) {
      const timestamp = normalizeTimestamp(item.finishedAt)
      if (timestamp) entry.finishedAt = timestamp
    }
    if (Object.keys(entry).length <= 1) continue
    const previous = byAttempt.get(entry.attempt)
    if (!previous) byAttempt.set(entry.attempt, [entry])
    else if (!previous.some((candidate) => JSON.stringify(candidate) === JSON.stringify(entry))) previous.push(entry)
  }
  const normalized = [...byAttempt.entries()].map(([attempt, entries]) => entries.length === 1
    ? entries[0]
    : { attempt, status: 'failed' })
  const byRunId = new Map()
  for (const entry of normalized) {
    if (!entry.runId) continue
    const previous = byRunId.get(entry.runId)
    if (!previous || entry.attempt > previous.attempt) byRunId.set(entry.runId, entry)
  }
  return normalized
    .filter((entry) => !entry.runId || byRunId.get(entry.runId) === entry)
    .sort((left, right) => left.attempt - right.attempt)
}

function snapshotTopLevelRun(mission, id, history = normalizeRunHistory(mission.runHistory)) {
  const attempt = currentTopLevelAttempt(mission, id, history)
  if (attempt < 1 || (!mission.runId && !mission.runStatus && !mission.agentId && !mission.runStartedAt && !mission.runFinishedAt)) return undefined
  const entry = { attempt }
  if (typeof mission.runId === 'string' && mission.runId.trim()) entry.runId = mission.runId.trim().slice(0, 256)
  if (typeof mission.agentId === 'string' && mission.agentId.trim()) entry.agentId = mission.agentId.trim().slice(0, 128)
  if (validRunStatuses.has(mission.runStatus)) entry.status = mission.runStatus
  const startedAt = normalizeTimestamp(mission.runStartedAt)
  const finishedAt = normalizeTimestamp(mission.runFinishedAt)
  if (startedAt) entry.startedAt = startedAt
  if (finishedAt) entry.finishedAt = finishedAt
  return Object.keys(entry).length > 1 ? entry : undefined
}

function limitRunHistory(history) {
  return history.sort((left, right) => left.attempt - right.attempt).slice(-maxRunHistoryEntries)
}

function normalizeTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

function normalizeRunAttempt(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function isStoredMission(value) {
  return value
    && typeof value.id === 'string'
    && typeof value.profile === 'string'
    && typeof value.title === 'string'
    && typeof value.description === 'string'
    && typeof value.owner === 'string'
    && validStates.has(value.state)
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
}

function requiredText(value, maxLength) {
  if (typeof value !== 'string') throw invalidMissionError()
  const text = value.trim()
  if (!text || text.length > maxLength || /\p{C}/u.test(text)) throw invalidMissionError()
  return text
}

function optionalText(value, maxLength) {
  if (value === undefined || value === null || value === '') return ''
  return requiredText(value, maxLength)
}

function invalidMissionError() {
  const error = new Error('Invalid mission')
  error.code = 'invalid_mission'
  return error
}

function missionChangedError() {
  const error = new Error('Mission changed')
  error.code = 'mission_changed'
  return error
}
function invalidMissionStoreError() {
  const error = new Error('Invalid mission store')
  error.code = 'mission_store_invalid'
  return error
}

function unavailableMissionStoreError() {
  const error = new Error('Mission storage unavailable')
  error.code = 'mission_storage_unavailable'
  return error
}
