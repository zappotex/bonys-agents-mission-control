import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const MAX_MESSAGES = 200

export async function readChat(dataDir, conversationId) {
  if (!dataDir) return []
  const file = chatFile(dataDir, conversationId)
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return Array.isArray(parsed) ? parsed.slice(-MAX_MESSAGES) : []
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

export async function appendChat(dataDir, conversationId, messages) {
  if (!dataDir) throw new Error('chat_storage_unavailable')
  const current = await readChat(dataDir, conversationId)
  const next = [...current, ...messages].slice(-MAX_MESSAGES)
  const dir = path.join(dataDir, 'chat')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(chatFile(dataDir, conversationId), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  return next
}

function chatFile(dataDir, conversationId) {
  if (!/^[a-zA-Z0-9._-]{1,180}$/.test(conversationId)) throw new Error('invalid_chat_conversation')
  return path.join(dataDir, 'chat', `${conversationId}.json`)
}
