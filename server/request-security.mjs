import { timingSafeEqual } from 'node:crypto'

export function canReadMissions(request, expectedToken, bindHost) {
  if (isLoopbackHost(bindHost)) return true
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

function isLoopbackHost(value) {
  const host = String(value || '').replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

export function canWriteProfiles(request, expectedToken) {
  if (hasBearerToken(request, expectedToken)) return true

  const remoteAddress = request.socket.remoteAddress || ''
  const loopbackSocket = remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1'
  if (!loopbackSocket) return false

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
      && effectiveOriginPort === localPort
  } catch {
    return false
  }
}
