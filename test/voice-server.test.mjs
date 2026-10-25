// Sprach-Routen im echten Backend-Prozess, mit einem nachgebildeten Sprachdienst
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverFile = fileURLToPath(new URL('../server/server.mjs', import.meta.url))
const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-voice-test-'))
const voiceRequests = []
let voiceServer
let withVoice
let withoutVoice

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

async function start(extraEnv) {
  const port = await freePort()
  const child = spawn(process.execPath, [serverFile], {
    env: { ...process.env, MISSION_CONTROL_API_PORT: String(port), MISSION_CONTROL_DATA_DIR: dataDir, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', () => {})
  await new Promise((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`Server beendet mit ${code}`)))
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) resolve() })
  })
  return { child, url: `http://127.0.0.1:${port}` }
}

function browser(url) {
  const u = new URL(url)
  return { host: u.host, origin: u.origin }
}

before(async () => {
  voiceServer = createHttpServer((request, response) => {
    const chunks = []
    request.on('data', (c) => chunks.push(c))
    request.on('end', () => {
      voiceRequests.push({ url: request.url, auth: request.headers.authorization, type: request.headers['content-type'],
        body: Buffer.concat(chunks) })
      if (request.headers.authorization !== 'Bearer stimm-schluessel') {
        response.writeHead(401).end('{}')
      } else if (request.url === '/status') {
        response.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true, tts_ready: true, stt: 'auto', tts: 'piper', language: 'de' }))
      } else if (request.url === '/transcribe') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ transcript: 'Hallo Nova' }))
      } else if (request.url === '/speak') {
        response.writeHead(200, { 'content-type': 'audio/mpeg' }).end(Buffer.from('MP3-DATEN'))
      } else {
        response.writeHead(404).end('{}')
      }
    })
  })
  await new Promise((resolve) => voiceServer.listen(0, '127.0.0.1', resolve))
  const voiceUrl = `http://127.0.0.1:${voiceServer.address().port}`
  withVoice = await start({ MISSION_CONTROL_VOICE_URL: voiceUrl, MISSION_CONTROL_VOICE_KEY: 'stimm-schluessel' })
  withoutVoice = await start({})
})

after(() => {
  withVoice?.child.kill()
  withoutVoice?.child.kill()
  voiceServer?.close()
  rmSync(dataDir, { recursive: true, force: true })
})

test('Status: ohne Sprachdienst nicht verfügbar, mit Dienst verfügbar – ohne Adresse oder Schlüssel', async () => {
  const ohne = await (await fetch(`${withoutVoice.url}/api/voice/status`)).json()
  assert.deepEqual(ohne, { available: false })
  const mit = await (await fetch(`${withVoice.url}/api/voice/status`)).json()
  assert.deepEqual(mit, { available: true, speech: true, stt: 'auto', tts: 'piper' })
  assert.equal(JSON.stringify(mit).includes('stimm-schluessel'), false)
  assert.equal(JSON.stringify(mit).includes('127.0.0.1'), false)
})

test('Umwandeln: nur aus dem Browser, nur Audio, Ergebnis vom Sprachdienst', async () => {
  const url = `${withVoice.url}/api/voice/transcribe`
  const ohneHerkunft = await fetch(url, { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: 'x' })
  assert.equal(ohneHerkunft.status, 403)
  const keinAudio = await fetch(url, { method: 'POST', headers: { ...browser(withVoice.url), 'content-type': 'text/plain' }, body: 'x' })
  assert.equal(keinAudio.status, 415)
  const leer = await fetch(url, { method: 'POST', headers: { ...browser(withVoice.url), 'content-type': 'audio/webm' }, body: '' })
  assert.equal(leer.status, 400)
  const ok = await fetch(url, { method: 'POST', headers: { ...browser(withVoice.url), 'content-type': 'audio/webm;codecs=opus' },
    body: Buffer.from('OPUS') })
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { transcript: 'Hallo Nova' })
  const letzter = voiceRequests.findLast((r) => r.url === '/transcribe')
  assert.equal(letzter.type, 'audio/webm')
  assert.equal(letzter.body.toString(), 'OPUS')
  const ohneDienst = await fetch(`${withoutVoice.url}/api/voice/transcribe`, { method: 'POST',
    headers: { ...browser(withoutVoice.url), 'content-type': 'audio/webm' }, body: 'x' })
  assert.equal(ohneDienst.status, 503)
})

test('Vorlesen: nur aus dem Browser, liefert MP3', async () => {
  const url = `${withVoice.url}/api/voice/speak`
  const ohneHerkunft = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Hallo' }) })
  assert.equal(ohneHerkunft.status, 403)
  const leer = await fetch(url, { method: 'POST', headers: { ...browser(withVoice.url), 'content-type': 'application/json' },
    body: JSON.stringify({ text: '  ' }) })
  assert.equal(leer.status, 400)
  const ok = await fetch(url, { method: 'POST', headers: { ...browser(withVoice.url), 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Hallo Team' }) })
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('content-type'), 'audio/mpeg')
  assert.equal(Buffer.from(await ok.arrayBuffer()).toString(), 'MP3-DATEN')
})
