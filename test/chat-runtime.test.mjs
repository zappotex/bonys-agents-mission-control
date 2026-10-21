import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeChatRequest, normalizePeerReply } from '../server/chat-runtime.mjs'

test('normalisiert Einzelchat und begrenzt die Nachricht', () => {
  const result = normalizeChatRequest({ mode: 'single', agentIds: ['barney'], message: '  Hallo  ' }, ['barney', 'lily'])
  assert.deepEqual(result, { mode: 'single', agentIds: ['barney'], message: 'Hallo' })
})

test('Teamchat akzeptiert nur bekannte, eindeutige Agenten', () => {
  const result = normalizeChatRequest({ mode: 'team', agentIds: ['barney', 'barney', 'lily'], message: 'Test' }, ['barney', 'lily'])
  assert.deepEqual(result.agentIds, ['barney', 'lily'])
  assert.equal(result.mode, 'team')
})

test('Antworten werden auf sichtbaren Text reduziert', () => {
  assert.equal(normalizePeerReply({ output: ' Antwort ' }), 'Antwort')
  assert.equal(normalizePeerReply({ result: { content: 'Ergebnis' } }), 'Ergebnis')
})

test('ungültige Chat-Anfragen werden fail-closed abgelehnt', () => {
  assert.throws(() => normalizeChatRequest({ mode: 'single', agentIds: ['unknown'], message: 'x' }, ['barney']), /invalid_chat_request/)
})
