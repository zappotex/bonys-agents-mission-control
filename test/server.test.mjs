// Starttest für das Backend: echter Prozess auf einem freien Port, nur Lesezugriffe
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverFile = fileURLToPath(new URL('../server/server.mjs', import.meta.url))
const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-test-'))
let child
let baseUrl

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

  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, [serverFile], {
    env: { ...process.env, MISSION_CONTROL_API_PORT: String(port), MISSION_CONTROL_DATA_DIR: dataDir },
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

test('lokale Profile werden ohne Freigabe nicht ausgeliefert', async () => {
  const { body } = await getJson('/api/bootstrap?profile=geheim.local.yaml')
  assert.equal(body.activeProfile.file, 'bonys-agents.example.yaml')
})

test('kein Pfad-Ausbruch aus dist/', async () => {
  const response = await fetch(baseUrl + '/%2e%2e/package.json')
  const text = await response.text()
  assert.ok(!text.includes('"devDependencies"'))
})
