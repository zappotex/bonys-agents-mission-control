export type MissionRunStatus = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export type MissionRunHistoryEntry = {
  attempt: number
  runId?: string
  agentId?: string
  status?: MissionRunStatus
  startedAt?: string
  finishedAt?: string
}

export type MissionRecord = {
  id: string
  profile: string
  title: string
  description: string
  result?: string
  resultKind?: 'note' | 'link' | 'file'
  owner: string
  state: 'planned' | 'running' | 'review' | 'done'
  createdAt: string
  updatedAt: string
  runId?: string
  runAttempt?: number
  idempotencyKey?: string
  runStartedAt?: string
  runFinishedAt?: string
  agentId?: string
  runStatus?: MissionRunStatus
  runError?: string
  runHistory?: MissionRunHistoryEntry[]
}

export function createMissionRunPoller(options: {
  getMissions: () => MissionRecord[]
  fetchStatus: (mission: MissionRecord, profile: string, signal: AbortSignal) => Promise<MissionRecord>
  onMission: (mission: MissionRecord) => void
  onFailure?: (error: unknown, mission: MissionRecord) => void
  schedule?: (callback: () => void, intervalMs: number) => unknown
  clearSchedule?: (timer: unknown) => void
  intervalMs?: number
}): {
  start(profile: string): void
  invalidate(missionId: string): void
  resume(missionId: string): void
  stop(): void
}

export function isTerminalRunStatus(status: MissionRunStatus | undefined): boolean
export function canStartMissionRun(mission: MissionRecord): boolean
export function missionRunActionLabel(mission: MissionRecord): string
export function filterMissionsByState(missions: MissionRecord[], state: 'all' | MissionRecord['state']): MissionRecord[]
export function filterMissions(missions: MissionRecord[], state: 'all' | MissionRecord['state'], query?: string): MissionRecord[]
export function missionStateClass(state: string): string
export function missionStateLabel(state: string): string
export function missionStateCounts(missions: MissionRecord[]): { all: number; running: number; planned: number; review: number; done: number }
export function missionEmptyState(input: { total: number; visible: number; query?: string; state?: 'all' | MissionRecord['state'] }): string
export function missionFilterSummary(input: { total: number; visible: number; query?: string; state?: 'all' | MissionRecord['state'] }): string
export function missionDescriptionForDisplay(mission: Partial<MissionRecord>): string
export function missionOwnerForDisplay(mission: Partial<MissionRecord>): string
export function missionTitleForDisplay(mission: Partial<MissionRecord>): string
export function resultKindLabelForMission(mission: Partial<MissionRecord>): string
export function resultKindForMission(mission: Partial<MissionRecord>): '' | 'note' | 'link' | 'file'
export function missionResultForClipboard(mission: Partial<MissionRecord>): string
export function formatMissionTimestamp(value: string | undefined): string
export function outboxMissions(missions: MissionRecord[]): MissionRecord[]
export function missionHistoryForDisplay(mission: MissionRecord): MissionRunHistoryEntry[]
export function normalizeMissionResponse(payload: unknown): {
  missions: MissionRecord[]
  storageAvailable: boolean
}

export function replaceMission(missions: MissionRecord[], mission: MissionRecord): MissionRecord[]
