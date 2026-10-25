import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { audioType, readLimitedBody, speakText, transcribeAudio, voiceConfig, voiceStatus } from '../server/voice-runtime.mjs'

const config = voiceConfig({ MISSION_CONTROL_VOICE_URL: 'http://172.17.0.1:8640', MISSION_CONTROL_VOICE_KEY: 'geheim' })

function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  return { impl, calls }
}

test('Sprachdienst nur mit Adresse und Schlüssel, ohne Zugangsdaten in der URL', () => {
  assert.equal(voiceConfig({}), null)
  assert.equal(voiceConfig({ MISSION_CONTROL_VOICE_URL: 'http://172.17.0.1:8640' }), null)
  assert.equal(voiceConfig({ MISSION_CONTROL_VOICE_URL: 'http://a:b@172.17.0.1:8640', MISSION_CONTROL_VOICE_KEY: 'k' }), null)
  assert.equal(voiceConfig({ MISSION_CONTROL_VOICE_URL: 'file:///etc/passwd', MISSION_CONTROL_VOICE_KEY: 'k' }), null)
  assert.deepEqual(config, { base: 'http://172.17.0.1:8640/', key: 'geheim' })
})

test('nur Audio-Typen werden angenommen', () => {
  assert.equal(audioType('audio/webm;codecs=opus'), 'audio/webm')
  assert.equal(audioType('video/webm'), 'video/webm')
  assert.equal(audioType('text/plain'), '')
  assert.equal(audioType(undefined), '')
})

test('Körper wird bei Überschreitung der Grenze abgebrochen', async () => {
  const ok = await readLimitedBody(Readable.from([Buffer.from('abc')]), 10)
  assert.equal(ok.toString(), 'abc')
  await assert.rejects(readLimitedBody(Readable.from([Buffer.alloc(8), Buffer.alloc(8)]), 10), { code: 'body_too_large' })
})

test('Status meldet verfügbar nur bei ok und nennt Anbieter, ohne Schlüssel preiszugeben', async () => {
  const { impl, calls } = fakeFetch(() => Response.json({ ok: true, tts_ready: true, stt: 'auto', tts: 'piper' }))
  const status = await voiceStatus(config, impl)
  assert.deepEqual(status, { available: true, speech: true, stt: 'auto', tts: 'piper' })
  assert.equal(calls[0].url, 'http://172.17.0.1:8640/status')
  assert.equal(calls[0].init.headers.authorization, 'Bearer geheim')
  assert.equal(JSON.stringify(status).includes('geheim'), false)
  assert.deepEqual(await voiceStatus(null), { available: false })
  assert.deepEqual(await voiceStatus(config, async () => { throw new Error('down') }), { available: false })
})

test('Umwandeln schickt das Audio mit Typ und Schlüssel und liefert nur den Text', async () => {
  const { impl, calls } = fakeFetch(() => Response.json({ transcript: 'Hallo Atlas', provider: 'local' }))
  const result = await transcribeAudio(config, Buffer.from('audio'), 'audio/webm', impl)
  assert.deepEqual(result, { transcript: 'Hallo Atlas' })
  assert.equal(calls[0].url, 'http://172.17.0.1:8640/transcribe')
  assert.equal(calls[0].init.headers['content-type'], 'audio/webm')
  await assert.rejects(transcribeAudio(config, Buffer.from('x'), 'audio/webm', async () => new Response('', { status: 502 })),
    { code: 'transcription_failed' })
  await assert.rejects(transcribeAudio(null, Buffer.from('x'), 'audio/webm'), { code: 'voice_unavailable' })
})

test('Vorlesen prüft den Text und gibt die Audiodaten zurück', async () => {
  const { impl, calls } = fakeFetch(() => new Response(Buffer.from('MP3'), { headers: { 'content-type': 'audio/mpeg' } }))
  const audio = await speakText(config, '  Hallo  ', impl)
  assert.equal(audio.toString(), 'MP3')
  assert.equal(JSON.parse(calls[0].init.body).text, 'Hallo')
  await assert.rejects(speakText(config, '   ', impl), { code: 'invalid_text' })
  await assert.rejects(speakText(config, 'x'.repeat(4001), impl), { code: 'invalid_text' })
})
