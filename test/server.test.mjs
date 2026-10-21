// Starttest für das Backend: echter Prozess auf einem freien Port, nur Lesezugriffe
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const serverFile = fileURLToPath(new URL('../server/server.mjs', import.meta.url))
const packageFile = fileURLToPath(new URL('../package.json', import.meta.url))
const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-test-'))
let child
let baseUrl
let peerServer
let peerHealthRequests = 0
let concurrentHealthRequests = 0
let unsafeAuthorizationSeen = false
let credentialOnlyAuthorizationSeen = false
let redirectTargetRequests = 0
let redirectFallbackAuthorizationSeen = false
let symlinkReadAuthorizationSeen = false
let runRequests = []
let runStatusRequests = []
let runStopRequests = []
let runStopResponse = '{"run_id":"run-test-123","status":"cancelled","output":"private stop output"}'
let runResponseBody
let releaseRunStart
let runStartStartedResolve
let runStartStarted = Promise.resolve()
let runStatusResponse = '{"object":"hermes.run","run_id":"run-test-123","status":"completed","output":"private peer output"}'
let releaseRunStatus
let runStatusStartedResolve
let runStatusStarted = Promise.resolve()

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

async function postJson(pathname, payload, headers = {}) {
  const response = await fetch(baseUrl + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: await response.json() }
}

async function patchJson(pathname, payload, headers = {}) {
  const response = await fetch(baseUrl + pathname, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: await response.json() }
}

function postJsonWithRawHeaders(pathname, payload, headers = {}) {
  const target = new URL(baseUrl + pathname)
  const body = JSON.stringify(payload)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...headers,
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }))
    })
    request.once('error', reject)
    request.end(body)
  })
}

function wizardPayload(overrides = {}) {
  return {
    teamName: 'Saved Team',
    ownerName: 'Alice',
    coordinatorName: 'Atlas',
    agentNames: ['Atlas', 'Nova'],
    projectPath: '/srv/projects',
    notesPath: '/srv/notes',
    outputPath: '/srv/output',
    theme: 'default-dark',
    usesHermesPeers: true,
    usesObsidian: true,
    ...overrides,
  }
}

function localBrowserHeaders() {
  const url = new URL(baseUrl)
  return { host: url.host, origin: url.origin }
}

async function startServerProcess(extraEnv = {}) {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const serverProcess = spawn(process.execPath, [serverFile], {
    env: {
      ...process.env,
      MISSION_CONTROL_API_PORT: String(port),
      MISSION_CONTROL_DATA_DIR: dataDir,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProcess.stderr.on('data', () => {})
  await new Promise((resolve, reject) => {
    serverProcess.once('exit', (code) => reject(new Error(`Server beendet mit ${code}`)))
    serverProcess.stdout.on('data', (chunk) => {
      if (String(chunk).includes('listening')) resolve()
    })
  })
  return { serverProcess, url }
}

before(async () => {
  mkdirSync(path.join(dataDir, 'profiles'))
  mkdirSync(path.join(dataDir, 'notes', 'projects'), { recursive: true })
  mkdirSync(path.join(dataDir, 'outside-notes'))
  writeFileSync(path.join(dataDir, 'notes', 'overview.md'), '---\ntitle: Mission Übersicht\ndate: 2026-10-16\ntags: [mission, active]\n---\nInhalt')
  writeFileSync(path.join(dataDir, 'notes', 'projects', 'alpha.md'), '# Alpha Dokument\n')
  writeFileSync(path.join(dataDir, 'outside-notes', 'secret.md'), '# Nicht indexieren\n')
  symlinkSync(path.join(dataDir, 'outside-notes'), path.join(dataDir, 'linked-notes'), 'dir')
  writeFileSync(path.join(dataDir, 'profiles', 'eigenes-team.yaml'), 'name: Eigenes Team\nteam:\n  owner: Testerin\n')
  writeFileSync(path.join(dataDir, 'profiles', 'geheim.local.yaml'), 'name: Geheim\nintegrations:\n  token: abc\n')
  writeFileSync(path.join(dataDir, 'profiles', 'idle-team.yaml'), 'name: Idle Team\nteam:\n  owner: Operator\nagents:\n  - id: idle\n    name: Idle\n    type: hermes-peer\n    peer: idle\n')
  writeFileSync(path.join(dataDir, 'profiles', 'public-team.yaml'), 'name: Public Team\nteam:\n  owner: Operator\nagents:\n  - id: public\n    name: Public\n    type: hermes-peer\n    peer: public\n')
  writeFileSync(path.join(dataDir, 'profiles', 'malformed-team.yaml'), 'name: Malformed Team\nteam:\n  owner: Operator\nagents:\n  - id: malformed\n    name: Malformed\n    type: hermes-peer\n    peer: malformed\n')
  writeFileSync(path.join(dataDir, 'profiles', 'unsafe-team.yaml'), 'name: Unsafe Team\nteam:\n  owner: Operator\nagents:\n  - id: unsafe\n    name: Unsafe\n    type: hermes-peer\n    peer: unsafe\n')
  writeFileSync(path.join(dataDir, 'profiles', 'degraded-team.yaml'), 'name: Degraded Team\nteam:\n  owner: Operator\nagents:\n  - id: degraded\n    name: Degraded\n    type: hermes-peer\n    peer: degraded\n')
  writeFileSync(path.join(dataDir, 'profiles', 'authority-team.yaml'), 'name: Authority Team\nteam:\n  owner: Operator\nagents:\n  - id: agent-a\n    name: Agent A\n    type: hermes-peer\n    peer: peer-a\n  - id: agent-b\n    name: Agent B\n    type: hermes-peer\n    peer: peer-b\n')
  writeFileSync(path.join(dataDir, 'profiles', 'concurrent-team.yaml'), 'name: Concurrent Team\nteam:\n  owner: Operator\nagents:\n  - id: concurrent\n    name: Concurrent\n    type: hermes-peer\n    peer: concurrent\n')
  writeFileSync(path.join(dataDir, 'profiles', 'index-team.yaml'), `name: Index Team\nteam:\n  owner: Operator\nintegrations:\n  notes:\n    enabled: true\n    path: ${path.join(dataDir, 'notes')}\n`)
  writeFileSync(path.join(dataDir, 'profiles', 'unsafe-index-team.yaml'), `name: Unsafe Index Team\nteam:\n  owner: Operator\nintegrations:\n  notes:\n    enabled: true\n    path: ${path.join(dataDir, 'linked-notes')}\n`)

  peerServer = createHttpServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/runs/run-test-123') {
      runStatusRequests.push({ authorization: request.headers.authorization })
      if (releaseRunStatus) {
        runStatusStartedResolve()
        releaseRunStatus.then(() => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(runStatusResponse)
        })
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(runStatusResponse)
      return
    }
    if (request.method === 'POST' && request.url === '/v1/runs/run-test-123/stop') {
      runStopRequests.push({ method: request.method, authorization: request.headers.authorization, url: request.url })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(runStopResponse)
      return
    }
    if (request.method === 'POST' && request.url === '/v1/runs') {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        runRequests.push({
          authorization: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          idempotency: request.headers['idempotency-key'],
        })
        if (releaseRunStart) {
          runStartStartedResolve()
          releaseRunStart.then(() => {
            response.writeHead(202, { 'content-type': 'application/json' })
            response.end(runResponseBody || JSON.stringify({
              run_id: request.headers['idempotency-key']?.endsWith(':v2') ? 'run-test-124' : 'run-test-123',
              status: 'started',
            }))
          })
          return
        }
        const runId = request.headers['idempotency-key']?.endsWith(':v2') ? 'run-test-124' : 'run-test-123'
        response.writeHead(202, { 'content-type': 'application/json' })
        response.end(runResponseBody || JSON.stringify({ run_id: runId, status: 'started' }))
      })
      return
    }
    if (request.url === '/symlink-read/health/detailed') {
      symlinkReadAuthorizationSeen = Boolean(request.headers.authorization)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"status":"ok","gateway_busy":true}')
      return
    }
    if (request.url === '/redirect-peer/health/detailed') {
      response.writeHead(302, { location: '/redirect-target' })
      response.end()
      return
    }
    if (request.url === '/redirect-target') {
      redirectTargetRequests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"status":"ok","gateway_busy":true}')
      return
    }
    if (request.url === '/redirect-peer/health') {
      redirectFallbackAuthorizationSeen = Boolean(request.headers.authorization)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"status":"ok"}')
      return
    }
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
  writeFileSync(path.join(dataDir, 'profiles', 'redirect-team.yaml'), 'name: Redirect Team\nteam:\n  owner: Operator\nagents:\n  - id: redirect\n    name: Redirect\n    type: hermes-peer\n    peer: redirect\n')
  writeFileSync(path.join(dataDir, 'profiles', 'malformed-url-team.yaml'), 'name: Malformed URL Team\nteam:\n  owner: Operator\nagents:\n  - id: malformed-url\n    name: Malformed URL\n    type: hermes-peer\n    peer: malformed-url\n')
  writeFileSync(path.join(dataDir, 'peers.yaml'), `peers:\n  peer-a:\n    endpoint: http://127.0.0.1:${peerPort}\n    api_key_env: MISSION_CONTROL_PEER_A_KEY\n  peer-b:\n    endpoint: http://127.0.0.1:${peerPort}\n    api_key_env: MISSION_CONTROL_PEER_B_KEY\n  barney:\n    endpoint: http://127.0.0.1:${peerPort}\n    api_key_env: MISSION_CONTROL_PEER_TEST_KEY\n  idle:\n    endpoint: http://127.0.0.1:${peerPort}\n    api_key_env: MISSION_CONTROL_PEER_IDLE_KEY\n  malformed:\n    endpoint: http://127.0.0.1:${peerPort}\n    api_key_env: MISSION_CONTROL_PEER_MALFORMED_KEY\n  degraded:\n    endpoint: http://127.0.0.1:${peerPort}\n    api_key_env: MISSION_CONTROL_PEER_DEGRADED_KEY\n  concurrent:\n    endpoint: http://127.0.0.1:${peerPort}\n    api_key_env: MISSION_CONTROL_PEER_CONCURRENT_KEY\n  credential-only:\n    api_key_env: MISSION_CONTROL_PEER_CREDENTIAL_ONLY_KEY\n  redirect:\n    endpoint: http://127.0.0.1:${peerPort}/redirect-peer\n    api_key_env: MISSION_CONTROL_PEER_REDIRECT_KEY\n  malformed-url:\n    endpoint: 'http://['\n    api_key_env: MISSION_CONTROL_PEER_MALFORMED_URL_KEY\n  unsafe:\n    endpoint: http://127.0.0.1:${peerPort}\n    api_key_env: OPENAI_API_KEY\n  public:\n    endpoint: http://127.0.0.1:${peerPort}\n`)

  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, [serverFile], {
    env: {
      ...process.env,
      MISSION_CONTROL_API_PORT: String(port),
      MISSION_CONTROL_DATA_DIR: dataDir,
      MISSION_CONTROL_PROFILE: 'geheim.local.yaml',
      MISSION_CONTROL_PEER_A_KEY: 'agent-a-key',
      MISSION_CONTROL_PEER_B_KEY: 'agent-b-key',
      MISSION_CONTROL_PEER_TEST_KEY: 'test-peer-key',
      MISSION_CONTROL_PEER_IDLE_KEY: 'idle-peer-key',
      MISSION_CONTROL_PEER_MALFORMED_KEY: 'malformed-peer-key',
      MISSION_CONTROL_PEER_DEGRADED_KEY: 'degraded-peer-key',
      MISSION_CONTROL_PEER_CONCURRENT_KEY: 'concurrent-peer-key',
      MISSION_CONTROL_PEER_CREDENTIAL_ONLY_KEY: 'credential-only-key',
      MISSION_CONTROL_PEER_REDIRECT_KEY: 'redirect-peer-key',
      MISSION_CONTROL_PEER_MALFORMED_URL_KEY: 'malformed-url-key',
      MISSION_CONTROL_API_TOKEN: 'test-write-token',
      OPENAI_API_KEY: 'forbidden-general-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', () => {})
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

test('health meldet ok und Version ohne privaten aktiven Profilnamen', async () => {
  const { status, body } = await getJson('/api/health')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.match(body.version, /^\d+\.\d+\.\d+/)
  assert.equal(body.activeProfile, 'bonys-agents.example.yaml')
  assert.equal(body.privateValuesVisible, false)
  assert.equal(JSON.stringify(body).includes('geheim.local.yaml'), false)
})

test('health zeigt den privaten aktiven Profilnamen nur bei erlaubter Privatansicht', async () => {
  const { serverProcess, url } = await startServerProcess({
    MISSION_CONTROL_PROFILE: 'geheim.local.yaml',
    MISSION_CONTROL_SHOW_PRIVATE: 'true',
  })
  try {
    const response = await fetch(`${url}/api/health`)
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.activeProfile, 'geheim.local.yaml')
    assert.equal(body.privateValuesVisible, true)
  } finally {
    serverProcess.kill()
  }
})

test('Vite-Entwicklungsserver und Vorschau binden standardmäßig nur an Loopback', () => {
  const packageJson = JSON.parse(readFileSync(packageFile, 'utf8'))
  assert.match(packageJson.scripts.dev, /--host 127\.0\.0\.1/)
  assert.match(packageJson.scripts.preview, /--host 127\.0\.0\.1/)
  assert.doesNotMatch(packageJson.scripts.dev, /0\.0\.0\.0/)
  assert.doesNotMatch(packageJson.scripts.preview, /0\.0\.0\.0/)
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

test('Bootstrap liefert einen pfadfreien Markdown-Projektindex und lehnt verlinkte Basisordner ab', async () => {
  const indexed = await getJson('/api/bootstrap?profile=index-team.yaml')
  assert.equal(indexed.status, 200)
  assert.equal(indexed.body.projectIndex.status, 'ready')
  assert.deepEqual(indexed.body.projectIndex.documents.map((document) => document.title).sort(), [
    'Alpha Dokument',
    'Mission Übersicht',
  ])
  assert.equal(JSON.stringify(indexed.body.projectIndex).includes(dataDir), false)
  assert.equal(indexed.body.projectIndex.documents.every((document) => !('path' in document) && !('file' in document)), true)

  const unsafe = await getJson('/api/bootstrap?profile=unsafe-index-team.yaml')
  assert.equal(unsafe.status, 200)
  assert.equal(unsafe.body.projectIndex.status, 'unavailable')
  assert.deepEqual(unsafe.body.projectIndex.documents, [])
  assert.equal(JSON.stringify(unsafe.body).includes('Nicht indexieren'), false)
})

test('Setup-Wizard speichert validierte Profile ausschließlich als geschützte lokale YAML-Datei', async () => {
  const payload = wizardPayload()
  const proxiedExternal = await postJson('/api/profiles', payload, { origin: 'http://attacker.example' })
  assert.equal(proxiedExternal.status, 403)
  assert.equal(proxiedExternal.body.error, 'forbidden')

  const tokenAuthorized = await postJson('/api/profiles', { ...payload, teamName: 'Token Team' }, {
    origin: 'https://mission-control.example',
    authorization: 'Bearer test-write-token',
  })
  assert.equal(tokenAuthorized.status, 201)
  assert.equal(tokenAuthorized.body.file, 'token-team.local.yaml')

  const created = await postJson('/api/profiles', payload, localBrowserHeaders())
  assert.equal(created.status, 201)
  assert.equal(created.body.file, 'saved-team.local.yaml')

  const savedPath = path.join(dataDir, 'profiles', 'saved-team.local.yaml')
  const saved = parse(readFileSync(savedPath, 'utf8'))
  assert.equal(statSync(savedPath).mode & 0o777, 0o600)
  assert.equal(saved.name, 'Saved Team')
  assert.equal(saved.privacy.publish_safe, false)
  assert.equal(saved.privacy.contains_private_values, true)
  assert.deepEqual(saved.agents.map((agent) => agent.name), ['Atlas', 'Nova'])
  assert.ok(saved.agents.every((agent) => agent.type === 'hermes-peer'))

  const duplicate = await postJson('/api/profiles', payload, localBrowserHeaders())
  assert.equal(duplicate.status, 409)
  assert.equal(duplicate.body.error, 'profile_exists')

  const invalid = await postJson('/api/profiles', { ...payload, teamName: 'Bad\nInjected' }, localBrowserHeaders())
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error, 'invalid_profile')
})

test('gespeicherte Profile transportieren den Koordinator round-trip-sicher im Bootstrap', async () => {
  const payload = wizardPayload({
    teamName: 'Coordinator Roundtrip',
    coordinatorName: 'Atlas',
    agentNames: ['Nova', 'Atlas'],
  })
  const created = await postJson('/api/profiles', payload, localBrowserHeaders())
  assert.equal(created.status, 201)

  const { serverProcess, url } = await startServerProcess({ MISSION_CONTROL_SHOW_PRIVATE: 'true' })
  try {
    const response = await fetch(`${url}/api/bootstrap?profile=${encodeURIComponent(created.body.file)}`)
    assert.equal(response.status, 200)
    const bootstrap = await response.json()
    assert.deepEqual(bootstrap.team, { owner: 'Alice', coordinator: 'Atlas' })
  } finally {
    serverProcess.kill('SIGTERM')
  }
})

test('profilierte Schreibzugriffe über einen Proxy benötigen ein Token', async () => {
  const response = await postJsonWithRawHeaders('/api/profiles', wizardPayload({ teamName: 'Proxy Bypass' }), {
    host: '127.0.0.1:5173',
  })
  assert.equal(response.status, 403)
  assert.equal(response.body.error, 'forbidden')
})

test('direkte lokale Browserzugriffe akzeptieren IPv6-Loopback als Origin', async () => {
  const port = new URL(baseUrl).port
  const response = await postJsonWithRawHeaders('/api/profiles', wizardPayload({ teamName: 'IPv6 Local' }), {
    host: `[::1]:${port}`,
    origin: `http://[::1]:${port}`,
  })
  assert.equal(response.status, 201)
})

test('Profil-API akzeptiert nur den exakten JSON-Medientyp', async () => {
  const response = await postJson('/api/profiles', wizardPayload({ teamName: 'Bad Media Type' }), {
    'content-type': 'application/json-evil',
    authorization: 'Bearer test-write-token',
  })
  assert.equal(response.status, 415)
  assert.equal(response.body.error, 'unsupported_media_type')
})

test('Profil-API verwirft Unicode-Steuerzeichen', async () => {
  const response = await postJson('/api/profiles', wizardPayload({ teamName: 'Bad\u0085Name' }), {
    authorization: 'Bearer test-write-token',
  })
  assert.equal(response.status, 400)
  assert.equal(response.body.error, 'invalid_profile')
})

test('Profil-API verwirft kollidierende normalisierte Agenten-IDs', async () => {
  const response = await postJson('/api/profiles', wizardPayload({
    teamName: 'Colliding Agents',
    coordinatorName: 'A B',
    agentNames: ['A B', 'A-B'],
  }), {
    authorization: 'Bearer test-write-token',
  })
  assert.equal(response.status, 400)
  assert.equal(response.body.error, 'invalid_profile')
})

test('Profil-API verlangt den Koordinator in der Agentenliste', async () => {
  const response = await postJson('/api/profiles', wizardPayload({
    teamName: 'Missing Coordinator',
    coordinatorName: 'Ghost',
  }), {
    authorization: 'Bearer test-write-token',
  })
  assert.equal(response.status, 400)
  assert.equal(response.body.error, 'invalid_profile')
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

test('authentifizierte Detailprüfungen folgen keinen Redirects und der Fallback bleibt ohne Authorization', async () => {
  const { status, body } = await getJson('/api/bootstrap?profile=redirect-team.yaml')
  const agent = body.agents.find((item) => item.name === 'Redirect')
  assert.equal(status, 200)
  assert.equal(agent.status, 'online')
  assert.equal(agent.activitySource, 'reachability')
  assert.equal(redirectTargetRequests, 0)
  assert.equal(redirectFallbackAuthorizationSeen, false)
  assert.equal(JSON.stringify(body).includes('redirect-peer-key'), false)
})

test('ungültige private Peer-URLs enden ohne Credential-Leak sauber offline', async () => {
  const { status, body } = await getJson('/api/bootstrap?profile=malformed-url-team.yaml')
  const agent = body.agents.find((item) => item.name === 'Malformed URL')
  assert.equal(status, 200)
  assert.equal(agent.status, 'offline')
  assert.equal(agent.activitySource, 'reachability')
  assert.equal(JSON.stringify(body).includes('MISSION_CONTROL_PEER_MALFORMED_URL_KEY'), false)
  assert.equal(JSON.stringify(body).includes('malformed-url-key'), false)
  assert.equal(JSON.stringify(body).includes('http://['), false)
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

test('parallele Profilerstellung erzeugt genau eine Datei ohne Überschreiben', async () => {
  const payload = wizardPayload({ teamName: 'Concurrent Save' })
  const responses = await Promise.all([
    postJson('/api/profiles', payload, { authorization: 'Bearer test-write-token' }),
    postJson('/api/profiles', payload, { authorization: 'Bearer test-write-token' }),
  ])
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409])

  const savedPath = path.join(dataDir, 'profiles', 'concurrent-save.local.yaml')
  const saved = parse(readFileSync(savedPath, 'utf8'))
  assert.equal(saved.name, 'Concurrent Save')
  assert.equal(statSync(savedPath).mode & 0o777, 0o600)
})

test('Missionen werden profilbezogen angelegt und dauerhaft gelistet', async () => {
  const created = await postJson('/api/missions', {
    profile: 'public-team.yaml',
    title: 'Dokumentation fertigstellen',
    description: 'Die Bedienung des Mission Boards dokumentieren.',
    owner: 'Public',
  }, { authorization: 'Bearer test-write-token' })

  assert.equal(created.status, 201)
  assert.match(created.body.mission.id, /^mission-[a-f0-9-]+$/)
  assert.equal(created.body.mission.profile, 'public-team.yaml')
  assert.equal(created.body.mission.state, 'planned')

  const listed = await getJson('/api/missions?profile=public-team.yaml')
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.body.missions, [created.body.mission])

  const stored = JSON.parse(readFileSync(path.join(dataDir, 'missions.json'), 'utf8'))
  assert.deepEqual(stored.missions, [created.body.mission])
})

test('externe Backend-Bindung schützt GET /api/missions mit Token, Loopback bleibt lesbar', async () => {
  const { serverProcess, url } = await startServerProcess({
    MISSION_CONTROL_API_HOST: '0.0.0.0',
    MISSION_CONTROL_API_TOKEN: 'mission-read-token',
  })
  try {
    const denied = await fetch(`${url}/api/missions?profile=public-team.yaml`)
    assert.equal(denied.status, 403)
    const wrong = await fetch(`${url}/api/missions?profile=public-team.yaml`, {
      headers: { authorization: 'Bearer wrong-token' },
    })
    assert.equal(wrong.status, 403)
    const allowed = await fetch(`${url}/api/missions?profile=public-team.yaml`, {
      headers: { authorization: 'Bearer mission-read-token' },
    })
    assert.equal(allowed.status, 200)
  } finally {
    serverProcess.kill('SIGTERM')
  }
})
test('Missionen lassen sich einem Agenten zuweisen und im Status ändern', async () => {
  const created = await postJson('/api/missions', {
    profile: 'idle-team.yaml',
    title: 'Peer prüfen',
    description: 'Den Leerlaufstatus des Peers prüfen.',
    owner: 'Idle',
  }, { authorization: 'Bearer test-write-token' })
  assert.equal(created.status, 201)

  const updated = await patchJson(`/api/missions/${created.body.mission.id}`, {
    profile: 'idle-team.yaml',
    owner: 'Operator',
    state: 'running',
  }, { authorization: 'Bearer test-write-token' })

  assert.equal(updated.status, 200)
  assert.equal(updated.body.mission.owner, 'Operator')
  assert.equal(updated.body.mission.state, 'running')
  assert.notEqual(updated.body.mission.updatedAt, created.body.mission.updatedAt)

  const listed = await getJson('/api/missions?profile=idle-team.yaml')
  assert.deepEqual(listed.body.missions, [updated.body.mission])
})

test('Missionen können Titel und Beschreibung nachträglich ändern', async () => {
  const created = await postJson('/api/missions', {
    profile: 'idle-team.yaml',
    title: 'Alte Mission',
    description: 'Alte Beschreibung',
    result: '',
    owner: 'Idle',
  }, { authorization: 'Bearer test-write-token' })
  assert.equal(created.status, 201)

  const updated = await patchJson(`/api/missions/${created.body.mission.id}`, {
    profile: 'idle-team.yaml',
    title: 'Task Brief vorbereiten',
    description: 'Klares Ziel und erwartetes Ergebnis festhalten.',
    result: 'Task Brief liegt zur Prüfung bereit.',
    resultKind: 'file',
  }, { authorization: 'Bearer test-write-token' })

  assert.equal(updated.status, 200)
  assert.equal(updated.body.mission.title, 'Task Brief vorbereiten')
  assert.equal(updated.body.mission.description, 'Klares Ziel und erwartetes Ergebnis festhalten.')
  assert.equal(updated.body.mission.result, 'Task Brief liegt zur Prüfung bereit.')
  assert.equal(updated.body.mission.resultKind, 'file')
  assert.notEqual(updated.body.mission.updatedAt, created.body.mission.updatedAt)

  const cleared = await patchJson(`/api/missions/${created.body.mission.id}`, {
    profile: 'idle-team.yaml',
    result: '',
  }, { authorization: 'Bearer test-write-token' })
  assert.equal(cleared.status, 200)
  assert.equal(Object.prototype.hasOwnProperty.call(cleared.body.mission, 'result'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(cleared.body.mission, 'resultKind'), false)
  const storedMissions = JSON.parse(readFileSync(path.join(dataDir, 'missions.json'), 'utf8')).missions
  const storedCleared = storedMissions.find((mission) => mission.id === created.body.mission.id)
  assert.equal(Object.prototype.hasOwnProperty.call(storedCleared, 'resultKind'), false)

  const invalid = await patchJson(`/api/missions/${created.body.mission.id}`, {
    profile: 'idle-team.yaml',
    title: '   ',
  }, { authorization: 'Bearer test-write-token' })
  assert.equal(invalid.status, 400)

  const invalidKind = await patchJson(`/api/missions/${created.body.mission.id}`, {
    profile: 'idle-team.yaml',
    result: 'untrusted result marker',
    resultKind: 'script',
  }, { authorization: 'Bearer test-write-token' })
  assert.equal(invalidKind.status, 400)
})

test('eine Mission startet genau einen idempotenten Hermes-Auftrag und speichert Run-Metadaten', async () => {
  runRequests = []
  const created = await postJson('/api/missions', {
    profile: 'idle-team.yaml',
    title: 'Peer-Auftrag testen',
    description: 'Einen echten Hermes-Run starten.',
    owner: 'Idle',
  }, { authorization: 'Bearer test-write-token' })
  assert.equal(created.status, 201)

  const first = await postJson(`/api/missions/${created.body.mission.id}/run`, { profile: 'idle-team.yaml' }, {
    authorization: 'Bearer test-write-token',
  })
  assert.equal(first.status, 202)
  assert.equal(first.body.mission.runId, 'run-test-123')
  assert.equal(first.body.mission.agentId, 'idle')
  assert.equal(first.body.mission.runStatus, 'running')
  const firstHistoryKeys = Object.keys(first.body.mission.runHistory[0]).sort()
  assert.deepEqual(firstHistoryKeys.filter((key) => key !== 'runId'), ['agentId', 'attempt', 'startedAt', 'status'])
  if (firstHistoryKeys.includes('runId')) assert.equal(first.body.mission.runHistory[0].runId, 'run-test-123')
  assert.equal(JSON.stringify(first.body.mission.runHistory).includes('private'), false)
  assert.equal(JSON.stringify(first.body.mission.runHistory).includes('idle-peer-key'), false)

  const second = await postJson(`/api/missions/${created.body.mission.id}/run`, { profile: 'idle-team.yaml' }, {
    authorization: 'Bearer test-write-token',
  })
  assert.equal(second.status, 202)
  assert.deepEqual(second.body.mission, first.body.mission)
  assert.equal(runRequests.length, 1)
  assert.equal(runRequests[0].authorization, 'Bearer idle-peer-key')
  assert.equal(runRequests[0].body.input, 'Peer-Auftrag testen\\n\\nEinen echten Hermes-Run starten.')
  assert.equal(runRequests[0].idempotency, first.body.mission.idempotencyKey)
  assert.equal(JSON.stringify(second.body).includes('idle-peer-key'), false)

  const stored = JSON.parse(readFileSync(path.join(dataDir, 'missions.json'), 'utf8'))
  assert.equal(stored.missions[stored.missions.length - 1].runId, 'run-test-123')
})

test('parallele Server-Starts teilen den kompletten Peer-Start und liefern dieselbe Antwort', async () => {
  runRequests = []
  const created = await postJson('/api/missions', {
    profile: 'idle-team.yaml',
    title: 'Parallelen Start testen',
    owner: 'Idle',
  }, { authorization: 'Bearer test-write-token' })
  let release
  releaseRunStart = new Promise((resolve) => { release = resolve })
  runStartStarted = new Promise((resolve) => { runStartStartedResolve = resolve })
  try {
    const first = postJson(`/api/missions/${created.body.mission.id}/run`, { profile: 'idle-team.yaml' }, { authorization: 'Bearer test-write-token' })
    const second = postJson(`/api/missions/${created.body.mission.id}/run`, { profile: 'idle-team.yaml' }, { authorization: 'Bearer test-write-token' })
    await runStartStarted
    assert.equal(runRequests.length, 1)
    release()
    const responses = await Promise.all([first, second])
    assert.equal(responses[0].status, 202)
    assert.deepEqual(responses[0].body, responses[1].body)
    assert.equal(runRequests.length, 1)
  } finally {
    releaseRunStart = undefined
    runStartStartedResolve = undefined
    runStartStarted = Promise.resolve()
  }
})

test('starting-Recovery ohne runId verwendet serverseitig denselben Attempt, Key und History-Eintrag', async () => {
  runRequests = []
  const created = await postJson('/api/missions', {
    profile: 'idle-team.yaml',
    title: 'Recovery testen',
    owner: 'Idle',
  }, { authorization: 'Bearer test-write-token' })
  const storePath = path.join(dataDir, 'missions.json')
  const store = JSON.parse(readFileSync(storePath, 'utf8'))
  const storedMission = store.missions.find((mission) => mission.id === created.body.mission.id)
  Object.assign(storedMission, {
    runAttempt: 7,
    runStatus: 'starting',
    agentId: 'idle',
    runStartedAt: '2026-10-17T10:00:00.000Z',
    runHistory: [{ attempt: 7, agentId: 'idle', status: 'starting', startedAt: '2026-10-17T10:00:00.000Z' }],
  })
  delete storedMission.runId
  delete storedMission.idempotencyKey
  writeFileSync(storePath, JSON.stringify(store, null, 2))

  const responses = await Promise.all([
    postJson(`/api/missions/${created.body.mission.id}/run`, { profile: 'idle-team.yaml' }, { authorization: 'Bearer test-write-token' }),
    postJson(`/api/missions/${created.body.mission.id}/run`, { profile: 'idle-team.yaml' }, { authorization: 'Bearer test-write-token' }),
  ])
  assert.equal(responses[0].status, 202)
  assert.deepEqual(responses[0].body, responses[1].body)
  assert.equal(responses[0].body.mission.runAttempt, 7)
  assert.equal(responses[0].body.mission.idempotencyKey, `mission:${created.body.mission.id}:run:v7`)
  assert.deepEqual(responses[0].body.mission.runHistory.map((entry) => entry.attempt), [7])
  assert.equal(runRequests.length, 1)
})

test('Server-Recovery nimmt den höchsten History-Attempt, bleibt bei Wiederholung replay-only und reserviert v5 erst beim expliziten Rerun', async () => {
  runRequests = []
  const created = await postJson('/api/missions', {
    profile: 'idle-team.yaml',
    title: 'Monotone Recovery testen',
    owner: 'Idle',
  }, { authorization: 'Bearer test-write-token' })
  const storePath = path.join(dataDir, 'missions.json')
  const store = JSON.parse(readFileSync(storePath, 'utf8'))
  const storedMission = store.missions.find((mission) => mission.id === created.body.mission.id)
  Object.assign(storedMission, {
    runAttempt: 3,
    runStatus: 'starting',
    agentId: 'idle',
    runStartedAt: '2026-10-17T09:00:00.000Z',
    idempotencyKey: `mission:${created.body.mission.id}:run:v3`,
    runHistory: [{ attempt: 4, agentId: 'idle', status: 'starting', startedAt: '2026-10-17T10:00:00.000Z' }],
  })
  delete storedMission.runId
  writeFileSync(storePath, JSON.stringify(store, null, 2))

  const recoveries = await Promise.all([
    postJson(`/api/missions/${created.body.mission.id}/run`, { profile: 'idle-team.yaml' }, { authorization: 'Bearer test-write-token' }),
    postJson(`/api/missions/${created.body.mission.id}/run`, { profile: 'idle-team.yaml' }, { authorization: 'Bearer test-write-token' }),
  ])
  assert.equal(recoveries[0].status, 202)
  assert.deepEqual(recoveries[0].body, recoveries[1].body)
  assert.equal(recoveries[0].body.mission.runAttempt, 4)
  assert.equal(recoveries[0].body.mission.idempotencyKey, `mission:${created.body.mission.id}:run:v4`)
  assert.equal(recoveries[0].body.mission.agentId, 'idle')
  assert.equal(recoveries[0].body.mission.runStartedAt, '2026-10-17T10:00:00.000Z')
  assert.deepEqual(recoveries[0].body.mission.runHistory.map((entry) => entry.attempt), [4])
  assert.equal(runRequests.length, 1)
  assert.equal(runRequests[0].idempotency, `mission:${created.body.mission.id}:run:v4`)
  assert.equal(runRequests[0].idempotency.includes(':v3'), false)

  const terminalStore = JSON.parse(readFileSync(storePath, 'utf8'))
  const terminalMission = terminalStore.missions.find((mission) => mission.id === created.body.mission.id)
  Object.assign(terminalMission, { runStatus: 'completed', runFinishedAt: '2026-10-17T10:01:00.000Z' })
  terminalMission.runHistory[0].status = 'completed'
  terminalMission.runHistory[0].finishedAt = terminalMission.runFinishedAt
  writeFileSync(storePath, JSON.stringify(terminalStore, null, 2))

  const rerun = await postJson(`/api/missions/${created.body.mission.id}/run`, { profile: 'idle-team.yaml' }, { authorization: 'Bearer test-write-token' })
  assert.equal(rerun.status, 202)
  assert.equal(rerun.body.mission.runAttempt, 5)
  assert.equal(rerun.body.mission.idempotencyKey, `mission:${created.body.mission.id}:run:v5`)
  assert.equal(runRequests.length, 2)
  assert.equal(runRequests[1].idempotency, `mission:${created.body.mission.id}:run:v5`)
})

test('starting-Recovery mit vorhandenem History-Eintrag persistiert Attempt, Key und RunId am selben Attempt', async () => {
  runRequests = []
  const created = await postJson('/api/missions', {
    profile: 'idle-team.yaml',
    title: 'Recovery mit Key testen',
    owner: 'Idle',
  }, { authorization: 'Bearer test-write-token' })
  const storePath = path.join(dataDir, 'missions.json')
  const store = JSON.parse(readFileSync(storePath, 'utf8'))
  const storedMission = store.missions.find((mission) => mission.id === created.body.mission.id)
  Object.assign(storedMission, {
    runStatus: 'starting',
    agentId: 'idle',
    runStartedAt: '2026-10-17T10:00:00.000Z',
    idempotencyKey: `mission:${created.body.mission.id}:run:v7`,
    runHistory: [{ attempt: 7, agentId: 'idle', status: 'starting', startedAt: '2026-10-17T10:00:00.000Z' }],
  })
  delete storedMission.runAttempt
  delete storedMission.runId
  writeFileSync(storePath, JSON.stringify(store, null, 2))

  const response = await postJson(`/api/missions/${created.body.mission.id}/run`, { profile: 'idle-team.yaml' }, { authorization: 'Bearer test-write-token' })
  assert.equal(response.status, 202)
  assert.equal(response.body.mission.runAttempt, 7)
  assert.equal(response.body.mission.idempotencyKey, `mission:${created.body.mission.id}:run:v7`)
  assert.equal(response.body.mission.runId, 'run-test-123')
  assert.equal(response.body.mission.runStatus, 'running')
  assert.deepEqual(response.body.mission.runHistory.map((entry) => entry.attempt), [7])
  assert.equal(runRequests.length, 1)
  assert.equal(runRequests[0].idempotency, response.body.mission.idempotencyKey)

  const persisted = JSON.parse(readFileSync(storePath, 'utf8')).missions.find((mission) => mission.id === created.body.mission.id)
  assert.equal(persisted.runAttempt, 7)
  assert.equal(persisted.runId, 'run-test-123')
  assert.equal(persisted.runStatus, 'running')
  assert.deepEqual(persisted.runHistory.map((entry) => entry.attempt), [7])
})

test('Recovery-Fehler setzt den gefenceten Attempt generisch auf failed', async () => {
  const created = await postJson('/api/missions', {
    profile: 'idle-team.yaml',
    title: 'Recovery-Fehler testen',
    owner: 'Idle',
  }, { authorization: 'Bearer test-write-token' })
  const storePath = path.join(dataDir, 'missions.json')
  const store = JSON.parse(readFileSync(storePath, 'utf8'))
  const storedMission = store.missions.find((mission) => mission.id === created.body.mission.id)
  Object.assign(storedMission, { runAttempt: 3, runStatus: 'starting', agentId: 'idle', runHistory: [{ attempt: 3, agentId: 'idle', status: 'starting' }] })
  delete storedMission.runId
  delete storedMission.idempotencyKey
  writeFileSync(storePath, JSON.stringify(store, null, 2))
  runResponseBody = '{"status":"started"}'
  try {
    const response = await postJson(`/api/missions/${created.body.mission.id}/run`, { profile: 'idle-team.yaml' }, { authorization: 'Bearer test-write-token' })
    assert.equal(response.status, 502)
    const listed = await getJson('/api/missions?profile=idle-team.yaml')
    const current = listed.body.missions.find((mission) => mission.id === created.body.mission.id)
    assert.equal(current.runAttempt, 3)
    assert.equal(current.runStatus, 'failed')
    assert.equal(current.runError, 'peer_run_failed')
    assert.equal(current.runId, undefined)
  } finally {
    runResponseBody = undefined
  }
})

test('ein widersprüchliches Peer-runId-Ergebnis bindet keine doppelte runId und scheitert generisch', async () => {
  const created = await postJson('/api/missions', {
    profile: 'idle-team.yaml',
    title: 'runId-Konflikt testen',
    owner: 'Idle',
  }, { authorization: 'Bearer test-write-token' })
  const storePath = path.join(dataDir, 'missions.json')
  const store = JSON.parse(readFileSync(storePath, 'utf8'))
  const storedMission = store.missions.find((mission) => mission.id === created.body.mission.id)
  Object.assign(storedMission, {
    runAttempt: 2,
    runStatus: 'starting',
    agentId: 'idle',
    runHistory: [{ attempt: 1, runId: 'run-test-123', status: 'completed' }, { attempt: 2, agentId: 'idle', status: 'starting' }],
    idempotencyKey: `mission:${created.body.mission.id}:run:v2`,
  })
  delete storedMission.runId
  writeFileSync(storePath, JSON.stringify(store, null, 2))
  runResponseBody = '{"run_id":"run-test-123","status":"running"}'
  try {
    const response = await postJson(`/api/missions/${created.body.mission.id}/run`, { profile: 'idle-team.yaml' }, { authorization: 'Bearer test-write-token' })
    assert.equal(response.status, 202)
    assert.equal(response.body.mission.runStatus, 'failed')
    assert.equal(response.body.mission.runError, 'peer_run_failed')
    assert.equal(response.body.mission.runId, undefined)
    assert.equal(response.body.mission.runHistory.filter((entry) => entry.runId === 'run-test-123').length, 1)
  } finally {
    runResponseBody = undefined
  }
})

test('terminale Missionen erlauben genau einen sicheren Rerun mit neuem Versuch und Idempotency-Key', async () => {
  runRequests = []
  const created = await postJson('/api/missions', {
    profile: 'idle-team.yaml',
    title: 'Rerun testen',
    description: 'Einen terminalen Versuch erneut starten.',
    owner: 'Idle',
  }, { authorization: 'Bearer test-write-token' })
  const first = await postJson(`/api/missions/${created.body.mission.id}/run`, { profile: 'idle-team.yaml' }, {
    authorization: 'Bearer test-write-token',
  })
  assert.equal(first.body.mission.runAttempt, 1)
  assert.equal(first.body.mission.idempotencyKey, `mission:${created.body.mission.id}:run:v1`)

  const stored = JSON.parse(readFileSync(path.join(dataDir, 'missions.json'), 'utf8'))
  const storedMission = stored.missions.find((mission) => mission.id === created.body.mission.id)
  const terminalAt = new Date().toISOString()
  Object.assign(storedMission, {
    runId: 'old-run',
    runStatus: 'completed',
    runFinishedAt: terminalAt,
    runError: 'old-error',
    agentId: 'old-agent',
    runHistory: [{
      attempt: 1,
      runId: 'old-run',
      agentId: 'old-agent',
      status: 'completed',
      startedAt: storedMission.runStartedAt,
      finishedAt: terminalAt,
    }],
  })
  writeFileSync(path.join(dataDir, 'missions.json'), JSON.stringify(stored, null, 2))

  const reruns = await Promise.all([
    postJson(`/api/missions/${created.body.mission.id}/run`, { profile: 'idle-team.yaml' }, { authorization: 'Bearer test-write-token' }),
    postJson(`/api/missions/${created.body.mission.id}/run`, { profile: 'idle-team.yaml' }, { authorization: 'Bearer test-write-token' }),
  ])
  assert.equal(reruns[0].status, 202)
  assert.equal(reruns[1].status, 202)
  assert.equal(reruns[1].body.mission.runAttempt, 2)
  assert.equal(reruns[1].body.mission.idempotencyKey, reruns[0].body.mission.idempotencyKey)
  assert.equal(reruns[1].body.mission.agentId, 'idle')
  assert.ok(['starting', 'running'].includes(reruns[1].body.mission.runStatus))
  assert.equal(reruns[0].body.mission.runError, undefined)
  assert.equal(reruns[0].body.mission.agentId, 'idle')
  assert.equal(reruns[0].body.mission.idempotencyKey, `mission:${created.body.mission.id}:run:v2`)
  assert.equal(runRequests.length, 2)
  assert.equal(runRequests[1].idempotency, `mission:${created.body.mission.id}:run:v2`)

  const listed = await getJson('/api/missions?profile=idle-team.yaml')
  const current = listed.body.missions.find((mission) => mission.id === created.body.mission.id)
  assert.equal(current.runAttempt, 2)
  assert.equal(current.runStatus, 'running')
  assert.equal(current.runError, undefined)
})
test('Legacy-terminale Mission ohne runAttempt setzt den Rerun auf v2 und bindet den Key an die Mission', async () => {
  runRequests = []
  const created = await postJson('/api/missions', {
    profile: 'idle-team.yaml',
    title: 'Legacy-Rerun testen',
    description: 'Eine alte Mission ohne runAttempt erneut starten.',
    owner: 'Idle',
  }, { authorization: 'Bearer test-write-token' })
  const stored = JSON.parse(readFileSync(path.join(dataDir, 'missions.json'), 'utf8'))
  const storedMission = stored.missions.find((mission) => mission.id === created.body.mission.id)
  Object.assign(storedMission, {
    runId: 'legacy-run',
    runStatus: 'completed',
    idempotencyKey: `mission:${created.body.mission.id}:run:v1`,
  })
  delete storedMission.runAttempt
  writeFileSync(path.join(dataDir, 'missions.json'), JSON.stringify(stored, null, 2))

  const rerun = await postJson(`/api/missions/${created.body.mission.id}/run`, { profile: 'idle-team.yaml' }, {
    authorization: 'Bearer test-write-token',
  })

  assert.equal(rerun.status, 202)
  assert.equal(rerun.body.mission.runAttempt, 2)
  assert.equal(rerun.body.mission.idempotencyKey, `mission:${created.body.mission.id}:run:v2`)
  assert.equal(runRequests.length, 1)
  assert.equal(runRequests[0].idempotency, `mission:${created.body.mission.id}:run:v2`)
})

test('Legacy-terminaler Top-Level-Run wird beim Server-Rerun als Attempt 1 gesichert und finishedAt behalten', async () => {
  runRequests = []
  const created = await postJson('/api/missions', {
    profile: 'idle-team.yaml',
    title: 'Legacy-Backfill mit finishedAt',
    owner: 'Idle',
  }, { authorization: 'Bearer test-write-token' })
  const stored = JSON.parse(readFileSync(path.join(dataDir, 'missions.json'), 'utf8'))
  const storedMission = stored.missions.find((mission) => mission.id === created.body.mission.id)
  Object.assign(storedMission, {
    runId: 'legacy-terminal-run',
    runStatus: 'completed',
    agentId: 'legacy-agent',
    runStartedAt: '2026-10-16T10:00:00.000Z',
    runFinishedAt: '2026-10-16T10:01:00.000Z',
    idempotencyKey: `mission:${created.body.mission.id}:run:v1`,
  })
  delete storedMission.runAttempt
  delete storedMission.runHistory
  writeFileSync(path.join(dataDir, 'missions.json'), JSON.stringify(stored, null, 2))

  const rerun = await postJson(`/api/missions/${created.body.mission.id}/run`, { profile: 'idle-team.yaml' }, {
    authorization: 'Bearer test-write-token',
  })
  assert.equal(rerun.status, 202)
  assert.equal(rerun.body.mission.runAttempt, 2)
  assert.equal(rerun.body.mission.runHistory[0].attempt, 1)
  assert.equal(rerun.body.mission.runHistory[0].finishedAt, '2026-10-16T10:01:00.000Z')
})
test('Legacy-Mission mit runId ohne runStatus bleibt fail-closed replayed und startet keinen Peer-Run', async () => {
  runRequests = []
  const created = await postJson('/api/missions', {
    profile: 'idle-team.yaml',
    title: 'Legacy-Replay testen',
    description: 'Eine alte Mission ohne runStatus nicht erneut starten.',
    owner: 'Idle',
  }, { authorization: 'Bearer test-write-token' })
  const stored = JSON.parse(readFileSync(path.join(dataDir, 'missions.json'), 'utf8'))
  const storedMission = stored.missions.find((mission) => mission.id === created.body.mission.id)
  Object.assign(storedMission, { runId: 'legacy-active-run' })
  delete storedMission.runStatus
  delete storedMission.runAttempt
  writeFileSync(path.join(dataDir, 'missions.json'), JSON.stringify(stored, null, 2))

  const replayed = await postJson(`/api/missions/${created.body.mission.id}/run`, { profile: 'idle-team.yaml' }, {
    authorization: 'Bearer test-write-token',
  })

  assert.equal(replayed.status, 202)
  assert.equal(replayed.body.mission.runId, 'legacy-active-run')
  assert.equal(replayed.body.mission.runAttempt, undefined)
  assert.equal(runRequests.length, 0)
})

test('brandneue Mission ohne Run-Historie beginnt mit v1', async () => {
  runRequests = []
  const created = await postJson('/api/missions', {
    profile: 'idle-team.yaml',
    title: 'Neuen Run testen',
    description: 'Eine brandneue Mission starten.',
    owner: 'Idle',
  }, { authorization: 'Bearer test-write-token' })

  const started = await postJson(`/api/missions/${created.body.mission.id}/run`, { profile: 'idle-team.yaml' }, {
    authorization: 'Bearer test-write-token',
  })

  assert.equal(started.status, 202)
  assert.equal(started.body.mission.runAttempt, 1)
  assert.equal(started.body.mission.idempotencyKey, `mission:${created.body.mission.id}:run:v1`)
})

test('Legacy-Key-Versionen werden monoton fortgesetzt und fremde Idempotency-Strings ignoriert', async () => {
  runRequests = []
  const versioned = await postJson('/api/missions', {
    profile: 'idle-team.yaml',
    title: 'Legacy-Version fortsetzen',
    owner: 'Idle',
  }, { authorization: 'Bearer test-write-token' })
  const foreign = await postJson('/api/missions', {
    profile: 'idle-team.yaml',
    title: 'Fremden Key ignorieren',
    owner: 'Idle',
  }, { authorization: 'Bearer test-write-token' })
  const stored = JSON.parse(readFileSync(path.join(dataDir, 'missions.json'), 'utf8'))
  const versionedMission = stored.missions.find((mission) => mission.id === versioned.body.mission.id)
  Object.assign(versionedMission, {
    runStatus: 'completed',
    idempotencyKey: `mission:${versioned.body.mission.id}:run:v7`,
  })
  delete versionedMission.runAttempt
  const foreignMission = stored.missions.find((mission) => mission.id === foreign.body.mission.id)
  Object.assign(foreignMission, {
    runStatus: 'completed',
    idempotencyKey: 'mission:another-mission:run:v9',
  })
  delete foreignMission.runAttempt
  writeFileSync(path.join(dataDir, 'missions.json'), JSON.stringify(stored, null, 2))

  const continued = await postJson(`/api/missions/${versioned.body.mission.id}/run`, { profile: 'idle-team.yaml' }, {
    authorization: 'Bearer test-write-token',
  })
  const fresh = await postJson(`/api/missions/${foreign.body.mission.id}/run`, { profile: 'idle-team.yaml' }, {
    authorization: 'Bearer test-write-token',
  })

  assert.equal(continued.body.mission.runAttempt, 8)
  assert.equal(continued.body.mission.idempotencyKey, `mission:${versioned.body.mission.id}:run:v8`)
  assert.equal(fresh.body.mission.runAttempt, 1)
  assert.equal(fresh.body.mission.idempotencyKey, `mission:${foreign.body.mission.id}:run:v1`)
})

test('gespeicherte Hermes-runIds werden abgefragt und der terminale Status wird persistiert', async () => {
  runRequests = []
  runStatusRequests = []
  const created = await postJson('/api/missions', {
    profile: 'idle-team.yaml',
    title: 'Run-Status verfolgen',
    description: 'Den gespeicherten Hermes-Run bis zum Abschluss verfolgen.',
    owner: 'Idle',
  }, { authorization: 'Bearer test-write-token' })
  const started = await postJson(`/api/missions/${created.body.mission.id}/run`, { profile: 'idle-team.yaml' }, {
    authorization: 'Bearer test-write-token',
  })
  assert.equal(started.status, 202)

  const polled = await postJson(`/api/missions/${created.body.mission.id}/run/status`, { profile: 'idle-team.yaml' }, {
    authorization: 'Bearer test-write-token',
  })
  assert.equal(polled.status, 200)
  assert.equal(polled.body.mission.runId, 'run-test-123')
  assert.equal(polled.body.mission.runStatus, 'completed')
  assert.equal(JSON.stringify(polled.body).includes('private peer output'), false)
  assert.deepEqual(runStatusRequests, [{ authorization: 'Bearer idle-peer-key' }])

  const replayed = await postJson(`/api/missions/${created.body.mission.id}/run/status`, { profile: 'idle-team.yaml' }, {
    authorization: 'Bearer test-write-token',
  })
  assert.equal(replayed.status, 200)
  assert.deepEqual(replayed.body.mission, polled.body.mission)
  assert.equal(runStatusRequests.length, 1)

  const stored = JSON.parse(readFileSync(path.join(dataDir, 'missions.json'), 'utf8'))
  const storedMission = stored.missions.find((mission) => mission.id === created.body.mission.id)
  assert.equal(storedMission.runStatus, 'completed')
})

test('eine laufende Mission lässt sich über die gespeicherte Hermes-runId stoppen', async () => {
  const created = await postJson('/api/missions', {
    profile: 'idle-team.yaml',
    title: 'Run stoppen',
    description: 'Einen laufenden Hermes-Run stoppen.',
    owner: 'Idle',
  }, { authorization: 'Bearer test-write-token' })
  assert.equal(created.status, 201)

  const unauthorized = await postJson(`/api/missions/${created.body.mission.id}/run/stop`, { profile: 'idle-team.yaml' }, {
    origin: 'https://attacker.example',
  })
  assert.equal(unauthorized.status, 403)
  assert.equal(runStopRequests.length, 0)

  const started = await postJson(`/api/missions/${created.body.mission.id}/run`, { profile: 'idle-team.yaml' }, {
    authorization: 'Bearer test-write-token',
  })
  assert.equal(started.status, 202)

  const reassigned = await patchJson(`/api/missions/${created.body.mission.id}`, {
    profile: 'idle-team.yaml',
    owner: 'Operator',
  }, { authorization: 'Bearer test-write-token' })
  assert.equal(reassigned.status, 200)

  const stopped = await postJson(`/api/missions/${created.body.mission.id}/run/stop`, { profile: 'idle-team.yaml' }, {
    authorization: 'Bearer test-write-token',
  })
  assert.equal(stopped.status, 200)
  assert.equal(stopped.body.mission.runId, 'run-test-123')
  assert.equal(stopped.body.mission.runStatus, 'cancelled')
  assert.equal(JSON.stringify(stopped.body).includes('private stop output'), false)
  assert.deepEqual(runStopRequests.at(-1), {
    method: 'POST',
    authorization: 'Bearer idle-peer-key',
    url: '/v1/runs/run-test-123/stop',
  })

  const stored = JSON.parse(readFileSync(path.join(dataDir, 'missions.json'), 'utf8'))
  const storedMission = stored.missions.find((mission) => mission.id === created.body.mission.id)
  assert.equal(storedMission.runStatus, 'cancelled')

  const replayed = await postJson(`/api/missions/${created.body.mission.id}/run/stop`, { profile: 'idle-team.yaml' }, {
    authorization: 'Bearer test-write-token',
  })
  assert.equal(replayed.status, 200)
  assert.deepEqual(replayed.body.mission, stopped.body.mission)
  assert.equal(runStopRequests.length, 1)
})

test('ein verspäteter Status-Poll darf einen bestätigten Stop nicht serverseitig zurückstufen', async () => {
  const created = await postJson('/api/missions', {
    profile: 'idle-team.yaml',
    title: 'Konkurrierenden Run-Status testen',
    description: 'Ein verspäteter Poll darf keinen bestätigten Stop überschreiben.',
    owner: 'Idle',
  }, { authorization: 'Bearer test-write-token' })
  const started = await postJson(`/api/missions/${created.body.mission.id}/run`, { profile: 'idle-team.yaml' }, {
    authorization: 'Bearer test-write-token',
  })
  assert.equal(started.body.mission.runStatus, 'running')

  let release
  releaseRunStatus = new Promise((resolve) => {
    release = resolve
  })
  runStatusStarted = new Promise((resolve) => {
    runStatusStartedResolve = resolve
  })
  runStatusResponse = '{"object":"hermes.run","run_id":"run-test-123","status":"completed"}'

  try {
    const delayedPoll = postJson(`/api/missions/${created.body.mission.id}/run/status`, { profile: 'idle-team.yaml' }, {
      authorization: 'Bearer test-write-token',
    })
    await runStatusStarted

    const stopped = await postJson(`/api/missions/${created.body.mission.id}/run/stop`, { profile: 'idle-team.yaml' }, {
      authorization: 'Bearer test-write-token',
    })
    assert.equal(stopped.status, 200)
    assert.equal(stopped.body.mission.runStatus, 'cancelled')

    release()
    const polled = await delayedPoll
    assert.equal(polled.status, 200)
    assert.equal(polled.body.mission.runStatus, 'cancelled')

    const listed = await getJson('/api/missions?profile=idle-team.yaml')
    const stored = listed.body.missions.find((mission) => mission.id === created.body.mission.id)
    assert.equal(stored.runStatus, 'cancelled')
  } finally {
    releaseRunStatus = undefined
    runStatusStartedResolve = undefined
    runStatusStarted = Promise.resolve()
    runStatusResponse = '{"object":"hermes.run","run_id":"run-test-123","status":"completed","output":"private peer output"}'
  }
})


test('Stop-Fehler liefern nur einen generischen Fehler und bewahren den letzten bestätigten Zustand', async () => {
  const created = await postJson('/api/missions', {
    profile: 'idle-team.yaml',
    title: 'Fehler beim Stoppen',
    description: 'Der bestätigte Zustand darf nicht überschrieben werden.',
    owner: 'Idle',
  }, { authorization: 'Bearer test-write-token' })
  const started = await postJson(`/api/missions/${created.body.mission.id}/run`, { profile: 'idle-team.yaml' }, {
    authorization: 'Bearer test-write-token',
  })
  assert.equal(started.body.mission.runStatus, 'running')

  runStopResponse = '{"run_id":"anderer-run","status":"completed","error":"private peer failure"}'
  try {
    const stopped = await postJson(`/api/missions/${created.body.mission.id}/run/stop`, { profile: 'idle-team.yaml' }, {
      authorization: 'Bearer test-write-token',
    })
    assert.equal(stopped.status, 502)
    assert.deepEqual(stopped.body, { error: 'peer_run_stop_failed' })
    assert.equal(JSON.stringify(stopped.body).includes('private peer failure'), false)

    const listed = await getJson('/api/missions?profile=idle-team.yaml')
    const unchanged = listed.body.missions.find((mission) => mission.id === created.body.mission.id)
    assert.equal(unchanged.runStatus, 'running')
  } finally {
    runStopResponse = '{"run_id":"run-test-123","status":"cancelled","output":"private stop output"}'
  }
})

test('eine verlinkte Peer-Datei wird nicht gelesen und erhält kein Credential', async () => {
  const peersPath = path.join(dataDir, 'peers.yaml')
  const originalPeersPath = path.join(dataDir, 'peers-original.yaml')
  const escapePath = path.join(dataDir, 'peers-outside.yaml')
  const peerPort = peerServer.address().port
  renameSync(peersPath, originalPeersPath)
  writeFileSync(escapePath, `peers:\n  barney:\n    endpoint: http://127.0.0.1:${peerPort}/symlink-read\n    api_key_env: MISSION_CONTROL_PEER_TEST_KEY\n`)
  symlinkSync(escapePath, peersPath)

  try {
    symlinkReadAuthorizationSeen = false
    const bootstrap = await getJson('/api/bootstrap')
    assert.equal(bootstrap.status, 200)
    assert.equal(symlinkReadAuthorizationSeen, false)
  } finally {
    rmSync(peersPath, { force: true })
    rmSync(escapePath, { force: true })
    renameSync(originalPeersPath, peersPath)
  }
})

test('Profil-Speicherung verweigert ein verlinktes Profilverzeichnis', async () => {
  const profilesPath = path.join(dataDir, 'profiles')
  const originalProfilesPath = path.join(dataDir, 'profiles-original')
  const escapePath = mkdtempSync(path.join(tmpdir(), 'mc-profile-escape-'))
  renameSync(profilesPath, originalProfilesPath)
  symlinkSync(escapePath, profilesPath, 'dir')

  try {
    const response = await postJson('/api/profiles', wizardPayload({ teamName: 'Symlink Escape' }), {
      authorization: 'Bearer test-write-token',
    })
    assert.equal(response.status, 503)
    assert.equal(response.body.error, 'profile_storage_unsafe')
    assert.throws(() => statSync(path.join(escapePath, 'symlink-escape.local.yaml')))

    writeFileSync(path.join(escapePath, 'bonys-agents.example.yaml'), 'name: Linked Profiles Controlled\n')
    writeFileSync(path.join(escapePath, 'outside-only.yaml'), 'name: Outside Only\n')
    const bootstrap = await getJson('/api/bootstrap')
    const profiles = await getJson('/api/profiles')
    assert.equal(bootstrap.status, 200)
    assert.equal(bootstrap.body.activeProfile.name, 'Bonys Agents')
    assert.equal(profiles.body.profiles.some((profile) => profile.file === 'outside-only.yaml'), false)
  } finally {
    rmSync(profilesPath, { force: true })
    renameSync(originalProfilesPath, profilesPath)
    rmSync(escapePath, { recursive: true, force: true })
  }
})

test('Profil-Speicherung verweigert einen verlinkten Datenordner', async () => {
  const originalDataDir = `${dataDir}-original`
  const escapePath = mkdtempSync(path.join(tmpdir(), 'mc-data-escape-'))
  renameSync(dataDir, originalDataDir)
  symlinkSync(escapePath, dataDir, 'dir')

  try {
    const response = await postJson('/api/profiles', wizardPayload({ teamName: 'Data Symlink Escape' }), {
      authorization: 'Bearer test-write-token',
    })
    assert.equal(response.status, 503)
    assert.equal(response.body.error, 'profile_storage_unsafe')
    assert.throws(() => statSync(path.join(escapePath, 'profiles')))
    assert.throws(() => statSync(path.join(escapePath, 'profiles', 'data-symlink-escape.local.yaml')))

    mkdirSync(path.join(escapePath, 'profiles'))
    writeFileSync(path.join(escapePath, 'profiles', 'bonys-agents.example.yaml'), `name: Symlink Controlled\nteam:\n  owner: Attacker\nagents:\n  - id: symlink-reader\n    name: Symlink Reader\n    type: hermes-peer\n    peer: symlink-reader\n`)
    writeFileSync(path.join(escapePath, 'profiles', 'outside-only.yaml'), 'name: Outside Only\n')
    const peerPort = peerServer.address().port
    writeFileSync(path.join(escapePath, 'peers.yaml'), `peers:\n  symlink-reader:\n    endpoint: http://127.0.0.1:${peerPort}/symlink-read\n    api_key_env: MISSION_CONTROL_PEER_TEST_KEY\n`)

    symlinkReadAuthorizationSeen = false
    const bootstrap = await getJson('/api/bootstrap')
    const profiles = await getJson('/api/profiles')
    assert.equal(bootstrap.status, 200)
    assert.equal(bootstrap.body.activeProfile.name, 'Bonys Agents')
    assert.equal(bootstrap.body.agents.some((agent) => agent.name === 'Symlink Reader'), false)
    assert.equal(profiles.body.profiles.some((profile) => profile.file === 'outside-only.yaml'), false)
    assert.equal(symlinkReadAuthorizationSeen, false)
  } finally {
    rmSync(dataDir, { force: true })
    renameSync(originalDataDir, dataDir)
    rmSync(escapePath, { recursive: true, force: true })
  }
})
