export function isAuthenticatedWriteProxyRequest(method, requestUrl) {
  if (method === 'POST' && requestUrl === '/api/profiles') return true
  return ['POST', 'PATCH'].includes(method || '')
    && typeof requestUrl === 'string'
    && (requestUrl === '/api/missions' || requestUrl.startsWith('/api/missions/'))
}
