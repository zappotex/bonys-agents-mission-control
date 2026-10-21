import assert from 'node:assert/strict'
import test from 'node:test'
import { isAuthenticatedWriteProxyRequest } from '../src/vite-proxy-runtime.mjs'

test('Vite-Proxy authentifiziert Profil- und Mission-Schreibzugriffe', () => {
  assert.equal(isAuthenticatedWriteProxyRequest('POST', '/api/profiles'), true)
  assert.equal(isAuthenticatedWriteProxyRequest('POST', '/api/missions'), true)
  assert.equal(isAuthenticatedWriteProxyRequest('PATCH', '/api/missions/mission-123'), true)
  assert.equal(isAuthenticatedWriteProxyRequest('GET', '/api/missions'), false)
  assert.equal(isAuthenticatedWriteProxyRequest('POST', '/api/bootstrap'), false)
})
