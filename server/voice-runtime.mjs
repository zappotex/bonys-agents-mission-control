// Spracheingabe und Vorlesen: Weiterleitung an den Sprachdienst im Agent-PC (scripts/sprachdienst.py).
// Adresse und Schlüssel kommen nur aus der Serverumgebung (peers.env) und gehen nie an das Frontend.

export const MAX_AUDIO_BYTES = 15 * 1024 * 1024
export const MAX_SPEAK_CHARS = 4000
const AUDIO_TYPES = new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'video/webm'])

export function voiceConfig(env = process.env) {
  const url = String(env.MISSION_CONTROL_VOICE_URL || '').trim()
  const key = String(env.MISSION_CONTROL_VOICE_KEY || '').trim()
  if (!url || !key) return null
  try {
    const base = new URL(url)
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) return null
    return { base: base.href.endsWith('/') ? base.href : `${base.href}/`, key }
  } catch {
    return null
  }
}

export function audioType(contentType) {
  const type = String(contentType || '').split(';', 1)[0].trim().toLowerCase()
  return AUDIO_TYPES.has(type) ? type : ''
}

export async function readLimitedBody(request, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) {
      const error = new Error('Request body too large')
      error.code = 'body_too_large'
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function call(config, pfad, init, fetchImpl, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(new URL(pfad, config.base), {
      ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${config.key}` }, signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

export async function voiceStatus(config, fetchImpl = fetch) {
  if (!config) return { available: false }
  try {
    const response = await call(config, 'status', { method: 'GET' }, fetchImpl, 3000)
    if (!response.ok) return { available: false }
    const data = await response.json()
    return {
      available: data?.ok === true,
      speech: data?.ok === true && data?.tts_ready === true,
      stt: typeof data?.stt === 'string' ? data.stt.slice(0, 40) : '',
      tts: typeof data?.tts === 'string' ? data.tts.slice(0, 40) : '',
    }
  } catch {
    return { available: false }
  }
}

export async function transcribeAudio(config, audio, type, fetchImpl = fetch) {
  if (!config) throw Object.assign(new Error('voice_unavailable'), { code: 'voice_unavailable' })
  const response = await call(config, 'transcribe', { method: 'POST', headers: { 'content-type': type }, body: audio },
    fetchImpl, 120000)
  if (!response.ok) throw Object.assign(new Error('transcription_failed'), { code: 'transcription_failed' })
  const data = await response.json()
  return { transcript: typeof data?.transcript === 'string' ? data.transcript.slice(0, 8000) : '' }
}

export async function speakText(config, text, fetchImpl = fetch) {
  if (!config) throw Object.assign(new Error('voice_unavailable'), { code: 'voice_unavailable' })
  const clean = typeof text === 'string' ? text.trim() : ''
  if (!clean || clean.length > MAX_SPEAK_CHARS) throw Object.assign(new Error('invalid_text'), { code: 'invalid_text' })
  const response = await call(config, 'speak', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: clean }),
  }, fetchImpl, 120000)
  if (!response.ok) throw Object.assign(new Error('speech_failed'), { code: 'speech_failed' })
  return Buffer.from(await response.arrayBuffer())
}
