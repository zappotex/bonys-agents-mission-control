import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { MessageSquare, Send, Users } from 'lucide-react'

type Agent = { id: string; name: string; type: string; status: string }
type Message = { id: string; role: 'user' | 'assistant'; agentId?: string; agentName?: string; content: string; createdAt: string; error?: boolean }

export function ChatPanel({ profile, agents }: { profile: string; agents: Agent[] }) {
  const chatAgents = useMemo(() => agents.filter((agent) => agent.type === 'hermes-peer'), [agents])
  const [mode, setMode] = useState<'single' | 'team'>('single')
  const [selected, setSelected] = useState<string[]>(() => chatAgents[0]?.id ? [chatAgents[0].id] : [])
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!profile || !selected.length) return
    const query = new URLSearchParams({ profile, mode, agents: selected.join(',') })
    fetch(`/api/chat?${query}`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('history')))
      .then((result: { messages?: Message[] }) => setMessages(result.messages || []))
      .catch(() => setMessages([]))
  }, [profile, mode, selected])

  function selectAgent(id: string) {
    setSelected((current) => mode === 'single' ? [id] : current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault()
    if (!text.trim() || !selected.length || sending) return
    setSending(true); setError('')
    try {
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile, mode, agentIds: selected, message: text }) })
      const result = await response.json() as { messages?: Message[]; error?: string }
      if (!response.ok) throw new Error(result.error || 'chat_unavailable')
      setMessages(result.messages || [])
      setText('')
    } catch { setError('Die Nachricht konnte nicht zugestellt werden.') } finally { setSending(false) }
  }

  return <section id="chat" className="panel chat-panel">
    <div className="section-heading"><div><p className="eyebrow">Direkte Kommunikation</p><h2><MessageSquare size={21} /> Agenten-Chat</h2><p className="muted">Einzelchat oder unabhängiger Teamchat — jeder Agent erhält die Originalnachricht.</p></div></div>
    <div className="chat-toolbar">
      <div className="chat-mode"><button className={mode === 'single' ? 'active' : ''} onClick={() => { setMode('single'); setSelected(selected.slice(0, 1)) }}>Einzelchat</button><button className={mode === 'team' ? 'active' : ''} onClick={() => setMode('team')}>Teamchat</button></div>
      <div className="chat-agents">{chatAgents.map((agent) => <button key={agent.id} className={selected.includes(agent.id) ? 'selected' : ''} onClick={() => selectAgent(agent.id)}><Users size={14} /> {agent.name}</button>)}</div>
    </div>
    <div className="chat-history" aria-live="polite">{messages.length ? messages.map((message) => <article className={`chat-message ${message.role} ${message.error ? 'error' : ''}`} key={message.id}><strong>{message.role === 'user' ? 'Du' : message.agentName || message.agentId || 'Agent'}</strong><p>{message.content}</p></article>) : <p className="empty-state">Noch keine Nachrichten in diesem Chat.</p>}</div>
    <form className="chat-composer" onSubmit={sendMessage}><textarea value={text} onChange={(event) => setText(event.target.value)} placeholder={selected.length ? 'Nachricht an den Agenten schreiben …' : 'Zuerst einen Agenten auswählen'} disabled={sending || !selected.length} maxLength={4000} /><button type="submit" disabled={sending || !text.trim() || !selected.length}><Send size={17} /> {sending ? 'Warte …' : 'Senden'}</button></form>
    {error && <p className="error-text">{error}</p>}
  </section>
}
