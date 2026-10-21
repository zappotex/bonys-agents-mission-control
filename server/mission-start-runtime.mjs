export function createMissionRunStarter({ claim, execute }) {
  const inFlight = new Map()

  return function start(request) {
    const missionKey = `${request.profile}:${request.missionId}`
    const current = inFlight.get(missionKey)
    if (current) return current

    const operation = (async () => {
      const claimed = await claim(request)
      if (!claimed) return undefined
      const attempt = claimed.mission?.runAttempt
      const attemptKey = Number.isSafeInteger(attempt)
        ? `${missionKey}:${attempt}`
        : undefined
      if (attemptKey) inFlight.set(attemptKey, operation)
      if (claimed.replayed && !claimed.recovery) return claimed
      return execute({ claim: claimed, request })
    })()
    // The pending claim is part of the same single-flight operation. Once the
    // durable claim reveals its attempt, the exact operation is also indexed by
    // profile + mission + attempt until the peer POST and persistence finish.
    inFlight.set(missionKey, operation)
    operation.then(
      () => removeOperation(inFlight, missionKey, operation),
      () => removeOperation(inFlight, missionKey, operation),
    )
    return operation
  }
}

function removeOperation(inFlight, missionKey, operation) {
  for (const [key, value] of inFlight) {
    if (value === operation && (key === missionKey || key.startsWith(`${missionKey}:`))) inFlight.delete(key)
  }
}
