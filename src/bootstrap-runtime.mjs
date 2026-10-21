/**
 * Pure state transitions and a small serial poller shared by React and Node tests.
 */

const selectedProfileStorageKey = 'bonys-mission-control.profile'
const safeProfileFilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.ya?ml$/

export function readStoredProfile(storage) {
  try {
    const value = storage?.getItem(selectedProfileStorageKey) || ''
    return safeProfileFilePattern.test(value) ? value : ''
  } catch {
    return ''
  }
}

export function persistSelectedProfile(storage, profile) {
  try {
    if (safeProfileFilePattern.test(profile)) {
      storage?.setItem(selectedProfileStorageKey, profile)
    } else {
      storage?.removeItem(selectedProfileStorageKey)
    }
  } catch {
    // Blockierter Browser-Speicher darf die Profilauswahl nicht stören.
  }
}

export function applyBootstrapSuccess(data) {
  return {
    bootstrap: {
      ...data,
      source: 'backend',
      projectIndex: data.projectIndex ?? { status: 'disabled', documents: [] },
    },
    apiState: 'backend',
  }
}

export function deriveWizardIdentity(data, current) {
  const agents = Array.isArray(data?.agents) ? data.agents : []
  const owner = data?.team?.owner || agents.find((agent) => agent.type === 'human')?.name
  const peerNames = agents.filter((agent) => agent.type !== 'human').map((agent) => agent.name)
  const coordinator = data?.team?.coordinator
    || agents.find((agent) => agent.id === 'coordinator')?.name
    || peerNames[0]

  return {
    ownerName: owner || current.ownerName,
    coordinatorName: coordinator || current.coordinatorName,
    agentNames: peerNames.join(', '),
  }
}

export function applyBootstrapFailure(current, fallback, hasBackendData) {
  if (!hasBackendData) {
    return { bootstrap: fallback, apiState: 'fallback' }
  }

  return {
    bootstrap: {
      ...current,
      agents: current.agents.map((agent) => agent.statusSource === 'live'
        ? { ...agent, status: 'offline', statusSource: 'stale' }
        : agent),
    },
    apiState: 'degraded',
  }
}

export function rollbackProfileAfterFailure(selectedProfile, confirmedProfileFile) {
  return selectedProfile && selectedProfile !== confirmedProfileFile
    ? confirmedProfileFile
    : undefined
}

export function createBootstrapPoller({
  fetchBootstrap,
  onSuccess,
  onFailure,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  setRequestTimer = setTimeout,
  clearRequestTimer = clearTimeout,
  interval = 15_000,
  requestTimeout = 10_000,
}) {
  let active = false
  let generation = 0
  let profile = ''
  let timer
  let controller

  const run = async (currentGeneration) => {
    if (!active || currentGeneration !== generation) return
    const runController = new AbortController()
    controller = runController
    let requestTimer
    try {
      const timeout = new Promise((_resolve, reject) => {
        requestTimer = setRequestTimer(() => {
          runController.abort()
          reject(new Error('Bootstrap request timed out'))
        }, requestTimeout)
      })
      const aborted = new Promise((_resolve, reject) => {
        runController.signal.addEventListener('abort', () => reject(new Error('Bootstrap request aborted')), {
          once: true,
        })
      })
      const data = await Promise.race([
        fetchBootstrap(profile, runController.signal),
        timeout,
        aborted,
      ])
      if (active && currentGeneration === generation) onSuccess(data)
    } catch (error) {
      if (active && currentGeneration === generation) onFailure(error)
    } finally {
      if (requestTimer !== undefined) clearRequestTimer(requestTimer)
      if (active && currentGeneration === generation) {
        timer = setTimer(() => run(currentGeneration), interval)
      }
    }
  }

  return {
    start(selectedProfile = '') {
      if (active) return
      profile = selectedProfile
      active = true
      generation += 1
      void run(generation)
    },
    stop() {
      active = false
      generation += 1
      controller?.abort()
      if (timer !== undefined) clearTimer(timer)
      timer = undefined
    },
  }
}
