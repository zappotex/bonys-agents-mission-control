import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'
import { indexMarkdownDirectory } from './markdown-index.mjs'
import { createMission, listMissions, getMission, updateMission, claimMissionRun, attachMissionRun } from './mission-storage.mjs'
import {
  listLocalProfileFiles,
  readLocalProfile,
  readPrivateDataFile,
  writeLocalProfile,
} from './profile-storage.mjs'
import { canReadMissions, canWriteProfiles, defaultGateways } from './request-security.mjs'
import { createMissionRunStarter } from './mission-start-runtime.mjs'
import { checkForUpdate } from './update-runtime.mjs'
import { normalizeChatRequest, normalizePeerReply, chatConversationId } from './chat-runtime.mjs'
import { readChat, appendChat } from './chat-storage.mjs'
import { MAX_AUDIO_BYTES, audioType, readLimitedBody, speakText, transcribeAudio, voiceConfig, voiceStatus } from './voice-runtime.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const port = Number(process.env.MISSION_CONTROL_API_PORT || 8788)
const host = process.env.MISSION_CONTROL_API_HOST || '127.0.0.1'
const activeProfileFile = process.env.MISSION_CONTROL_PROFILE || 'bonys-agents.example.yaml'
const showPrivateValues = process.env.MISSION_CONTROL_SHOW_PRIVATE === 'true'
const localOnly = process.env.MISSION_CONTROL_LOCAL_ONLY === 'true'
// Im Docker-Container erreicht der Browser des Agent-PCs den Server über das Gateway des Container-Netzes
const trustedGateways = localOnly && existsSync('/.dockerenv') ? readDefaultGateways() : []
// Optionaler Datenordner (im Container ein Volume): eigene Profile in <data>/profiles
const dataDir = process.env.MISSION_CONTROL_DATA_DIR ? path.resolve(process.env.MISSION_CONTROL_DATA_DIR) : ''
const peerHealthCache = new Map()
const peerHealthCacheMs = 5000
const missionStart = createMissionRunStarter({
  claim: ({ profile, missionId, agentId, expectedOwner }) => claimMissionRun(dataDir, missionId, profile, { agentId, expectedOwner }),
  execute: executeMissionRunStart,
})

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(response, 200, {
        ok: true,
        service: 'bonys-agents-mission-control-api',
        version: readPackageVersion(),
        activeProfile: sanitizeProfileName(activeProfileFile),
        privateValuesVisible: showPrivateValues,
      })
    }

    if (request.method === 'GET' && url.pathname === '/api/update') {
      return sendJson(response, 200, await checkForUpdate({ currentVersion: readPackageVersion() }))
    }

    if (request.method === 'GET' && url.pathname === '/api/chat') {
      return readChatHistory(url, response)
    }

    if (request.method === 'POST' && url.pathname === '/api/chat') {
      return sendChatMessage(request, response)
    }

    if (request.method === 'GET' && url.pathname === '/api/voice/status') {
      return sendJson(response, 200, await voiceStatus(voiceConfig()))
    }

    if (request.method === 'POST' && url.pathname === '/api/voice/transcribe') {
      return transcribeVoice(request, response)
    }

    if (request.method === 'POST' && url.pathname === '/api/voice/speak') {
      return speakVoice(request, response)
    }

    if (request.method === 'GET' && url.pathname === '/api/profiles') {
      return sendJson(response, 200, { profiles: await listProfiles() })
    }

    if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
      const profileName = sanitizeProfileName(url.searchParams.get('profile') || activeProfileFile)
      const bootstrap = await buildBootstrap(profileName)
      return sendJson(response, 200, bootstrap)
    }

    if (request.method === 'POST' && url.pathname === '/api/profiles') {
      return saveProfileFromWizard(request, response)
    }

    if (request.method === 'GET' && url.pathname === '/api/missions') {
      return sendMissionList(url, response, request)
    }

    if (request.method === 'POST' && url.pathname === '/api/missions') {
      return saveMission(request, response)
    }

    const missionMatch = url.pathname.match(/^\/api\/missions\/(mission-[a-f0-9-]+)$/)
    if (request.method === 'PATCH' && missionMatch) {
      return patchMission(request, response, missionMatch[1])
    }

    const runStopMatch = url.pathname.match(/^\/api\/missions\/(mission-[a-f0-9-]+)\/run\/stop$/)
    if (request.method === 'POST' && runStopMatch) {
      return stopMissionRun(request, response, runStopMatch[1])
    }

    const runStatusMatch = url.pathname.match(/^\/api\/missions\/(mission-[a-f0-9-]+)\/run\/status$/)
    if (request.method === 'POST' && runStatusMatch) {
      return pollMissionRunStatus(request, response, runStatusMatch[1])
    }

    const runMatch = url.pathname.match(/^\/api\/missions\/(mission-[a-f0-9-]+)\/run$/)
    if (request.method === 'POST' && runMatch) {
      return startMissionRun(request, response, runMatch[1])
    }

    if (request.method === 'GET') {
      return serveStatic(response, url.pathname)
    }

    return sendJson(response, 404, { error: 'not_found' })
  } catch (error) {
    // Details nur ins Log, nicht an den Client (keine Pfade nach außen)
    console.error(error)
    return sendJson(response, 500, { error: 'internal_error' })
  }
}).listen(port, host, () => {
  console.log(`Bonys Agents Mission Control API listening on http://${host}:${port}`)
})

async function readChatHistory(url, response) {
  const profile = normalizeMissionProfile(url.searchParams.get('profile'))
  const mode = url.searchParams.get('mode') === 'team' ? 'team' : 'single'
  const agentIds = (url.searchParams.get('agents') || '').split(',').filter(Boolean)
  if (!profile || !agentIds.length) return sendJson(response, 400, { error: 'invalid_chat_request' })
  const conversationId = chatConversationId(profile, mode, agentIds)
  try {
    return sendJson(response, 200, { conversationId, messages: await readChat(dataDir, conversationId) })
  } catch {
    return sendJson(response, 503, { error: 'chat_storage_unavailable' })
  }
}

async function sendChatMessage(request, response) {
  if (!dataDir) return sendJson(response, 503, { error: 'chat_storage_unavailable' })
  if (!canWriteProfiles(request, process.env.MISSION_CONTROL_API_TOKEN, trustedGateways)) return sendJson(response, 403, { error: 'forbidden' })
  const payload = await readMissionPayload(request, response)
  if (!payload) return
  const profile = normalizeMissionProfile(payload.profile)
  if (!profile) return sendJson(response, 400, { error: 'invalid_chat_request' })
  try {
    const configuredProfile = await readPrivateProfile(profile)
    const configuredAgents = Array.isArray(configuredProfile?.agents) ? configuredProfile.agents : []
    const knownAgentIds = configuredAgents.filter((agent) => agent?.type === 'hermes-peer').map((agent) => agent.id).filter(Boolean)
    const chat = normalizeChatRequest(payload, knownAgentIds)
    const conversationId = chatConversationId(profile, chat.mode, chat.agentIds)
    const userMessage = { id: randomUUID(), role: 'user', content: chat.message, createdAt: new Date().toISOString() }
    await appendChat(dataDir, conversationId, [userMessage])
    const replies = await Promise.all(chat.agentIds.map(async (agentId) => {
      const agent = configuredAgents.find((item) => item?.id === agentId)
      try {
        const peer = await resolvePeerForAgent(profile, agentId)
        const run = await postHermesRun(peer.endpoint, peer.apiKey, `chat:${conversationId}:${userMessage.id}:${agentId}`, {
          input: chat.message,
          metadata: { chat_conversation: conversationId, agent_id: agentId },
        })
        const output = await waitForHermesRun(peer.endpoint, peer.apiKey, run?.run_id)
        return {
          id: randomUUID(), role: 'assistant', agentId, agentName: agent?.name || agentId,
          content: normalizePeerReply(output) || 'Der Agent hat keine Textantwort geliefert.',
          createdAt: new Date().toISOString(),
        }
      } catch {
        return {
          id: randomUUID(), role: 'assistant', agentId, agentName: agent?.name || agentId,
          content: 'Der Agent ist derzeit nicht erreichbar oder hat keine Antwort geliefert.',
          createdAt: new Date().toISOString(), error: true,
        }
      }
    }))
    const messages = await appendChat(dataDir, conversationId, replies)
    return sendJson(response, 200, { conversationId, messages })
  } catch (error) {
    if (error?.message === 'invalid_chat_request') return sendJson(response, 400, { error: 'invalid_chat_request' })
    console.error(error)
    return sendJson(response, 503, { error: 'chat_unavailable' })
  }
}

async function waitForHermesRun(endpoint, apiKey, runId) {
  if (typeof runId !== 'string' || !runId) throw new Error('invalid_chat_run')
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await getHermesRun(endpoint, apiKey, runId)
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(result?.status)) return result
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error('chat_timeout')
}
async function sendMissionList(url, response, request) {
  const profile = normalizeMissionProfile(url.searchParams.get('profile'))
  if (!profile) return sendJson(response, 400, { error: 'invalid_profile' })
  if (!canReadMissions(request, process.env.MISSION_CONTROL_API_TOKEN, host, localOnly)) {
    return sendJson(response, 403, { error: 'forbidden' })
  }
  if (!dataDir) return sendJson(response, 200, { missions: [], storageAvailable: false })
  try {
    return sendJson(response, 200, { missions: await listMissions(dataDir, profile), storageAvailable: true })
  } catch (error) {
    if (['profile_storage_unsafe', 'mission_store_invalid'].includes(error?.code)) {
      return sendJson(response, 503, { error: 'mission_storage_unavailable' })
    }
    throw error
  }
}

async function saveMission(request, response) {
  if (!dataDir) return sendJson(response, 503, { error: 'mission_storage_unavailable' })
  if (!canWriteProfiles(request, process.env.MISSION_CONTROL_API_TOKEN, trustedGateways)) {
    return sendJson(response, 403, { error: 'forbidden' })
  }
  const payload = await readMissionPayload(request, response)
  if (!payload) return
  const profile = normalizeMissionProfile(payload.profile)
  if (!profile) return sendJson(response, 400, { error: 'invalid_mission' })

  try {
    const mission = await createMission(dataDir, { ...payload, profile })
    return sendJson(response, 201, { mission })
  } catch (error) {
    if (error?.code === 'invalid_mission') return sendJson(response, 400, { error: 'invalid_mission' })
    if (['profile_storage_unsafe', 'mission_store_invalid', 'mission_storage_unavailable'].includes(error?.code)) {
      return sendJson(response, 503, { error: 'mission_storage_unavailable' })
    }
    throw error
  }
}

async function patchMission(request, response, id) {
  if (!dataDir) return sendJson(response, 503, { error: 'mission_storage_unavailable' })
  if (!canWriteProfiles(request, process.env.MISSION_CONTROL_API_TOKEN, trustedGateways)) {
    return sendJson(response, 403, { error: 'forbidden' })
  }
  const payload = await readMissionPayload(request, response)
  if (!payload) return
  const profile = normalizeMissionProfile(payload.profile)
  if (!profile) return sendJson(response, 400, { error: 'invalid_mission' })

  try {
    const mission = await updateMission(dataDir, id, profile, payload)
    if (!mission) return sendJson(response, 404, { error: 'mission_not_found' })
    return sendJson(response, 200, { mission })
  } catch (error) {
    if (error?.code === 'invalid_mission') return sendJson(response, 400, { error: 'invalid_mission' })
    if (['profile_storage_unsafe', 'mission_store_invalid', 'mission_storage_unavailable'].includes(error?.code)) {
      return sendJson(response, 503, { error: 'mission_storage_unavailable' })
    }
    throw error
  }
}

async function stopMissionRun(request, response, id) {
  if (!dataDir) return sendJson(response, 503, { error: 'mission_storage_unavailable' })
  if (!canWriteProfiles(request, process.env.MISSION_CONTROL_API_TOKEN, trustedGateways)) {
    return sendJson(response, 403, { error: 'forbidden' })
  }
  const payload = await readMissionPayload(request, response)
  if (!payload) return
  const profile = normalizeMissionProfile(payload.profile)
  if (!profile) return sendJson(response, 400, { error: 'invalid_mission' })

  const mission = await getMission(dataDir, id, profile)
  if (!mission) return sendJson(response, 404, { error: 'mission_not_found' })
  if (isTerminalRunStatus(mission.runStatus)) return sendJson(response, 200, { mission })
  if (!mission.runId) return sendJson(response, 409, { error: 'run_unavailable' })
  const expectedRunAttempt = mission.runAttempt
  const expectedRunId = mission.runId

  const configuredProfile = await readPrivateProfile(profile)
  const configuredAgents = Array.isArray(configuredProfile?.agents) ? configuredProfile.agents : []
  const agent = configuredAgents.find((item) => item?.id === mission.agentId)
  const peerName = typeof agent?.peer === 'string' ? agent.peer : agent?.id
  const privatePeer = peerName ? (await readPrivatePeers())[peerName] : undefined
  const endpoint = normalizePublicValue(privatePeer?.endpoint)
  const credential = endpoint ? resolvePeerCredential(privatePeer) : { apiKey: '', cacheIdentity: 'public' }
  if (!agent || agent.type !== 'hermes-peer' || !endpoint) {
    return sendJson(response, 409, { error: 'peer_unavailable' })
  }

  try {
    const runResponse = await postHermesRunStop(endpoint, credential.apiKey, mission.runId)
    if (runResponse?.run_id !== expectedRunId) throw new Error('invalid_run_response')
    const updatedMission = await attachMissionRun(dataDir, id, profile, {
      runStatus: normalizeRunStatus(runResponse.status),
    }, { expectedRunAttempt, expectedRunId })
    return sendJson(response, 200, { mission: updatedMission })
  } catch (error) {
    const currentMission = await getMission(dataDir, id, profile)
    if (currentMission && (currentMission.runAttempt !== expectedRunAttempt || currentMission.runId !== expectedRunId)) {
      return sendJson(response, 200, { mission: currentMission })
    }
    console.error(error)
    return sendJson(response, 502, { error: 'peer_run_stop_failed' })
  }
}

async function pollMissionRunStatus(request, response, id) {
  if (!dataDir) return sendJson(response, 503, { error: 'mission_storage_unavailable' })
  if (!canWriteProfiles(request, process.env.MISSION_CONTROL_API_TOKEN, trustedGateways)) {
    return sendJson(response, 403, { error: 'forbidden' })
  }
  const payload = await readMissionPayload(request, response)
  if (!payload) return
  const profile = normalizeMissionProfile(payload.profile)
  if (!profile) return sendJson(response, 400, { error: 'invalid_mission' })

  const mission = await getMission(dataDir, id, profile)
  if (!mission) return sendJson(response, 404, { error: 'mission_not_found' })
  if (!mission.runId) return sendJson(response, 409, { error: 'run_unavailable' })
  if (isTerminalRunStatus(mission.runStatus)) return sendJson(response, 200, { mission })
  const expectedRunAttempt = mission.runAttempt
  const expectedRunId = mission.runId

  const configuredProfile = await readPrivateProfile(profile)
  const configuredAgents = Array.isArray(configuredProfile?.agents) ? configuredProfile.agents : []
  const agent = configuredAgents.find((item) => item?.id === mission.agentId)
  const peerName = typeof agent?.peer === 'string' ? agent.peer : agent?.id
  const privatePeer = peerName ? (await readPrivatePeers())[peerName] : undefined
  const endpoint = normalizePublicValue(privatePeer?.endpoint)
  const credential = endpoint ? resolvePeerCredential(privatePeer) : { apiKey: '', cacheIdentity: 'public' }
  if (!agent || agent.type !== 'hermes-peer' || !endpoint) {
    return sendJson(response, 409, { error: 'peer_unavailable' })
  }

  try {
    const runResponse = await getHermesRun(endpoint, credential.apiKey, mission.runId)
    if (runResponse?.run_id !== expectedRunId) throw new Error('invalid_run_response')
    const updatedMission = await attachMissionRun(dataDir, id, profile, {
      runStatus: normalizeRunStatus(runResponse.status),
    }, { expectedRunAttempt, expectedRunId })
    return sendJson(response, 200, { mission: updatedMission })
  } catch (error) {
    const currentMission = await getMission(dataDir, id, profile)
    if (currentMission && (currentMission.runAttempt !== expectedRunAttempt || currentMission.runId !== expectedRunId)) {
      return sendJson(response, 200, { mission: currentMission })
    }
    console.error(error)
    return sendJson(response, 502, { error: 'peer_run_status_failed' })
  }
}

async function startMissionRun(request, response, id) {
  if (!dataDir) return sendJson(response, 503, { error: 'mission_storage_unavailable' })
  if (!canWriteProfiles(request, process.env.MISSION_CONTROL_API_TOKEN, trustedGateways)) {
    return sendJson(response, 403, { error: 'forbidden' })
  }
  const payload = await readMissionPayload(request, response)
  if (!payload) return
  const profile = normalizeMissionProfile(payload.profile)
  if (!profile) return sendJson(response, 400, { error: 'invalid_mission' })

  const mission = await getMission(dataDir, id, profile)
  if (!mission) return sendJson(response, 404, { error: 'mission_not_found' })
  const recovering = mission.runStatus === 'starting' && !mission.runId && typeof mission.agentId === 'string'
  const candidate = recovering
    ? { id: mission.agentId }
    : await resolvePeerForOwner(profile, mission.owner)
  if (!candidate?.id) return sendJson(response, 409, { error: 'peer_unavailable' })

  try {
    const result = await missionStart({
      profile,
      missionId: id,
      agentId: candidate.id,
      expectedOwner: recovering ? undefined : mission.owner,
      title: mission.title,
      description: mission.description,
      metadata: { mission_id: id },
    })
    if (!result) return sendJson(response, 404, { error: 'mission_not_found' })
    if (result.mission) return sendJson(response, 202, { mission: result.mission })
    return sendJson(response, 202, { mission: result })
  } catch (error) {
    if (error?.code === 'mission_changed') return sendJson(response, 409, { error: 'mission_changed' })
    console.error(error)
    return sendJson(response, 502, { error: 'peer_run_failed' })
  }
}

async function executeMissionRunStart({ claim, request }) {
  try {
    const peer = await resolvePeerForAgent(request.profile, claim.mission.agentId)
    const runResponse = await postHermesRun(peer.endpoint, peer.apiKey, claim.mission.idempotencyKey, {
      // ohne "model": jeder Hermes-Agent nimmt das in seinem Profil eingestellte Modell
      input: `${request.title}${request.description ? `\n\n${request.description}` : ''}`,
      metadata: { ...request.metadata, agent_id: claim.mission.agentId },
    })
    const runId = typeof runResponse?.run_id === 'string' ? runResponse.run_id : ''
    if (!runId) throw new Error('invalid_run_response')
    return await attachMissionRun(dataDir, request.missionId, request.profile, {
      runId,
      runStatus: normalizeRunStatus(runResponse.status),
    }, { expectedRunAttempt: claim.mission.runAttempt })
  } catch (error) {
    await attachMissionRun(dataDir, request.missionId, request.profile, {
      runStatus: 'failed',
      runError: 'peer_run_failed',
    }, { expectedRunAttempt: claim.mission.runAttempt })
    throw error
  }
}

async function getHermesRun(endpoint, apiKey, runId) {
  let base
  try {
    base = new URL(endpoint)
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('invalid_endpoint')
  } catch {
    throw new Error('invalid_endpoint')
  }
  const url = new URL(`v1/runs/${encodeURIComponent(runId)}`, base.href.endsWith('/') ? base.href : `${base.href}/`)
  const headers = { accept: 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  const result = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) })
  if (!result.ok) throw new Error(`peer_run_status_http_${result.status}`)
  return result.json()
}

async function postHermesRun(endpoint, apiKey, idempotencyKey, payload) {
  let base
  try {
    base = new URL(endpoint)
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('invalid_endpoint')
  } catch {
    throw new Error('invalid_endpoint')
  }
  const url = new URL('v1/runs', base.href.endsWith('/') ? base.href : `${base.href}/`)
  const headers = { accept: 'application/json', 'content-type': 'application/json', 'idempotency-key': idempotencyKey }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  const result = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(10000) })
  if (!result.ok) throw new Error(`peer_run_http_${result.status}`)
  return result.json()
}

async function postHermesRunStop(endpoint, apiKey, runId) {
  let base
  try {
    base = new URL(endpoint)
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('invalid_endpoint')
  } catch {
    throw new Error('invalid_endpoint')
  }
  const url = new URL(`v1/runs/${encodeURIComponent(runId)}/stop`, base.href.endsWith('/') ? base.href : `${base.href}/`)
  const headers = { accept: 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  const result = await fetch(url, { method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(3000) })
  if (!result.ok) throw new Error(`peer_run_stop_http_${result.status}`)
  return result.json()
}

function normalizeRunStatus(value) {
  if (['completed', 'failed', 'cancelled', 'interrupted'].includes(value)) return value
  return 'running'
}

function isTerminalRunStatus(value) {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(value)
}

async function resolvePeerForOwner(profile, owner) {
  const configuredProfile = await readPrivateProfile(profile)
  const configuredAgents = Array.isArray(configuredProfile?.agents) ? configuredProfile.agents : []
  const agent = configuredAgents.find((item) => item?.name === owner || item?.id === owner)
  return agent?.id ? { id: agent.id } : undefined
}

async function resolvePeerForAgent(profile, agentId) {
  const configuredProfile = await readPrivateProfile(profile)
  const configuredAgents = Array.isArray(configuredProfile?.agents) ? configuredProfile.agents : []
  const agent = configuredAgents.find((item) => item?.id === agentId)
  const peerName = typeof agent?.peer === 'string' ? agent.peer : agent?.id
  const privatePeer = peerName ? (await readPrivatePeers())[peerName] : undefined
  const endpoint = normalizePublicValue(privatePeer?.endpoint)
  const credential = endpoint ? resolvePeerCredential(privatePeer) : { apiKey: '', cacheIdentity: 'public' }
  if (!agent || agent.type !== 'hermes-peer' || !endpoint) throw peerUnavailableError()
  return { endpoint, apiKey: credential.apiKey }
}

function peerUnavailableError() {
  const error = new Error('Peer unavailable')
  error.code = 'peer_unavailable'
  return error
}

async function readPrivateProfile(file) {
  if (dataDir) {
    try {
      const raw = await readLocalProfile(dataDir, file)
      if (raw !== undefined) return parse(raw) || {}
    } catch (error) {
      if (error?.code !== 'profile_storage_unsafe') throw error
    }
  }
  return readYaml(path.join(rootDir, 'profiles', file))
}
async function transcribeVoice(request, response) {
  if (!canWriteProfiles(request, process.env.MISSION_CONTROL_API_TOKEN, trustedGateways)) {
    return sendJson(response, 403, { error: 'forbidden' })
  }
  const config = voiceConfig()
  if (!config) return sendJson(response, 503, { error: 'voice_unavailable' })
  const type = audioType(request.headers['content-type'])
  if (!type) return sendJson(response, 415, { error: 'unsupported_media_type' })
  let audio
  try {
    audio = await readLimitedBody(request, MAX_AUDIO_BYTES)
  } catch (error) {
    return sendJson(response, error?.code === 'body_too_large' ? 413 : 400, { error: error?.code || 'invalid_body' })
  }
  if (!audio.length) return sendJson(response, 400, { error: 'empty_audio' })
  try {
    return sendJson(response, 200, await transcribeAudio(config, audio, type))
  } catch {
    return sendJson(response, 502, { error: 'transcription_failed' })
  }
}

async function speakVoice(request, response) {
  if (!canWriteProfiles(request, process.env.MISSION_CONTROL_API_TOKEN, trustedGateways)) {
    return sendJson(response, 403, { error: 'forbidden' })
  }
  const config = voiceConfig()
  if (!config) return sendJson(response, 503, { error: 'voice_unavailable' })
  const payload = await readMissionPayload(request, response)
  if (!payload) return
  try {
    const audio = await speakText(config, payload.text)
    response.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length, 'cache-control': 'no-store' })
    return response.end(audio)
  } catch (error) {
    if (error?.code === 'invalid_text') return sendJson(response, 400, { error: 'invalid_text' })
    return sendJson(response, 502, { error: 'speech_failed' })
  }
}

async function readMissionPayload(request, response) {
  const mediaType = String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase()
  if (mediaType !== 'application/json') {
    sendJson(response, 415, { error: 'unsupported_media_type' })
    return undefined
  }
  try {
    return await readJsonBody(request)
  } catch (error) {
    sendJson(response, error?.code === 'body_too_large' ? 413 : 400, {
      error: error?.code || 'invalid_json',
    })
    return undefined
  }
}

function normalizeMissionProfile(value) {
  if (typeof value !== 'string' || value !== path.basename(value)) return ''
  const sanitized = sanitizeProfileName(value)
  return sanitized === value ? value : ''
}

async function saveProfileFromWizard(request, response) {
  if (!dataDir) return sendJson(response, 503, { error: 'profile_storage_unavailable' })
  if (!canWriteProfiles(request, process.env.MISSION_CONTROL_API_TOKEN, trustedGateways)) {
    return sendJson(response, 403, { error: 'forbidden' })
  }
  const mediaType = String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase()
  if (mediaType !== 'application/json') {
    return sendJson(response, 415, { error: 'unsupported_media_type' })
  }

  let payload
  try {
    payload = await readJsonBody(request)
  } catch (error) {
    return sendJson(response, error?.code === 'body_too_large' ? 413 : 400, {
      error: error?.code || 'invalid_json',
    })
  }

  let profile
  try {
    profile = normalizeWizardProfile(payload)
  } catch {
    return sendJson(response, 400, { error: 'invalid_profile' })
  }

  const file = `${profile.slug}.local.yaml`
  try {
    await writeLocalProfile(dataDir, file, stringify(profile, { lineWidth: 0 }))
  } catch (error) {
    if (error?.code === 'EEXIST') return sendJson(response, 409, { error: 'profile_exists' })
    if (error?.code === 'profile_storage_unsafe') {
      return sendJson(response, 503, { error: 'profile_storage_unsafe' })
    }
    throw error
  }

  return sendJson(response, 201, {
    file,
    selectable: showPrivateValues,
    profile: profileMetaFromFile(file, profile),
  })
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 64 * 1024) {
      const error = new Error('Request body too large')
      error.code = 'body_too_large'
      throw error
    }
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function normalizeWizardProfile(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid payload')
  const name = requiredText(payload.teamName, 80)
  const owner = requiredText(payload.ownerName, 80)
  const coordinator = requiredText(payload.coordinatorName, 80)
  const projectPath = requiredText(payload.projectPath, 4096)
  const outputPath = requiredText(payload.outputPath, 4096)
  const notesPath = optionalText(payload.notesPath, 4096)
  const themes = ['bonys-agents-cyberpunk', 'default-dark', 'minimal']
  if (!themes.includes(payload.theme)) throw new Error('invalid theme')
  if (typeof payload.usesHermesPeers !== 'boolean' || typeof payload.usesObsidian !== 'boolean') {
    throw new Error('invalid integrations')
  }
  if (!Array.isArray(payload.agentNames) || payload.agentNames.length < 1 || payload.agentNames.length > 32) {
    throw new Error('invalid agents')
  }
  const agentNames = payload.agentNames.map((agent) => requiredText(agent, 80))
  if (!agentNames.includes(coordinator)) throw new Error('coordinator is not an agent')
  const agentIds = agentNames.map((agent) => slugify(agent))
  if (agentIds.some((id) => !id) || new Set(agentIds).size !== agentIds.length) {
    throw new Error('colliding agent ids')
  }
  const slug = slugify(name).slice(0, 64) || 'my-agent-team'

  return {
    name,
    slug,
    description: 'Locally configured agent team profile.',
    theme: payload.theme,
    team: {
      owner,
      coordinator,
      agents: agentNames,
    },
    agents: agentNames.map((agent, index) => ({
      id: agentIds[index],
      name: agent,
      role: agent === coordinator ? 'Team Coordination' : 'Agent',
      type: payload.usesHermesPeers ? 'hermes-peer' : 'placeholder',
      peer: agentIds[index],
      status: 'standby',
      tags: [],
    })),
    integrations: {
      hermes: { enabled: payload.usesHermesPeers, peers: [] },
      notes: { enabled: payload.usesObsidian, path: notesPath },
    },
    paths: {
      projects: projectPath,
      outputs: outputPath,
    },
    privacy: {
      contains_private_values: true,
      publish_safe: false,
    },
  }
}

function requiredText(value, maxLength) {
  if (typeof value !== 'string') throw new Error('invalid text')
  const text = value.trim()
  if (!text || text.length > maxLength) throw new Error('invalid text')
  if (/\p{C}/u.test(text)) throw new Error('invalid text')
  return text
}

function optionalText(value, maxLength) {
  if (value === undefined || value === null || value === '') return ''
  return requiredText(value, maxLength)
}

async function buildBootstrap(profileName) {
  const agentsConfig = await readYaml(path.join(rootDir, 'config', 'agents.yaml'))
  const profile = await readProfile(profileName)
  const profileMeta = profileMetaFromFile(profileName, profile)

  return {
    app: {
      name: 'Bonys Agents Mission Control',
      version: readPackageVersion(),
    },
    source: 'backend',
    activeProfile: profileMeta,
    profiles: await listProfiles(),
    team: {
      owner: profile?.team?.owner || 'Operator',
      coordinator: profile?.team?.coordinator || '',
    },
    agents: await buildAgents(agentsConfig, profile),
    projectIndex: await buildProjectIndex(profile),
    privacy: {
      privateValuesVisible: showPrivateValues,
      redaction: showPrivateValues ? 'disabled' : 'private profile values are redacted',
    },
  }
}

async function buildProjectIndex(profile) {
  const notes = profile?.integrations?.notes || profile?.integrations?.obsidian
  const notesPath = typeof notes?.path === 'string' ? notes.path.trim() : ''
  if (notes?.enabled !== true || !notesPath || notesPath.startsWith('CHANGE_ME') || notesPath.startsWith('/path/to/')) {
    return { status: 'disabled', documents: [] }
  }

  try {
    return {
      status: 'ready',
      documents: await indexMarkdownDirectory(notesPath),
    }
  } catch {
    return { status: 'unavailable', documents: [] }
  }
}

async function buildAgents(agentsConfig, profile) {
  const owner = profile?.team?.owner || 'Operator'
  const ownerAgent = {
    id: slugify(owner),
    name: owner,
    role: 'Operator / Creator',
    type: 'human',
    status: 'online',
    statusSource: 'configured',
    tags: ['strategy', 'approval', 'creative-direction'],
  }

  const privatePeers = await readPrivatePeers()
  const configuredAgentSource = Array.isArray(profile?.agents) ? profile.agents : agentsConfig?.agents
  const configuredAgents = await Promise.all((configuredAgentSource || [])
    .filter((agent) => agent?.enabled !== false)
    .map(async (agent, index) => {
      const id = agent.id || `agent-${index + 1}`
      const privatePeer = privatePeers[agent.peer] || {}
      const privateEndpoint = normalizePublicValue(privatePeer.endpoint)
      const endpoint = privateEndpoint || normalizePublicValue(agent.endpoint)
      const peerCredential = privateEndpoint
        ? resolvePeerCredential(privatePeer)
        : resolvePeerCredential()
      const liveObservation = agent.type === 'hermes-peer' && endpoint
        ? await probePeerHealth(endpoint, peerCredential)
        : undefined
      return {
        id,
        name: agent.name || id,
        role: agent.role || 'Agent',
        type: agent.type || 'placeholder',
        status: liveObservation?.status || normalizeAgentStatus(agent.status),
        statusSource: liveObservation ? 'live' : 'configured',
        ...(liveObservation?.activitySource ? { activitySource: liveObservation.activitySource } : {}),
        tags: Array.isArray(agent.tags) ? agent.tags : [],
      }
    }))

  return [ownerAgent, ...configuredAgents]
}

async function readPrivatePeers() {
  if (!dataDir) return {}
  try {
    const raw = await readPrivateDataFile(dataDir, 'peers.yaml')
    if (!raw) return {}
    const parsed = parse(raw) || {}
    return parsed.peers && typeof parsed.peers === 'object' ? parsed.peers : {}
  } catch (error) {
    if (error?.code === 'profile_storage_unsafe') return {}
    throw error
  }
}

function resolvePeerCredential(peer) {
  const envName = typeof peer?.api_key_env === 'string' ? peer.api_key_env.trim() : ''
  if (!/^(?:MISSION_CONTROL_PEER|HERMES_PEER)_[A-Z0-9_]+_KEY$/.test(envName)) {
    return { apiKey: '', cacheIdentity: 'public' }
  }
  return { apiKey: process.env[envName] || '', cacheIdentity: envName }
}

async function probePeerHealth(endpoint, credential) {
  const { apiKey, cacheIdentity } = credential
  const cacheKey = `${endpoint}\n${apiKey ? cacheIdentity : 'public'}`
  const cached = peerHealthCache.get(cacheKey)
  if (cached?.expiresAt > Date.now()) return cached.status
  if (cached?.promise) return cached.promise

  const promise = fetchPeerHealth(endpoint, apiKey)
  peerHealthCache.set(cacheKey, { promise })
  const status = await promise
  peerHealthCache.set(cacheKey, { status, expiresAt: Date.now() + peerHealthCacheMs })
  return status
}

async function fetchPeerHealth(endpoint, apiKey) {
  let base
  try {
    base = new URL(endpoint)
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
      return { status: 'offline', activitySource: 'reachability' }
    }
  } catch {
    return { status: 'offline', activitySource: 'reachability' }
  }

  if (apiKey) {
    try {
      const detailedUrl = new URL('health/detailed', base.href.endsWith('/') ? base.href : `${base.href}/`)
      const detailedResponse = await fetch(detailedUrl, {
        headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
        redirect: 'error',
        signal: AbortSignal.timeout(1500),
      })
      if (detailedResponse.ok) {
        const detailed = await detailedResponse.json()
        if (['ok', 'degraded'].includes(detailed.status)) {
          const busy = detailed.gateway_busy === true
            || Number(detailed.active_agents || 0) > 0
            || Number(detailed.api_server?.active_runs || 0) > 0
          return { status: busy ? 'busy' : 'online', activitySource: 'hermes-detailed' }
        }
      }
    } catch {
      // Detaildaten sind optional; Erreichbarkeit wird unabhängig darunter geprüft.
    }
  }

  try {
    const healthUrl = new URL('health', base.href.endsWith('/') ? base.href : `${base.href}/`)
    const response = await fetch(healthUrl, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) return { status: 'offline', activitySource: 'reachability' }
    const body = await response.json()
    return {
      status: body?.status === 'ok' ? 'online' : 'offline',
      activitySource: 'reachability',
    }
  } catch {
    return { status: 'offline', activitySource: 'reachability' }
  }
}

async function listProfiles() {
  const files = new Set(await readdir(path.join(rootDir, 'profiles')))
  if (dataDir) {
    try {
      for (const file of await listLocalProfileFiles(dataDir)) files.add(file)
    } catch (error) {
      if (error?.code !== 'profile_storage_unsafe') throw error
    }
  }
  const yamlFiles = [...files].filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'))
  const visibleFiles = showPrivateValues ? yamlFiles : yamlFiles.filter((file) => !file.endsWith('.local.yaml'))

  return Promise.all(
    visibleFiles.sort().map(async (file) => {
      const data = await readProfile(file)
      return profileMetaFromFile(file, data)
    }),
  )
}

function profileMetaFromFile(file, data) {
  const isLocal = file.endsWith('.local.yaml')
  return {
    file,
    name: data?.name || file,
    slug: data?.slug || file.replace(/\.ya?ml$/, ''),
    description: data?.description || '',
    theme: data?.theme || 'default-dark',
    publishSafe: data?.privacy?.publish_safe === true && !isLocal,
    localOnly: isLocal,
  }
}

async function readProfile(file) {
  if (dataDir) {
    try {
      const raw = await readLocalProfile(dataDir, file)
      if (raw !== undefined) return parseYaml(raw, file)
    } catch (error) {
      if (error?.code !== 'profile_storage_unsafe') throw error
    }
  }
  return readYaml(path.join(rootDir, 'profiles', file))
}

async function readYaml(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`YAML file not found: ${path.relative(rootDir, filePath)}`)
  }

  const raw = await readFile(filePath, 'utf8')
  return parseYaml(raw, filePath)
}

function parseYaml(raw, filePath) {
  const parsed = parse(raw) || {}
  return redactPrivateValues(parsed, filePath)
}

function redactPrivateValues(value, filePath) {
  if (showPrivateValues) {
    return value
  }

  const isLocalFile = filePath.endsWith('.local.yaml')
  if (!isLocalFile) {
    return value
  }

  return redact(value)
}

function redact(value) {
  if (Array.isArray(value)) {
    return value.map(redact)
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (['endpoint', 'path', 'token', 'secret', 'apiKey', 'api_key'].includes(key)) {
        return [key, '[REDACTED]']
      }

      return [key, redact(item)]
    }))
  }

  return value
}

function normalizePublicValue(value) {
  if (!value || String(value).startsWith('CHANGE_ME')) {
    return undefined
  }

  return value
}

function normalizeAgentStatus(value) {
  return ['online', 'busy', 'standby', 'offline'].includes(value) ? value : 'standby'
}

function sanitizeProfileName(file) {
  const base = path.basename(file)
  if (!base.endsWith('.yaml') && !base.endsWith('.yml')) {
    return 'bonys-agents.example.yaml'
  }

  if (base.endsWith('.local.yaml') && !showPrivateValues) {
    return 'bonys-agents.example.yaml'
  }

  return base
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'operator'
}

function readPackageVersion() {
  try {
    const packagePath = path.join(rootDir, 'package.json')
    const raw = JSON.parse(readFileSync(packagePath, 'utf8'))
    return raw.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, jsonHeaders)
  response.end(JSON.stringify(payload, null, 2))
}

async function serveStatic(response, pathname) {
  const distDir = path.join(rootDir, 'dist')
  const safePath = pathname === '/' ? '/index.html' : pathname
  const filePath = path.normalize(path.join(distDir, safePath))

  if (!filePath.startsWith(distDir)) {
    return sendJson(response, 403, { error: 'forbidden' })
  }

  try {
    const body = await readFile(filePath)
    response.writeHead(200, {
      'content-type': contentType(filePath),
      'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
    })
    response.end(body)
  } catch {
    const indexPath = path.join(distDir, 'index.html')
    if (!existsSync(indexPath)) {
      return sendJson(response, 404, { error: 'frontend_not_built' })
    }

    const body = await readFile(indexPath)
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(body)
  }
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8'
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8'
  if (filePath.endsWith('.svg')) return 'image/svg+xml'
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}

function readDefaultGateways() {
  try {
    return defaultGateways(readFileSync('/proc/net/route', 'utf8'))
  } catch {
    return []
  }
}
