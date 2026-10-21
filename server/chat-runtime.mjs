const MAX_MESSAGE_LENGTH = 4000

export function normalizeChatRequest(payload, knownAgentIds) {
  const known = new Set(Array.isArray(knownAgentIds) ? knownAgentIds.filter((id) => typeof id === 'string') : [])
  const mode = payload?.mode === 'team' ? 'team' : payload?.mode === 'single' ? 'single' : ''
  const agentIds = Array.from(new Set(Array.isArray(payload?.agentIds) ? payload.agentIds.filter((id) => typeof id === 'string') : []))
  const message = typeof payload?.message === 'string' ? payload.message.trim() : ''
  if (!mode || !message || message.length > MAX_MESSAGE_LENGTH || !agentIds.length || agentIds.some((id) => !known.has(id))) {
    throw new Error('invalid_chat_request')
  }
  if (mode === 'single' && agentIds.length !== 1) throw new Error('invalid_chat_request')
  return { mode, agentIds, message }
}

export function normalizePeerReply(payload) {
  const candidates = [payload?.output, payload?.text, payload?.message, payload?.content, payload?.result?.output, payload?.result?.text, payload?.result?.content]
  const value = candidates.find((item) => typeof item === 'string' && item.trim())
  return typeof value === 'string' ? value.trim().slice(0, 12000) : ''
}

export function chatConversationId(profile, mode, agentIds) {
  const safeProfile = String(profile).replace(/[^a-zA-Z0-9._-]/g, '_')
  const safeAgents = [...agentIds].sort().join('-').replace(/[^a-zA-Z0-9._-]/g, '_')
  return `${safeProfile}-${mode}-${safeAgents}`.slice(0, 180)
}
