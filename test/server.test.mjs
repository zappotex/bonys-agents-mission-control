// Starttest für das Backend: echter Prozess auf einem freien Port, nur Lesezugriffe
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverFile = fileURLToPath(new URL('../server/server.mjs', import.meta.url))
const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-test-'))
let child
let baseUrl
let peerServer
let peerHealthRequests = 0
let concurrentHealthRequests = 0
let unsafeAuthorizationSeen = false
let credentialOnlyAuthorizationSeen = false

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

async function getJson(pathname) {
  const response = await fetch(baseUrl + pathname)
  return { status: response.status, body: await response.json() }
}

before(async () => {
  mkdirSync(path.join(dataDir, 'profiles'))
  writeFileSync(path.join(dataDir, 'profiles', 'eigenes-team.yaml'), 'name: Eigenes Team\nteam:\n  owner: Testerin\n')
  writeFileSync(path.join(dataDir, 'profiles', 'geheim.local.yaml'), 'name: Geheim\nintegrations:\n  token: abc\n')
  writeFileSync(path.join(dataDir, 'profiles', 'idle-team.yaml'), 'name: Idle Team\nteam:\n  owner: Operator\nagents:\n  - id: idle\n    name: Idle\n    type: hermes-peer\n    peer: idle\n')
  writeFileSync(path.join(dataDir, 'profiles', 'public-team.yaml'), 'name: Public Team\nteam:\n  owner: Operator\nagents:\n  - id: public\n    name: Public\n    type: hermes-peer\n    peer: public\n')
  writeFileSync(path.join(dataDir, 'profiles', 'malformed-team.yaml'), 'name: Malformed Team\nteam:\n  owner: Operator\nagents:\n  - id: malformed\n    name: Malformed\n    type: hermes-peer\n    peer: malformed\n')
  writeFileSync(path.join(dataDir, 'profiles', 'unsafe-team.yaml'), 'name: Unsafe Team\nteam:\n  owner: Operator\nagents:\n  - id: unsafe\n    name: Unsafe\n    type: hermes-peer\n    peer: unsafe\n')
  writeFileSync(path.join(dataDir, 'profiles', 'degraded-team.yaml'), 'name: Degraded Team\nteam:\n  owner: Operator\nagents:\n  - id: degraded\n    name: Degraded\n    type: hermes-peer\n    peer: degraded\n')
  writeFileSync(path.join(dataDir, 'profiles', 'concurrent-team.yaml'), 'name: Concurrent Team\nteam:\n  owner: Operator\nagents:\n  - id: concurrent\n    name: Concurrent\n    type: hermes-peer\n    peer: concurrent\n')

  peerServer = createHttpServer((request, response) => {
    if (request.url === '/health/detailed' && request.headers.authorization === 'Bearer credential-only-key') {
      credentialOnlyAuthorizationSeen = true
    }
    if (request.url === '/health/detailed' && request.headers.authorization === 'Bearer forbidden-general-key') {
      unsafeAuthorizationSeen = true
    }
    if (request.url === '/health/detailed' && request.headers.authorization === 'Bearer test-peer-key') {
      peerHealthRequests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"status":"ok","gateway_busy":true,"active_agents":1,"api_server":{"active_runs":1}}')
      return
    }
    if (request.url === '/health/detailed' && request.headers.authorization === 'Bearer idle-peer-key') {
      peerHealthRequests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"status":"ok","gateway_busy":false,"active_agents":0,"api_server":{"active_runs":0}}')
      return
    }
    if (request.url === '/health/detailed' && request.headers.authorization === 'Bearer malformed-peer-key') {
      peerHealthRequests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{not-valid-json')
      return
    }
    if (request.url === '/health/detailed' && request.headers.authorization === 'Bearer degraded-peer-key') {
      peerHealthRequests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"status":"degraded","gateway_busy":true,"active_agents":0,"api_server":{"active_runs":0}}')
      return
    }
    if (request.url === '/health/detailed' && request.headers.authorization === 'Bearer concurrent-peer-key') {
      concurrentHealthRequests += 1
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"status":"ok","gateway_busy":false,"active_agents":0,"api_server":{"active_runs":0}}')
      }, 50)
      return
    }
    if (request.url === '/health') {
      peerHealthRequests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"status":"ok"}')
      return
    }
    response.writeHead(404).end()
  })
  await new Promise((resolve, reject) => {
    peerServer.once('error', reject)
    peerServer.listen(0, '127.0.0.1', resolve)
  })
  const peerPort = peerServer.address().port
  writeFileSync(path.join(dataDir, 'profiles', 'credential-only-team.yaml'), `name: Credential Only Team\nteam:\n  owner: Operator\nagents:\n  - id: credential-only\n    name: Credential Only\n    type: hermes-peer\n    peer: credential-only\n    endpoint: http://127.0.0.1:${peerPort}\n`)
  writeFileSync(path.join(dataDir, 'peers.yaml'), `peers:\n  barney:\n    endpoint: http://127.0.0.1:${peerPort}\n    api_key_env: MISSION_CONTROL_PEER_TEST_KEY\n  idle:\n    endpoint: http://127.0.0.1:${peerPort}\n    api_key_env: MISSION_CONTROL_PEER_IDLE_KEY\n  malformed:\n    endpoint: http://127.0.0.1:${peerPort}\n    api_key_env: MISSION_CONTROL_PEER_MALFORMED_KEY\n  degraded:\n    endpoint: http://127.0.0.1:${peerPort}\n    api_key_env: MISSION_CONTROL_PEER_DEGRADED_KEY\n  concurrent:\n    endpoint: http://127.0.0.1:${peerPort}\n    api_key_env: MISSION_CONTROL_PEER_CONCURRENT_KEY\n  credential-only:\n    api_key_env: MISSION_CONTROL_PEER_CREDENTIAL_ONLY_KEY\n  unsafe:\n    endpoint: http://127.0.0.1:${peerPort}\n    api_key_env: OPENAI_API_KEY\n  public:\n    endpoint: http://127.0.0.1:${peerPort}\n`)

  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, [serverFile], {
    env: {
      ...process.env,
      MISSION_CONTROL_API_PORT: String(port),
      MISSION_CONTROL_DATA_DIR: dataDir,
      MISSION_CONTROL_PEER_TEST_KEY: 'test-peer-key',
      MISSION_CONTROL_PEER_IDLE_KEY: 'idle-peer-key',
      MISSION_CONTROL_PEER_MALFORMED_KEY: 'malformed-peer-key',
      MISSION_CONTROL_PEER_DEGRADED_KEY: 'degraded-peer-key',
      MISSION_CONTROL_PEER_CONCURRENT_KEY: 'concurrent-peer-key',
      MISSION_CONTROL_PEER_CREDENTIAL_ONLY_KEY: 'credential-only-key',
      OPENAI_API_KEY: 'forbidden-general-key',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`Server beendet mit ${code}`)))
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('listening')) resolve()
    })
  })
})

after(() => {
  child?.kill()
  peerServer?.close()
  rmSync(dataDir, { recursive: true, force: true })
})

test('health meldet ok und Version', async () => {
  const { status, body } = await getJson('/api/health')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.match(body.version, /^\d+\.\d+\.\d+/)
})

test('Profile aus dem Datenordner erscheinen, .local.yaml nicht', async () => {
  const { body } = await getJson('/api/profiles')
  const files = body.profiles.map((profile) => profile.file)
  assert.ok(files.includes('eigenes-team.yaml'))
  assert.ok(files.includes('bonys-agents.example.yaml'))
  assert.ok(!files.some((file) => file.endsWith('.local.yaml')))
})

test('bootstrap lädt ein Profil aus dem Datenordner', async () => {
  const { status, body } = await getJson('/api/bootstrap?profile=eigenes-team.yaml')
  assert.equal(status, 200)
  assert.equal(body.agents[0].name, 'Testerin')
})

test('das neutrale Beispielprofil verwendet keine Agentennamen aus Bonys Preset', async () => {
  const { status, body } = await getJson('/api/bootstrap?profile=example-team.yaml')
  const names = body.agents.map((agent) => agent.name)
  assert.equal(status, 200)
  assert.deepEqual(names, ['Your Name', 'Atlas', 'Nova', 'Scribe'])
  assert.ok(!names.includes('Barney'))
})

test('nicht live geprüfte Hermes-Peers werden nicht als beschäftigt erfunden', async () => {
  const { status, body } = await getJson('/api/bootstrap')
  const current = body.agents.find((agent) => agent.name === 'Current')
  assert.equal(status, 200)
  assert.ok(current)
  assert.equal(current.status, 'standby')
})

test('aktive Hermes-Peers werden live als beschäftigt gemeldet, ohne Endpunkt oder Schlüssel auszuliefern', async () => {
  const { status, body } = await getJson('/api/bootstrap')
  const barney = body.agents.find((agent) => agent.name === 'Barney')
  assert.equal(status, 200)
  assert.equal(barney.status, 'busy')
  assert.equal(barney.statusSource, 'live')
  assert.equal(barney.activitySource, 'hermes-detailed')
  assert.equal(barney.endpoint, undefined)
  assert.equal(barney.apiKey, undefined)
  assert.equal(JSON.stringify(body).includes('MISSION_CONTROL_PEER_TEST_KEY'), false)
  assert.equal(JSON.stringify(body).includes('test-peer-key'), false)
})

test('Peer-Status-Caches bleiben bei gleichem Endpunkt nach Schlüssel getrennt', async () => {
  await getJson('/api/bootstrap')
  const { status, body } = await getJson('/api/bootstrap?profile=idle-team.yaml')
  const idle = body.agents.find((agent) => agent.name === 'Idle')
  assert.equal(status, 200)
  assert.equal(idle.status, 'online')
  assert.equal(idle.statusSource, 'live')
  assert.equal(idle.activitySource, 'hermes-detailed')
})

test('Peers ohne Schlüssel melden nur Erreichbarkeit und keinen erfundenen Arbeitsstatus', async () => {
  const { status, body } = await getJson('/api/bootstrap?profile=public-team.yaml')
  const publicAgent = body.agents.find((agent) => agent.name === 'Public')
  assert.equal(status, 200)
  assert.equal(publicAgent.status, 'online')
  assert.equal(publicAgent.statusSource, 'live')
  assert.equal(publicAgent.activitySource, 'reachability')
})

test('fehlerhafte Detaildaten fallen auf den gesunden öffentlichen Healthcheck zurück', async () => {
  const { status, body } = await getJson('/api/bootstrap?profile=malformed-team.yaml')
  const malformed = body.agents.find((agent) => agent.name === 'Malformed')
  assert.equal(status, 200)
  assert.equal(malformed.status, 'online')
  assert.equal(malformed.statusSource, 'live')
  assert.equal(malformed.activitySource, 'reachability')
})

test('gültige degradierte Detaildaten behalten den autoritativen Beschäftigungsstatus', async () => {
  const { status, body } = await getJson('/api/bootstrap?profile=degraded-team.yaml')
  const degraded = body.agents.find((agent) => agent.name === 'Degraded')
  assert.equal(status, 200)
  assert.equal(degraded.status, 'busy')
  assert.equal(degraded.statusSource, 'live')
  assert.equal(degraded.activitySource, 'hermes-detailed')
})

test('nicht freigegebene Variablennamen werden niemals als Bearer-Schlüssel verwendet', async () => {
  const { status, body } = await getJson('/api/bootstrap?profile=unsafe-team.yaml')
  const unsafe = body.agents.find((agent) => agent.name === 'Unsafe')
  assert.equal(status, 200)
  assert.equal(unsafe.status, 'online')
  assert.equal(unsafe.activitySource, 'reachability')
  assert.equal(unsafeAuthorizationSeen, false)
  assert.equal(JSON.stringify(body).includes('OPENAI_API_KEY'), false)
  assert.equal(JSON.stringify(body).includes('forbidden-general-key'), false)
})

test('private Credentials ohne privaten Endpunkt werden nie an Profil-Endpunkte gesendet', async () => {
  const { status, body } = await getJson('/api/bootstrap?profile=credential-only-team.yaml')
  const agent = body.agents.find((item) => item.name === 'Credential Only')
  assert.equal(status, 200)
  assert.equal(agent.status, 'online')
  assert.equal(agent.activitySource, 'reachability')
  assert.equal(credentialOnlyAuthorizationSeen, false)
  assert.equal(JSON.stringify(body).includes('MISSION_CONTROL_PEER_CREDENTIAL_ONLY_KEY'), false)
  assert.equal(JSON.stringify(body).includes('credential-only-key'), false)
})

test('schnelle Bootstrap-Aufrufe teilen einen laufenden Peer-Healthcheck', async () => {
  await Promise.all([
    getJson('/api/bootstrap?profile=concurrent-team.yaml'),
    getJson('/api/bootstrap?profile=concurrent-team.yaml'),
  ])
  assert.equal(concurrentHealthRequests, 1)
})

test('lokale Profile werden ohne Freigabe nicht ausgeliefert', async () => {
  const { body } = await getJson('/api/bootstrap?profile=geheim.local.yaml')
  assert.equal(body.activeProfile.file, 'bonys-agents.example.yaml')
})

test('kein Pfad-Ausbruch aus dist/', async () => {
  const response = await fetch(baseUrl + '/%2e%2e/package.json')
  const text = await response.text()
  assert.ok(!text.includes('"devDependencies"'))
})
