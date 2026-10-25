import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Mic, Square, Volume2 } from 'lucide-react'
import { speak } from './voice-client'

const MAX_RECORDING_MS = 120_000

// Spracheingabe und Vorlesen über den Sprachdienst im Agent-PC (Backend: /api/voice/*).
// Der Text landet nur im Feld – abgeschickt wird erst mit „Senden“ bzw. „Mission anlegen“.

function recorderType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  return candidates.find((type) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) || ''
}

export function MicButton({ onText, disabled = false, label = 'Spracheingabe' }:
  { onText: (text: string) => void; disabled?: boolean; label?: string }) {
  const [state, setState] = useState<'idle' | 'recording' | 'converting'>('idle')
  const [error, setError] = useState('')
  const recorder = useRef<MediaRecorder | null>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => {
    window.clearTimeout(timer.current)
    recorder.current?.stream.getTracks().forEach((track) => track.stop())
  }, [])

  async function start() {
    setError('')
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setError('Kein Zugriff auf das Mikrofon – bitte im Browser erlauben.')
      return
    }
    const type = recorderType()
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
    const chunks: Blob[] = []
    rec.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
    rec.onstop = async () => {
      window.clearTimeout(timer.current)
      stream.getTracks().forEach((track) => track.stop())
      const audio = new Blob(chunks, { type: (rec.mimeType || 'audio/webm').split(';', 1)[0] })
      if (!audio.size) { setState('idle'); return }
      setState('converting')
      try {
        const response = await fetch('/api/voice/transcribe', { method: 'POST', headers: { 'content-type': audio.type }, body: audio })
        const result = await response.json() as { transcript?: string }
        if (!response.ok) throw new Error('transcribe')
        if (result.transcript?.trim()) onText(result.transcript.trim())
        else setError('Nichts verstanden – bitte noch einmal sprechen.')
      } catch {
        setError('Die Spracheingabe ist gerade nicht verfügbar.')
      } finally {
        setState('idle')
      }
    }
    recorder.current = rec
    rec.start()
    setState('recording')
    timer.current = window.setTimeout(() => { if (rec.state === 'recording') rec.stop() }, MAX_RECORDING_MS)
  }

  function toggle() {
    if (state === 'recording') recorder.current?.stop()
    else if (state === 'idle') void start()
  }

  const title = state === 'recording' ? 'Aufnahme beenden' : state === 'converting' ? 'Wird umgewandelt …' : label
  return <span className="voice-control">
    <button type="button" className={`voice-button ${state}`} onClick={toggle} disabled={disabled || state === 'converting'}
      aria-label={title} aria-pressed={state === 'recording'} title={title}>
      {state === 'recording' ? <Square size={16} /> : state === 'converting' ? <LoaderCircle size={16} className="spin" /> : <Mic size={16} />}
      <span>{state === 'recording' ? 'Stopp' : state === 'converting' ? 'Umwandeln …' : 'Sprechen'}</span>
    </button>
    {error && <span className="voice-error" role="status">{error}</span>}
  </span>
}

export function SpeakButton({ text }: { text: string }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  async function play() {
    setBusy(true); setFailed(false)
    try { await speak(text) } catch { setFailed(true) } finally { setBusy(false) }
  }
  return <button type="button" className="speak-button" onClick={() => void play()} disabled={busy}
    title={failed ? 'Vorlesen gerade nicht möglich' : 'Vorlesen'} aria-label="Vorlesen">
    {busy ? <LoaderCircle size={14} className="spin" /> : <Volume2 size={14} />}
  </button>
}
