const RELEASES_URL = 'https://api.github.com/repos/zappotex/bonys-agents-mission-control/releases/latest'
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/

export function normalizeVersion(value) {
  const match = typeof value === 'string' ? value.trim().match(VERSION_PATTERN) : null
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : undefined
}

export function compareVersions(left, right) {
  const a = normalizeVersion(left)
  const b = normalizeVersion(right)
  if (!a || !b) throw new Error('invalid_version')
  const leftParts = a.split('.').map(Number)
  const rightParts = b.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] > rightParts[index] ? 1 : -1
  }
  return 0
}

export function buildUpdateCommand(version) {
  const normalized = normalizeVersion(version)
  if (!normalized) throw new Error('invalid_version')
  return `sudo /opt/bonys-mission-control/scripts/update.sh --version ${normalized}`
}

export async function checkForUpdate({ currentVersion, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const current = normalizeVersion(currentVersion)
  if (!current) return { currentVersion: 'unknown', available: false, error: 'update_check_failed' }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(RELEASES_URL, {
      headers: { accept: 'application/vnd.github+json' },
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error('release_lookup_failed')
    const payload = await response.json()
    const latest = normalizeVersion(payload?.tag_name)
    const releaseUrl = typeof payload?.html_url === 'string' && /^https:\/\/github\.com\/zappotex\/bonys-agents-mission-control\/releases\/tag\/v\d+\.\d+\.\d+$/.test(payload.html_url)
      ? payload.html_url
      : undefined
    if (!latest || !releaseUrl) throw new Error('invalid_release')
    return {
      currentVersion: current,
      latestVersion: latest,
      updateAvailable: compareVersions(current, latest) < 0,
      releaseUrl,
      command: buildUpdateCommand(latest),
    }
  } catch {
    return { currentVersion: current, available: false, error: 'update_check_failed' }
  } finally {
    clearTimeout(timeout)
  }
}
