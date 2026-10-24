import { timingSafeEqual } from 'node:crypto'

export function canReadMissions(request, expectedToken, bindHost, localOnly = false) {
  if (isLoopbackHost(bindHost)) return true
  if (localOnly && isLoopbackHostHeader(request.headers.host)) return true
  return hasBearerToken(request, expectedToken)
}

function hasBearerToken(request, expectedToken) {
  const expected = String(expectedToken || '')
  const authorization = String(request.headers.authorization || '')
  const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  if (!expected || !supplied) return false
  const expectedBuffer = Buffer.from(expected)
  const suppliedBuffer = Buffer.from(supplied)
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer)
}

function isLoopbackHostHeader(value) {
  const raw = String(value || '').trim()
  if (!raw) return false
  try {
    return isLoopbackHost(new URL(`http://${raw}`).hostname)
  } catch {
    return false
  }
}

function isLoopbackHost(value) {
  const host = String(value || '').replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

// trustedGateways: im Docker-Container kommen Anfragen über den nur an 127.0.0.1 freigegebenen Port vom
// Gateway des Container-Netzes – diese Adressen gelten (nur mit MISSION_CONTROL_LOCAL_ONLY) wie Loopback.
export function canWriteProfiles(request, expectedToken, trustedGateways = []) {
  if (hasBearerToken(request, expectedToken)) return true

  const remoteAddress = String(request.socket.remoteAddress || '').replace(/^::ffff:/, '')
  const loopbackSocket = remoteAddress === '127.0.0.1' || remoteAddress === '::1'
  const viaGateway = !loopbackSocket && remoteAddress !== '' && trustedGateways.includes(remoteAddress)
  if (!loopbackSocket && !viaGateway) return false

  const origin = String(request.headers.origin || '')
  if (!origin) return false
  try {
    const originUrl = new URL(origin)
    const originHostname = originUrl.hostname.replace(/^\[|\]$/g, '')
    const requestHost = String(request.headers.host || '').toLowerCase()
    const localPort = String(request.socket.localPort || '')
    const effectiveOriginPort = originUrl.port || (originUrl.protocol === 'http:' ? '80' : '443')
    return ['http:', 'https:'].includes(originUrl.protocol)
      && ['localhost', '127.0.0.1', '::1'].includes(originHostname)
      && originUrl.host.toLowerCase() === requestHost
      // hinter der Docker-Portfreigabe weicht der Port im Container vom freigegebenen ab
      && (viaGateway || effectiveOriginPort === localPort)
  } catch {
    return false
  }
}

// Standard-Gateways (IPv4) aus dem Inhalt von /proc/net/route
export function defaultGateways(routeTable) {
  const gateways = []
  for (const line of String(routeTable || '').split('\n').slice(1)) {
    const [, destination, gateway] = line.trim().split(/\s+/)
    if (destination !== '00000000' || !/^[0-9A-Fa-f]{8}$/.test(gateway || '') || gateway === '00000000') continue
    const bytes = gateway.match(/../g).map((byte) => parseInt(byte, 16)).reverse()
    gateways.push(bytes.join('.'))
  }
  return [...new Set(gateways)]
}
