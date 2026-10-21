export type BootstrapAgentStatus = 'online' | 'busy' | 'standby' | 'offline'
export type BootstrapAgentStatusSource = 'live' | 'configured' | 'stale'

export type BootstrapAgentState = {
  status: BootstrapAgentStatus
  statusSource?: BootstrapAgentStatusSource
}

type FailedAgent<A extends BootstrapAgentState> = Omit<A, 'status' | 'statusSource'> & {
  status: A['status'] | 'offline'
  statusSource: A['statusSource'] | 'stale'
}

type FailedBootstrap<T extends { agents: BootstrapAgentState[] }> = Omit<T, 'agents'> & {
  agents: FailedAgent<T['agents'][number]>[]
}

export function readStoredProfile(storage: Pick<Storage, 'getItem'> | undefined): string

export function persistSelectedProfile(
  storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined,
  profile: string,
): void

type DisabledProjectIndex = {
  status: 'disabled'
  documents: never[]
}

type NormalizedProjectIndex<T> = T extends { projectIndex?: infer P }
  ? Exclude<P, null | undefined> | DisabledProjectIndex
  : DisabledProjectIndex

type SuccessfulBootstrap<T> = Omit<T, 'source' | 'projectIndex'> & {
  source: 'backend'
  projectIndex: NormalizedProjectIndex<T>
}

export function applyBootstrapSuccess<T extends object>(data: T): {
  bootstrap: SuccessfulBootstrap<T>
  apiState: 'backend'
}

export function deriveWizardIdentity(
  data: {
    team?: { owner?: string; coordinator?: string }
    agents?: Array<{ id?: string; name: string; type?: string }>
  },
  current: { ownerName: string; coordinatorName: string },
): { ownerName: string; coordinatorName: string; agentNames: string }

export function applyBootstrapFailure<T extends { agents: BootstrapAgentState[] }>(
  current: T,
  fallback: T,
  hasBackendData: boolean,
): {
  bootstrap: T | FailedBootstrap<T>
  apiState: 'fallback' | 'degraded'
}

export function rollbackProfileAfterFailure(
  selectedProfile: string,
  confirmedProfileFile: string,
): string | undefined

export type BootstrapPollerOptions<T> = {
  fetchBootstrap: (profile: string, signal: AbortSignal) => Promise<T>
  onSuccess: (data: T) => void
  onFailure: (error: unknown) => void
  setTimer?: (callback: () => void, interval: number) => unknown
  clearTimer?: (timer: unknown) => void
  setRequestTimer?: (callback: () => void, timeout: number) => unknown
  clearRequestTimer?: (timer: unknown) => void
  interval?: number
  requestTimeout?: number
}

export function createBootstrapPoller<T>(options: BootstrapPollerOptions<T>): {
  start: (selectedProfile?: string) => void
  stop: () => void
}
