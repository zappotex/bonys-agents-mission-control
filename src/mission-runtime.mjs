export function createMissionRunPoller({
  getMissions,
  fetchStatus,
  onMission,
  onFailure = () => {},
  schedule = setTimeout,
  clearSchedule = clearTimeout,
  intervalMs = 5000,
}) {
  let active = false
  let generation = 0
  let timer
  let controller
  const invalidatedMissionIds = new Set()

  async function poll(profile, currentGeneration) {
    if (!active || currentGeneration !== generation) return
    controller = new AbortController()
    const pendingMissions = getMissions().filter((mission) => isPendingRun(mission) && !invalidatedMissionIds.has(mission.id))

    for (const mission of pendingMissions) {
      try {
        const updatedMission = await fetchStatus(mission, profile, controller.signal)
        if (!active || currentGeneration !== generation || invalidatedMissionIds.has(mission.id)) continue
        onMission(updatedMission)
      } catch (error) {
        if (!active || currentGeneration !== generation || controller.signal.aborted) return
        onFailure(error, mission)
      }
    }

    if (!active || currentGeneration !== generation) return
    timer = schedule(() => poll(profile, currentGeneration), intervalMs)
  }

  return {
    start(profile) {
      if (active) return
      active = true
      generation += 1
      void poll(profile, generation)
    },
    invalidate(missionId) {
      invalidatedMissionIds.add(missionId)
    },
    resume(missionId) {
      invalidatedMissionIds.delete(missionId)
    },
    stop() {
      if (!active) return
      active = false
      generation += 1
      controller?.abort()
      if (timer !== undefined) clearSchedule(timer)
      timer = undefined
    },
  }
}

function isPendingRun(mission) {
  return Boolean(mission?.runId) && ['starting', 'running'].includes(mission?.runStatus)
}

export function isTerminalRunStatus(status) {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(status)
}

export function canStartMissionRun(mission) {
  if (mission?.runStatus === 'starting' && !mission?.runId) return true
  return !['starting', 'running'].includes(mission?.runStatus) && (!mission?.runId || isTerminalRunStatus(mission?.runStatus))
}

export function missionRunActionLabel(mission) {
  if (mission?.runStatus === 'starting' && !mission?.runId) return 'Start wiederholen'
  return isTerminalRunStatus(mission?.runStatus) ? 'Erneut starten' : 'Auftrag starten'
}

export function filterMissionsByState(missions, state) {
  if (state === 'all') return missions
  return missions.filter((mission) => mission?.state === state)
}

export function filterMissions(missions, state, query = '') {
  const stateMissions = filterMissionsByState(missions, state)
  const normalizedQuery = String(query).trim().toLocaleLowerCase()
  if (!normalizedQuery) return stateMissions
  return stateMissions.filter((mission) => [mission?.title, mission?.description, mission?.owner]
    .some((value) => String(value || '').toLocaleLowerCase().includes(normalizedQuery)))
}

export function missionStateClass(state) {
  return ['running', 'planned', 'review', 'done'].includes(state) ? state : 'unknown'
}

export function missionStateLabel(state) {
  return { running: 'Aktiv', planned: 'Geplant', review: 'Review', done: 'Fertig' }[state] || 'Unbekannt'
}
export function missionStateCounts(missions) {
  return {
    all: missions.length,
    running: missions.filter((mission) => mission?.state === 'running').length,
    planned: missions.filter((mission) => mission?.state === 'planned').length,
    review: missions.filter((mission) => mission?.state === 'review').length,
    done: missions.filter((mission) => mission?.state === 'done').length,
  }
}

export function missionFilterSummary({ total, visible, query = '', state = 'all' }) {
  const labels = { all: 'Alle', running: 'Aktiv', planned: 'Geplant', review: 'Review', done: 'Fertig' }
  const parts = [visible === total ? `${total} Mission${total === 1 ? '' : 'en'}` : `${visible} von ${total} Missionen`]
  if (String(query).trim()) parts.push(`Suche „${String(query).trim()}“`)
  if (state !== 'all') parts.push(`Status „${labels[state] || 'gewählt'}“`)
  return parts.join(' · ')
}
export function missionEmptyState({ total, visible, query = '', state = 'all' }) {
  if (visible > 0) return ''
  if (total === 0) return 'Noch keine Missionen für dieses Profil.'
  if (String(query).trim()) return 'Keine Mission passt zu dieser Suche.'
  const labels = { all: 'Alle', running: 'Aktiv', planned: 'Geplant', review: 'Review', done: 'Fertig' }
  return `Keine Mission im Status „${labels[state] || 'gewählten'}“.`
}

export function missionTitleForDisplay(mission) {
  const title = typeof mission?.title === 'string' ? mission.title.trim() : ''
  return title || 'Unbenannte Mission'
}

export function missionDescriptionForDisplay(mission) {
  const description = typeof mission?.description === 'string' ? mission.description.trim() : ''
  return description || 'Keine Beschreibung hinterlegt.'
}

export function missionOwnerForDisplay(mission) {
  const owner = typeof mission?.owner === 'string' ? mission.owner.trim() : ''
  return owner || 'Nicht zugewiesen'
}
export function resultKindLabelForMission(mission) {
  const kind = resultKindForMission(mission)
  return kind ? { note: 'Notiz', link: 'Link', file: 'Datei-Referenz' }[kind] : ''
}
export function resultKindForMission(mission) {
  if (!String(mission?.result || '').trim()) return ''
  return ['note', 'link', 'file'].includes(mission?.resultKind) ? mission.resultKind : 'note'
}

export function missionResultForClipboard(mission) {
  const result = typeof mission?.result === 'string' ? mission.result.trim() : ''
  return result
}

export function formatMissionTimestamp(value) {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' }).format(date)
}

export function outboxMissions(missions) {
  return missions
    .filter((mission) => mission?.state === 'done' && String(mission?.result || '').trim())
    .slice()
    .sort((left, right) => {
      const leftTime = Date.parse(String(left.updatedAt || ''))
      const rightTime = Date.parse(String(right.updatedAt || ''))
      if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return String(left.id || '').localeCompare(String(right.id || ''))
      if (Number.isNaN(leftTime)) return 1
      if (Number.isNaN(rightTime)) return -1
      return rightTime - leftTime
    })
}

export function normalizeMissionResponse(payload) {
  return {
    missions: Array.isArray(payload?.missions) ? payload.missions.map(normalizeMissionForBrowser) : [],
    storageAvailable: payload?.storageAvailable === true,
  }
}

export function missionHistoryForDisplay(mission) {
  return [...normalizeRunHistoryForBrowser(mission?.runHistory)].sort((left, right) => right.attempt - left.attempt)
}

const missionFieldsForBrowser = [
  'id', 'profile', 'title', 'description', 'result', 'resultKind', 'owner', 'state', 'createdAt', 'updatedAt',
  'runId', 'runAttempt', 'idempotencyKey', 'runStartedAt', 'runFinishedAt', 'agentId', 'runStatus',
]
const validRunStatuses = new Set(['starting', 'running', 'completed', 'failed', 'cancelled', 'interrupted'])
const maxRunHistoryEntries = 25

function normalizeMissionForBrowser(mission) {
  if (!mission || typeof mission !== 'object') return mission
  const normalized = {}
  for (const field of missionFieldsForBrowser) {
    if (mission[field] !== undefined) normalized[field] = mission[field]
  }
  if (normalized.resultKind !== undefined && !['note', 'link', 'file'].includes(normalized.resultKind)) normalized.resultKind = 'note'
  if (!String(normalized.result || '').trim()) delete normalized.resultKind
  if (mission.runError === 'peer_run_failed') normalized.runError = mission.runError
  if (normalized.runFinishedAt && !isTerminalRunStatus(normalized.runStatus)) delete normalized.runFinishedAt
  normalized.runHistory = normalizeRunHistoryForBrowser(mission.runHistory)
  return normalized
}

function normalizeRunHistoryForBrowser(value) {
  if (!Array.isArray(value)) return []
  const byAttempt = new Map()
  for (const item of value) {
    if (!item || !Number.isSafeInteger(item.attempt) || item.attempt < 1) continue
    const entry = { attempt: item.attempt }
    if (typeof item.runId === 'string' && item.runId) entry.runId = item.runId
    if (typeof item.agentId === 'string' && item.agentId) entry.agentId = item.agentId
    if (validRunStatuses.has(item.status)) entry.status = item.status
    if (typeof item.startedAt === 'string' && item.startedAt) entry.startedAt = item.startedAt
    if (typeof item.finishedAt === 'string' && item.finishedAt && isTerminalRunStatus(entry.status)) entry.finishedAt = item.finishedAt
    if (Object.keys(entry).length <= 1) continue
    const previous = byAttempt.get(item.attempt)
    if (!previous) byAttempt.set(item.attempt, [entry])
    else if (!previous.some((candidate) => JSON.stringify(candidate) === JSON.stringify(entry))) previous.push(entry)
  }
  const normalized = [...byAttempt.entries()].map(([attempt, entries]) => entries.length === 1
    ? entries[0]
    : { attempt, status: 'failed' })
  const byRunId = new Map()
  for (const entry of normalized) {
    if (!entry.runId || !Number.isSafeInteger(entry.attempt)) continue
    const previous = byRunId.get(entry.runId)
    if (!previous || entry.attempt > previous.attempt) byRunId.set(entry.runId, entry)
  }
  return normalized
    .filter((entry) => !entry.runId || byRunId.get(entry.runId) === entry)
    .sort((left, right) => left.attempt - right.attempt)
    .slice(-maxRunHistoryEntries)
}

export function replaceMission(missions, mission) {
  const index = missions.findIndex((item) => item.id === mission.id)
  if (index === -1) return [...missions, mission]
  return missions.map((item, itemIndex) => itemIndex === index ? mission : item)
}
