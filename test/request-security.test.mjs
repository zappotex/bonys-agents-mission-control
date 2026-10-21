import test from 'node:test'
import assert from 'node:assert/strict'
import { canReadMissions, canWriteProfiles } from '../server/request-security.mjs'

function request({ origin, host, localPort, remoteAddress = '127.0.0.1', authorization = '' }) {
  return {
    headers: { origin, host, authorization },
    socket: { localPort, remoteAddress },
  }
}

test('direkte Loopback-Origin normalisiert HTTP- und HTTPS-Standardports', () => {
  assert.equal(canWriteProfiles(request({
    origin: 'http://localhost',
    host: 'localhost',
    localPort: 80,
  }), ''), true)

  assert.equal(canWriteProfiles(request({
    origin: 'https://127.0.0.1',
    host: '127.0.0.1',
    localPort: 443,
  }), ''), true)
})

test('Loopback-Origin mit abweichendem effektivem Port bleibt verboten', () => {
  assert.equal(canWriteProfiles(request({
    origin: 'http://localhost',
    host: 'localhost:8080',
    localPort: 8080,
  }), ''), false)
})
test('externe Backend-Bindung schützt Missionslesezugriff mit demselben Bearer-Token', () => {
  const input = { remoteAddress: '10.0.0.5', host: '10.0.0.5:8788', localPort: 8788 }
  assert.equal(canReadMissions(request(input), 'mission-token', '0.0.0.0'), false)
  assert.equal(canReadMissions(request({ ...input, authorization: 'Bearer wrong' }), 'mission-token', '192.168.1.10'), false)
  assert.equal(canReadMissions(request({ ...input, authorization: 'Bearer mission-token' }), 'mission-token', '192.168.1.10'), true)
})

test('lokale Docker-Veröffentlichung erlaubt Missionslesen über den gebundenen Loopback-Host ohne Token', () => {
  assert.equal(canReadMissions(request({ host: '127.0.0.1:8787', remoteAddress: '172.17.0.1' }), '', '0.0.0.0', true), true)
  assert.equal(canReadMissions(request({ host: '192.168.1.20:8787', remoteAddress: '192.168.1.30' }), '', '0.0.0.0', true), false)
})
test('Loopback-Bindung lässt Missionslesezugriff ohne Token wie bisher zu', () => {
  assert.equal(canReadMissions(request({
    origin: 'http://localhost', host: 'localhost', localPort: 8788,
  }), 'mission-token', '127.0.0.1'), true)
})
