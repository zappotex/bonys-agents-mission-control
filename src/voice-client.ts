import { useEffect, useState } from 'react'

// Spracheingabe und Vorlesen: Status des Sprachdienstes und Abspielen (Backend: /api/voice/*)

export type VoiceStatus = { available: boolean; speech?: boolean }

export function useVoiceStatus(): VoiceStatus {
  const [status, setStatus] = useState<VoiceStatus>({ available: false })
  useEffect(() => {
    let active = true
    fetch('/api/voice/status')
      .then((response) => response.ok ? response.json() : { available: false })
      .then((result: VoiceStatus) => { if (active) setStatus({ available: result.available === true, speech: result.speech === true }) })
      .catch(() => { if (active) setStatus({ available: false }) })
    return () => { active = false }
  }, [])
  return status
}

// Nur eine Stimme gleichzeitig: ein neues Vorlesen beendet das laufende
let current: HTMLAudioElement | null = null

export async function speak(text: string): Promise<void> {
  const clean = text.trim().slice(0, 4000)
  if (!clean) return
  const response = await fetch('/api/voice/speak', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: clean }) })
  if (!response.ok) throw new Error('speak')
  const url = URL.createObjectURL(await response.blob())
  current?.pause()
  const audio = new Audio(url)
  current = audio
  await new Promise<void>((resolve) => {
    audio.onended = audio.onerror = audio.onpause = () => { URL.revokeObjectURL(url); resolve() }
    audio.play().catch(() => resolve())
  })
}
