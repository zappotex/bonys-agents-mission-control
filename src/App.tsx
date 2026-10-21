import {
  Activity,
  Bot,
  CheckCircle2,
  CircleDot,
  Copy,
  Cpu,
  Download,
  FileText,
  FolderKanban,
  GitBranch,
  HardDrive,
  MessageSquare,
  Network,
  Pencil,
  PlayCircle,
  Plus,
  RadioTower,
  Save,
  Settings2,
  ShieldCheck,
  SquareStop,
  Users,
  WandSparkles,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { parse } from 'yaml'
import {
  canStartMissionRun,
  createMissionRunPoller,
  filterMissions,
  formatMissionTimestamp,
  missionStateCounts,
  missionEmptyState,
  missionRunActionLabel,
  missionHistoryForDisplay,
  missionDescriptionForDisplay,
  missionOwnerForDisplay,
  missionResultForClipboard,
  missionStateClass,
  missionStateLabel,
  missionTitleForDisplay,
  resultKindLabelForMission,
  missionFilterSummary,
  normalizeMissionResponse,
  outboxMissions,
  resultKindForMission,
  replaceMission,
} from './mission-runtime.mjs'
import {
  applyBootstrapFailure,
  applyBootstrapSuccess,
  createBootstrapPoller,
  deriveWizardIdentity,
  persistSelectedProfile,
  readStoredProfile,
  rollbackProfileAfterFailure,
} from './bootstrap-runtime.mjs'
import agentsYaml from '../config/agents.yaml?raw'
import bonysProfileYaml from '../profiles/bonys-agents.example.yaml?raw'
import { ChatPanel } from './ChatPanel'
import './App.css'

type AgentStatus = 'online' | 'busy' | 'standby' | 'offline'
type AgentType = 'human' | 'hermes-peer' | 'local-agent' | 'placeholder'

type Agent = {
  id: string
  name: string
  role: string
  type: AgentType
  status: AgentStatus
  statusSource?: 'live' | 'configured' | 'stale'
  activitySource?: 'hermes-detailed' | 'reachability'
  tags: string[]
  endpoint?: string
}

type UpdateState = {
  status: 'idle' | 'checking' | 'ready' | 'failed'
  currentVersion?: string
  latestVersion?: string
  updateAvailable?: boolean
  releaseUrl?: string
  command?: string
}

type AgentConfig = {
  id?: string
  name?: string
  role?: string
  type?: AgentType
  status?: AgentStatus
  tags?: string[]
  endpoint?: string
  enabled?: boolean
}

type AgentsConfig = {
  agents?: AgentConfig[]
}

type TeamProfile = {
  agents?: AgentConfig[]
  team?: {
    owner?: string
    coordinator?: string
    agents?: string[]
  }
}

type ProfileMeta = {
  file: string
  name: string
  slug: string
  description?: string
  theme?: string
  publishSafe: boolean
  localOnly: boolean
}

type ProjectDocument = {
  id: string
  title: string
  date: string
  tags: string[]
}

type BootstrapData = {
  app?: {
    name: string
    version: string
  }
  source: 'backend' | 'fallback'
  activeProfile: ProfileMeta
  profiles: ProfileMeta[]
  team?: {
    owner?: string
    coordinator?: string
  }
  agents: Agent[]
  projectIndex: {
    status: 'disabled' | 'ready' | 'unavailable'
    documents: ProjectDocument[]
  }
  privacy?: {
    privateValuesVisible: boolean
    redaction: string
  }
}

type MissionRunHistoryEntry = {
  attempt: number
  runId?: string
  agentId?: string
  status?: Mission['runStatus']
  startedAt?: string
  finishedAt?: string
}

type Mission = {  id: string
  profile: string
  title: string
  owner: string
  state: 'running' | 'planned' | 'review' | 'done'
  description: string
  result?: string
  resultKind?: 'note' | 'link' | 'file'
  createdAt: string
  runId?: string
  runAttempt?: number
  idempotencyKey?: string
  runStartedAt?: string
  runFinishedAt?: string
  agentId?: string
  runStatus?: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  runError?: string
  runHistory?: MissionRunHistoryEntry[]
  updatedAt: string
}

type MissionDraft = {
  title: string
  description: string
  result: string
  resultKind: 'note' | 'link' | 'file'
  owner: string
}

type WizardState = {
  teamName: string
  ownerName: string
  coordinatorName: string
  agentNames: string
  projectPath: string
  notesPath: string
  outputPath: string
  theme: 'bonys-agents-cyberpunk' | 'default-dark' | 'minimal'
  usesHermesPeers: boolean
  usesObsidian: boolean
}

const publicAgentsConfig = parse(agentsYaml) as AgentsConfig
const publicBonysProfile = parse(bonysProfileYaml) as TeamProfile

const fallbackBootstrap: BootstrapData = {
  source: 'fallback',
  activeProfile: {
    file: 'profiles/bonys-agents.example.yaml',
    name: 'Bonys Agents',
    slug: 'bonys-agents',
    description: 'Vorkonfiguriertes öffentliches Example-Profil.',
    theme: 'bonys-agents-cyberpunk',
    publishSafe: true,
    localOnly: false,
  },
  profiles: [],
  team: {
    owner: publicBonysProfile.team?.owner,
    coordinator: publicBonysProfile.team?.coordinator,
  },
  agents: buildAgentsFromConfig(publicAgentsConfig, publicBonysProfile),
  projectIndex: {
    status: 'disabled',
    documents: [],
  },
  privacy: {
    privateValuesVisible: false,
    redaction: 'frontend fallback uses publish-safe example data',
  },
}

const defaultWizardState: WizardState = {
  teamName: 'Bonys Agents',
  ownerName: 'Bony',
  coordinatorName: 'Phaseone0815',
  agentNames: 'Phaseone0815, Barney, Current, Lily',
  projectPath: '/path/to/projects',
  notesPath: '/path/to/obsidian-or-markdown-vault',
  outputPath: '/path/to/output-folder',
  theme: 'bonys-agents-cyberpunk',
  usesHermesPeers: true,
  usesObsidian: true,
}

const statusTone: Record<AgentStatus, string> = {
  online: 'status-online',
  busy: 'status-busy',
  standby: 'status-standby',
  offline: 'status-offline',
}

const stateLabels = {
  running: 'Aktiv',
  planned: 'Geplant',
  review: 'Review',
  done: 'Fertig',
}

const resultKindLabels = {
  note: 'Notiz',
  link: 'Link',
  file: 'Datei-Referenz',
}

function getBrowserStorage() {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function App() {
  const [wizard, setWizard] = useState<WizardState>(defaultWizardState)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [outboxCopyId, setOutboxCopyId] = useState('')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'exists' | 'failed'>('idle')
  const [bootstrap, setBootstrap] = useState<BootstrapData>(fallbackBootstrap)
  const [apiState, setApiState] = useState<'loading' | 'backend' | 'degraded' | 'fallback'>('loading')
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' })
  const [selectedProfile, setSelectedProfile] = useState(() => readStoredProfile(getBrowserStorage()))
  const [missions, setMissions] = useState<Mission[]>([])
  const [missionProfile, setMissionProfile] = useState('')
  const [missionState, setMissionState] = useState<'ready' | 'saving' | 'unavailable' | 'failed'>('ready')
  const [missionRunPollingFailed, setMissionRunPollingFailed] = useState(false)
  const [missionPendingId, setMissionPendingId] = useState('')
  const [missionDraft, setMissionDraft] = useState<MissionDraft>({ title: '', description: '', result: '', resultKind: 'note', owner: '' })
  const [missionEditId, setMissionEditId] = useState('')
  const [missionEditDraft, setMissionEditDraft] = useState<MissionDraft>({ title: '', description: '', result: '', resultKind: 'note', owner: '' })
  const [missionFilter, setMissionFilter] = useState<'all' | Mission['state']>('all')
  const [missionQuery, setMissionQuery] = useState('')
  const missionsRef = useRef<Mission[]>([])
  const loadedProfileFile = useRef('')
  const hasBackendData = useRef(false)
  const confirmedProfileFile = useRef('')
  const missionRunPollerRef = useRef<ReturnType<typeof createMissionRunPoller> | null>(null)

  useEffect(() => {
    const poller = createBootstrapPoller({
      fetchBootstrap: async (profile: string, signal: AbortSignal) => {
        const profileQuery = profile ? `?profile=${encodeURIComponent(profile)}` : ''
        const response = await fetch(`/api/bootstrap${profileQuery}`, { signal })
        if (!response.ok) {
          throw new Error(`Backend returned ${response.status}`)
        }
        return response.json() as Promise<BootstrapData>
      },
      onSuccess: (data: BootstrapData) => {
        hasBackendData.current = true
        confirmedProfileFile.current = data.activeProfile.file
        persistSelectedProfile(getBrowserStorage(), data.activeProfile.file)
        const result = applyBootstrapSuccess(data)
        setBootstrap(result.bootstrap)
        if (loadedProfileFile.current !== data.activeProfile.file) {
          loadedProfileFile.current = data.activeProfile.file
          setWizard((current) => ({
            ...current,
            teamName: data.activeProfile.name,
            ...deriveWizardIdentity(data, current),
            theme: data.activeProfile.theme && ['bonys-agents-cyberpunk', 'default-dark', 'minimal'].includes(data.activeProfile.theme)
              ? data.activeProfile.theme as WizardState['theme']
              : current.theme,
          }))
        }
        setApiState(result.apiState)
      },
      onFailure: () => {
        const hasConfirmedBackendData = hasBackendData.current
        setApiState(hasConfirmedBackendData ? 'degraded' : 'fallback')
        setBootstrap((current) => applyBootstrapFailure(
          current,
          fallbackBootstrap,
          hasConfirmedBackendData,
        ).bootstrap)
        const rollbackProfile = rollbackProfileAfterFailure(selectedProfile, confirmedProfileFile.current)
        if (rollbackProfile !== undefined) {
          persistSelectedProfile(getBrowserStorage(), rollbackProfile)
          setSelectedProfile(rollbackProfile)
        }
      },
    })

    poller.start(selectedProfile)
    return () => poller.stop()
  }, [selectedProfile])

  useEffect(() => {
    void checkForUpdates()
  }, [])

  const agents = bootstrap.agents
  const activeProfile = bootstrap.activeProfile
  const missionOwners = useMemo(() => Array.from(new Set(agents.map((agent) => agent.name))), [agents])
  const missionDraftOwner = missionOwners.includes(missionDraft.owner)
    ? missionDraft.owner
    : bootstrap.team?.coordinator || missionOwners[0] || ''
  const missionLoading = missionProfile !== activeProfile.file
  const visibleMissions = missionLoading ? [] : filterMissions(missions, missionFilter, missionQuery)
  const completedMissions = missionLoading ? [] : outboxMissions(missions)
  const missionCounts = missionStateCounts(missions)
  const hasPendingMissionRuns = !missionLoading && missions.some((mission) => (
    Boolean(mission.runId) && ['starting', 'running'].includes(mission.runStatus || '')
  ))

  useEffect(() => {
    missionsRef.current = missions
  }, [missions])

  useEffect(() => {
    const controller = new AbortController()
    const profile = activeProfile.file
    fetch(`/api/missions?profile=${encodeURIComponent(profile)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Backend returned ${response.status}`)
        const result = normalizeMissionResponse(await response.json())
        setMissions(result.missions)
        setMissionProfile(profile)
        setMissionState(result.storageAvailable ? 'ready' : 'unavailable')
        setMissionRunPollingFailed(false)
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setMissions([])
        setMissionProfile(profile)
        setMissionState('failed')
      })
    return () => controller.abort()
  }, [activeProfile.file])

  useEffect(() => {
    if (!hasPendingMissionRuns) return
    const profile = activeProfile.file
    const poller = createMissionRunPoller({
      getMissions: () => missionsRef.current,
      fetchStatus: async (mission: Mission, currentProfile: string, signal: AbortSignal) => {
        const response = await fetch(`/api/missions/${encodeURIComponent(mission.id)}/run/status`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ profile: currentProfile }),
          signal,
        })
        if (!response.ok) throw new Error(`Backend returned ${response.status}`)
        return (await response.json() as { mission: Mission }).mission
      },
      onMission: (mission: Mission) => {
        setMissions((current) => replaceMission(current, mission))
        setMissionRunPollingFailed(false)
      },
      onFailure: () => setMissionRunPollingFailed(true),
    })
    missionRunPollerRef.current = poller
    poller.start(profile)
    return () => {
      poller.stop()
      if (missionRunPollerRef.current === poller) missionRunPollerRef.current = null
    }
  }, [activeProfile.file, hasPendingMissionRuns])

  const generatedProfile = useMemo(() => buildProfileYaml(wizard), [wizard])
  const generatedSlug = useMemo(() => slugify(wizard.teamName), [wizard.teamName])

  function downloadProfile() {
    const blob = new Blob([generatedProfile], { type: 'application/yaml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${generatedSlug || 'agent-team'}.profile.yaml`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  function copyProfile() {
    try {
      copyTextFallback(generatedProfile)
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 5000)
    } catch {
      setCopyState('failed')
      window.setTimeout(() => setCopyState('idle'), 2200)
    }
  }

  function copyMissionResult(mission: Mission) {
    const result = missionResultForClipboard(mission)
    if (!result) return
    try {
      copyTextFallback(result)
      setOutboxCopyId(mission.id)
      window.setTimeout(() => setOutboxCopyId(''), 3000)
    } catch {
      setOutboxCopyId('failed')
      window.setTimeout(() => setOutboxCopyId(''), 2200)
    }
  }
  async function saveProfile() {
    setSaveState('saving')
    try {
      const response = await fetch('/api/profiles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...wizard,
          agentNames: wizard.agentNames.split(',').map((agent) => agent.trim()).filter(Boolean),
        }),
      })
      if (response.status === 409) {
        setSaveState('exists')
        return
      }
      if (!response.ok) throw new Error(`Backend returned ${response.status}`)
      const result = await response.json() as { file: string; selectable: boolean }
      if (result.selectable) setSelectedProfile(result.file)
      setSaveState('saved')
    } catch {
      setSaveState('failed')
    }
  }

  async function createMissionEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!missionDraft.title.trim() || !missionDraftOwner) return
    setMissionState('saving')
    try {
      const response = await fetch('/api/missions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profile: activeProfile.file,
          title: missionDraft.title,
          description: missionDraft.description,
          owner: missionDraftOwner,
        }),
      })
      if (!response.ok) throw new Error(`Backend returned ${response.status}`)
      const result = await response.json() as { mission: Mission }
      setMissions((current) => replaceMission(current, result.mission))
      setMissionDraft((current) => ({ ...current, title: '', description: '', result: '', resultKind: 'note' }))
      setMissionState('ready')
    } catch {
      setMissionState('failed')
    }
  }

  async function updateMissionEntry(mission: Mission, changes: Partial<Pick<Mission, 'title' | 'description' | 'result' | 'resultKind' | 'owner' | 'state'>>) {
    setMissionPendingId(mission.id)
    try {
      const response = await fetch(`/api/missions/${encodeURIComponent(mission.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: activeProfile.file, ...changes }),
      })
      if (!response.ok) throw new Error(`Backend returned ${response.status}`)
      const result = await response.json() as { mission: Mission }
      setMissions((current) => replaceMission(current, result.mission))
      setMissionState('ready')
      setMissionRunPollingFailed(false)
      return true
    } catch {
      setMissionState('failed')
      return false
    } finally {
      setMissionPendingId('')
    }
  }

  function beginMissionEdit(mission: Mission) {
    setMissionEditId(mission.id)
    setMissionEditDraft({ title: mission.title, description: mission.description, result: mission.result || '', resultKind: mission.resultKind || 'note', owner: mission.owner })
  }

  async function saveMissionEdit(mission: Mission) {
    if (!missionEditDraft.title.trim()) return
    const saved = await updateMissionEntry(mission, {
      title: missionEditDraft.title,
      description: missionEditDraft.description,
      result: missionEditDraft.result,
      resultKind: missionEditDraft.resultKind,
    })
    if (saved) setMissionEditId('')
  }

  async function startMissionRun(mission: Mission) {
    setMissionPendingId(mission.id)
    try {
      const response = await fetch(`/api/missions/${encodeURIComponent(mission.id)}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: activeProfile.file }),
      })
      if (!response.ok) throw new Error(`Backend returned ${response.status}`)
      const result = await response.json() as { mission: Mission }
      setMissions((current) => replaceMission(current, result.mission))
      setMissionState('ready')
      setMissionRunPollingFailed(false)
    } catch {
      setMissionState('failed')
    } finally {
      setMissionPendingId('')
    }
  }

  async function stopMissionRun(mission: Mission) {
    const poller = missionRunPollerRef.current
    poller?.invalidate(mission.id)
    setMissionPendingId(mission.id)
    try {
      const response = await fetch(`/api/missions/${encodeURIComponent(mission.id)}/run/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: activeProfile.file }),
      })
      if (!response.ok) throw new Error(`Backend returned ${response.status}`)
      const result = await response.json() as { mission: Mission }
      setMissions((current) => replaceMission(current, result.mission))
      if (['starting', 'running'].includes(result.mission.runStatus || '')) poller?.resume(mission.id)
      setMissionState('ready')
      setMissionRunPollingFailed(false)
    } catch {
      poller?.resume(mission.id)
      setMissionState('failed')
    } finally {
      setMissionPendingId('')
    }
  }

  async function checkForUpdates() {
    setUpdateState({ status: 'checking' })
    try {
      const response = await fetch('/api/update')
      if (!response.ok) throw new Error(`Backend returned ${response.status}`)
      const result = await response.json() as Omit<UpdateState, 'status'> & { error?: string }
      if (result.error || !result.latestVersion) throw new Error('update_check_failed')
      setUpdateState({ status: 'ready', ...result })
    } catch {
      setUpdateState({ status: 'failed' })
    }
  }

  async function copyUpdateCommand() {
    if (!updateState.command) return
    try {
      await navigator.clipboard.writeText(updateState.command)
      setUpdateState((current) => ({ ...current, status: 'ready' }))
    } catch {
      setUpdateState((current) => ({ ...current, status: 'failed' }))
    }
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand-mark brand-mark-image">
          <img src="/assets/bonys-agents-hero.jpg" alt="Bonys Agents – drei futuristische Agenten" />
        </div>
        <div>
          <p className="eyebrow">Bonys Agents</p>
          <h1>Mission Control</h1>
          <p className="muted">
            Open-source Cockpit für konfigurierbare Agenten-Flotten — mit Bonys Team als fertigem Preset.
          </p>
        </div>
        <nav className="nav-list" aria-label="Mission Control Bereiche">
          <a href="#fleet"><Users size={18} /> Agenten-Flotte</a>
          <a href="#chat"><MessageSquare size={18} /> Agenten-Chat</a>
          <a href="#missions"><FolderKanban size={18} /> Mission Board</a>
          <a href="#setup"><WandSparkles size={18} /> Setup-Wizard</a>
          <a href="#config"><Settings2 size={18} /> Konfiguration</a>
          <a href="#status"><Activity size={18} /> Systemstatus</a>
          <a href="#updates"><Download size={18} /> Updates</a>
        </nav>
        <div className="profile-card">
          <p className="eyebrow">Aktives Profil</p>
          <label className="field profile-select">
            <span>Teamprofil auswählen</span>
            <select
              value={selectedProfile || activeProfile.file}
              onChange={(event) => setSelectedProfile(event.target.value)}
            >
              {(bootstrap.profiles.length ? bootstrap.profiles : [activeProfile]).map((profile) => (
                <option key={profile.file} value={profile.file}>
                  {profile.name}{profile.localOnly ? ' · lokal' : profile.publishSafe ? ' · öffentlich' : ''}
                </option>
              ))}
            </select>
          </label>
          <strong>{activeProfile.file}</strong>
          <span>{apiState === 'backend'
            ? 'Live aus Backend-YAML geladen.'
            : apiState === 'degraded'
              ? 'Letzte API-Daten; Aktualisierung gestört.'
              : 'Frontend-Fallback aus Example-YAML.'}</span>
        </div>
      </aside>

      <section className="workspace">
        <header className="hero-panel">
          <div>
            <p className="eyebrow">v{bootstrap.app?.version || 'Entwicklung'} · Live Peer Status</p>
            <h2>Ein Dashboard für jedes Agenten-Team.</h2>
            <p>
              Nicht hart auf Bony verdrahtet: Agenten, Rollen, Peers, Projektpfade und Themes werden über Profile konfiguriert.
            </p>
          </div>
          <div className="hero-grid">
            <Metric icon={<Bot />} label="Agenten" value={agents.length.toString()} />
            <Metric icon={<FolderKanban />} label="Missionen" value={missionCounts.all.toString()} />
            <Metric icon={<ShieldCheck />} label="Lizenz" value="GPL" />
            <Metric
              icon={<GitBranch />}
              label="Datenquelle"
              value={apiState === 'backend' ? 'API' : apiState === 'degraded' ? 'API gestört' : 'Fallback'}
            />
          </div>
        </header>

        <ChatPanel profile={activeProfile.file} agents={agents} />

        <section id="fleet" className="panel">
          <SectionTitle icon={<Users />} title="Agenten-Flotte" subtitle="Bonys Preset als Beispiel. Andere Nutzer ersetzen diese Konfiguration durch ihr eigenes Team." />
          <div className="agent-grid">
            {agents.map((agent) => (
              <article className="agent-card" key={agent.id}>
                <div className="agent-topline">
                  <div className="agent-avatar">{agent.name.slice(0, 2).toUpperCase()}</div>
                  <span
                    className={`status-pill ${statusTone[agent.status]}`}
                    title={agent.statusSource === 'live'
                      ? agent.activitySource === 'hermes-detailed'
                        ? 'Live: Arbeitsstatus über authentifizierte Hermes-Detaildaten'
                        : 'Live: nur Erreichbarkeit über den Hermes-Healthcheck'
                      : agent.statusSource === 'stale'
                        ? 'Letzte Live-Prüfung fehlgeschlagen'
                        : 'Konfigurierter Standardstatus'}
                  >
                    <CircleDot size={14} /> {agent.status}{agent.statusSource === 'live' ? ' · live' : agent.statusSource === 'stale' ? ' · stale' : ''}
                  </span>
                </div>
                <h3>{agent.name}</h3>
                <p>{agent.role}</p>
                <div className="type-line"><Network size={15} /> {agent.type}</div>
                {agent.endpoint && <div className="endpoint">{agent.endpoint}</div>}
                <div className="tag-list">
                  {agent.tags.map((tag) => <span key={tag}>{tag}</span>)}
                </div>
              </article>
            ))}
          </div>
        </section>

        <section id="missions" className="panel split-panel">
          <div>
            <SectionTitle id="mission-board-title" icon={<FolderKanban />} title="Mission Board" subtitle="Missionen dauerhaft anlegen, Agenten zuweisen und durch ihren Arbeitsstatus führen." />
            <form className="mission-form" onSubmit={createMissionEntry}>
              <label className="field">
                <span>Titel</span>
                <input
                  required
                  maxLength={160}
                  value={missionDraft.title}
                  onChange={(event) => setMissionDraft({ ...missionDraft, title: event.target.value })}
                  placeholder="Neue Mission"
                />
              </label>
              <label className="field">
                <span>Beschreibung</span>
                <textarea
                  maxLength={2000}
                  value={missionDraft.description}
                  onChange={(event) => setMissionDraft({ ...missionDraft, description: event.target.value })}
                  placeholder="Ziel und erwartetes Ergebnis"
                />
              </label>
              <label className="field">
                <span>Zuweisen an</span>
                <select value={missionDraftOwner} onChange={(event) => setMissionDraft({ ...missionDraft, owner: event.target.value })}>
                  {missionOwners.map((owner) => <option key={owner} value={owner}>{owner}</option>)}
                </select>
              </label>
              <button
                type="submit"
                className="primary-button"
                disabled={missionLoading || missionState === 'saving' || missionState === 'unavailable' || !missionDraftOwner}
              >
                <Plus size={16} /> {missionState === 'saving' ? 'Speichert …' : 'Mission anlegen'}
              </button>
            </form>
            {!missionLoading && missionState === 'unavailable' && <p className="muted" role="status">Für Missionen ist noch kein lokaler Datenordner konfiguriert.</p>}
            {!missionLoading && missionState === 'failed' && <p className="mission-error" role="alert">Mission Board konnte nicht gespeichert oder geladen werden.</p>}
            {!missionLoading && missionRunPollingFailed && <p className="mission-error" role="status">Der Hermes-Run-Status konnte nicht aktualisiert werden. Der letzte bestätigte Stand bleibt sichtbar.</p>}
            <div className="mission-filters" aria-label="Missionen filtern" aria-controls="mission-list">
              <span className="muted">Ansicht</span>
              {([['all', 'Alle'], ...Object.entries(stateLabels)] as Array<[typeof missionFilter, string]>).map(([state, label]) => (
                <button key={state} type="button" aria-pressed={missionFilter === state} className={missionFilter === state ? 'filter-button active' : 'filter-button'} onClick={() => setMissionFilter(state)}>
                  {label} <span className="filter-count">{missionCounts[state]}</span>
                </button>
              ))}
            </div>
            <label className="mission-search">
              <span>Missionen durchsuchen</span>
              <div className="mission-search-control">
                <input aria-describedby="mission-filter-summary" value={missionQuery} onChange={(event) => setMissionQuery(event.target.value)} placeholder="Titel, Beschreibung oder Agent" />
                {missionQuery && <button type="button" className="search-clear" aria-label="Mission-Suche leeren" onClick={() => setMissionQuery('')}><X size={15} /></button>}
              </div>
            </label>
            <p id="mission-filter-summary" className="mission-filter-summary" role="status">{missionFilterSummary({ total: missionCounts.all, visible: visibleMissions.length, query: missionQuery, state: missionFilter })}</p>
            <div id="mission-list" className="mission-list" role="region" aria-labelledby="mission-board-title" aria-busy={missionLoading}>
              {visibleMissions.map((mission) => (
                <article className="mission-row" key={mission.id}>
                  <div className="mission-copy">
                    <span className={`mission-state state-${missionStateClass(mission.state)}`}>{missionStateLabel(mission.state)}</span>
                    {missionEditId === mission.id ? (
                      <div className="mission-edit-form">
                        <label className="field">
                          <span>Titel</span>
                          <input required maxLength={160} value={missionEditDraft.title} onChange={(event) => setMissionEditDraft({ ...missionEditDraft, title: event.target.value })} />
                        </label>
                        <label className="field">
                          <span>Beschreibung</span>
                          <textarea maxLength={2000} value={missionEditDraft.description} onChange={(event) => setMissionEditDraft({ ...missionEditDraft, description: event.target.value })} />
                        </label>
                        <label className="field">
                          <span>Ergebnis / Output</span>
                          <textarea id="mission-result-output" aria-describedby="mission-result-output-hint" maxLength={4000} value={missionEditDraft.result} onChange={(event) => setMissionEditDraft({ ...missionEditDraft, result: event.target.value })} placeholder="Datei, Link oder kurze Ergebnisnotiz" />
                          <small id="mission-result-output-hint" className="field-hint">{missionEditDraft.result.length}/4000 Zeichen</small>
                        </label>
                        <label className="field">
                          <span>Ergebnisart</span>
                          <select value={missionEditDraft.resultKind} onChange={(event) => setMissionEditDraft({ ...missionEditDraft, resultKind: event.target.value as MissionDraft['resultKind'] })}>
                            {Object.entries(resultKindLabels).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
                          </select>
                        </label>
                        <div className="inline-actions">
                          <button type="button" className="primary-button" disabled={missionPendingId === mission.id || !missionEditDraft.title.trim()} onClick={() => saveMissionEdit(mission)}>
                            <Save size={15} /> Speichern
                          </button>
                          <button type="button" className="ghost-button" disabled={missionPendingId === mission.id} onClick={() => setMissionEditId('')}>
                            <X size={15} /> Abbrechen
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <h3>{missionTitleForDisplay(mission)}</h3>
                        <p>{missionDescriptionForDisplay(mission)}</p>
                        {mission.result && <p className="mission-result"><strong>Ergebnis:</strong> <small className="result-kind-badge" aria-label={`Ergebnisart: ${resultKindLabelForMission(mission)}`}>{resultKindLabelForMission(mission)}</small> {mission.result}</p>}
                        <button type="button" className="text-button" disabled={missionPendingId === mission.id} onClick={() => beginMissionEdit(mission)}>
                          <Pencil size={14} /> Mission bearbeiten
                        </button>
                      </>
                    )}
                  </div>
                  <div className="mission-controls">
                    <label>
                      <span>Agent</span>
                      <select
                        value={mission.owner}
                        disabled={missionPendingId === mission.id}
                        onChange={(event) => updateMissionEntry(mission, { owner: event.target.value })}
                      >
                        {!missionOwners.includes(mission.owner) && <option value={mission.owner}>{mission.owner}</option>}
                        {missionOwners.map((owner) => <option key={owner} value={owner}>{owner}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>Status</span>
                      <select
                        value={mission.state}
                        disabled={missionPendingId === mission.id}
                        onChange={(event) => updateMissionEntry(mission, { state: event.target.value as Mission['state'] })}
                      >
                        {Object.entries(stateLabels).map(([state, label]) => <option key={state} value={state}>{label}</option>)}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={missionPendingId === mission.id || !canStartMissionRun(mission)}
                      onClick={() => startMissionRun(mission)}
                    >
                      <PlayCircle size={15} /> {missionPendingId === mission.id ? 'Startet …' : missionRunActionLabel(mission)}
                    </button>
                    {mission.runId && ['starting', 'running'].includes(mission.runStatus || '') && (
                      <button
                        type="button"
                        className="ghost-button"
                        disabled={missionPendingId === mission.id}
                        onClick={() => stopMissionRun(mission)}
                      >
                        <SquareStop size={15} /> {missionPendingId === mission.id ? 'Stoppt …' : 'Auftrag stoppen'}
                      </button>
                    )}
                    {mission.runStatus && <small className="muted">Run: {mission.runStatus}{mission.agentId ? ` · ${mission.agentId}` : ''}</small>}
                    <MissionDetails mission={mission} />
                  </div>
                </article>
              ))}
              {missionLoading && <p className="muted">Missionen werden geladen …</p>}
              {!missionLoading && visibleMissions.length === 0 && (
                <div className="mission-empty-state">
                  <p className="muted">{missionEmptyState({ total: missions.length, visible: visibleMissions.length, query: missionQuery, state: missionFilter })}</p>
                  {missions.length > 0 && (missionQuery.trim() || missionFilter !== 'all') && (
                    <button type="button" className="text-button" aria-label="Aktive Filter zurücksetzen" onClick={() => { setMissionQuery(''); setMissionFilter('all') }}>
                      Filter zurücksetzen
                    </button>
                  )}
                </div>
              )}
            </div>
            <section className="outbox-card" aria-labelledby="outbox-title" aria-live="polite">
              <div className="section-heading compact">
                <div>
                  <p className="eyebrow">Outbox</p>
                  <h3 id="outbox-title">Fertige Ergebnisse</h3>
                </div>
                <span className="muted" aria-label={`${completedMissions.length} fertige Ergebnisse`}>{completedMissions.length}</span>
              </div>
              {completedMissions.length > 0 ? (
                <ul className="outbox-list" aria-label="Fertige Missionsergebnisse">
                  {completedMissions.map((mission) => {
                    const copied = outboxCopyId === mission.id
                    const copyFailed = outboxCopyId === 'failed'
                    return <li key={mission.id} aria-label={`${missionTitleForDisplay(mission)} – ${resultKindLabelForMission(mission)}`}>
                      <strong>{missionTitleForDisplay(mission)}</strong>
                      <small>{resultKindLabels[resultKindForMission(mission) || 'note']} · {missionOwnerForDisplay(mission)}</small>
                      <time dateTime={mission.updatedAt}>{formatMissionTimestamp(mission.updatedAt)}</time>
                      <span>{mission.result}</span>
                      <button type="button" className="text-button" onClick={() => copyMissionResult(mission)} aria-live="polite" aria-atomic="true" aria-label={`Ergebnis von ${mission.title} kopieren`}>
                        {copied ? 'Kopiert' : copyFailed ? 'Kopieren fehlgeschlagen' : 'Ergebnis kopieren'}
                      </button>
                    </li>
                  })}
                </ul>
              ) : <p className="muted">Noch keine fertigen Ergebnisse hinterlegt.</p>}
            </section>
          </div>
          <div className="timeline-card">
            <p className="eyebrow">Timeline</p>
            <ol>
              <li><CheckCircle2 /> Konzept dokumentiert</li>
              <li><CheckCircle2 /> React/Vite Scaffold erstellt</li>
              <li><CheckCircle2 /> Setup-Wizard v0.2</li>
              <li><CheckCircle2 /> Profil-Export v0.3</li>
              <li><CheckCircle2 /> YAML-Konfiguration v0.4</li>
              <li><PlayCircle /> Runtime-Backend v0.5</li>
              <li><CheckCircle2 /> Hermes-Peer-Erreichbarkeit live</li>
            </ol>
            <div className="project-index">
              <p className="eyebrow">Projektindex</p>
              {bootstrap.projectIndex.status === 'ready' && bootstrap.projectIndex.documents.length > 0 ? (
                <div className="project-index-list">
                  {bootstrap.projectIndex.documents.map((document) => (
                    <article key={document.id} className="project-index-item">
                      <div>
                        <strong>{document.title}</strong>
                        <span>{document.date}</span>
                      </div>
                      {document.tags.length > 0 && (
                        <div className="tag-list">
                          {document.tags.map((tag) => <span key={tag}>{tag}</span>)}
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              ) : (
                <p className="muted">
                  {bootstrap.projectIndex.status === 'unavailable'
                    ? 'Der konfigurierte Markdown-Ordner ist nicht sicher erreichbar.'
                    : bootstrap.projectIndex.status === 'ready'
                      ? 'Keine Markdown-Dokumente gefunden.'
                      : 'Kein Markdown-/Obsidian-Index konfiguriert.'}
                </p>
              )}
            </div>
          </div>
        </section>

        <section id="setup" className="panel setup-panel">
          <SectionTitle icon={<WandSparkles />} title="Setup-Wizard" subtitle="Konfigurierbare Oberfläche für eigene Installationen mit geschützter lokaler Profilspeicherung." />
          <div className="wizard-grid">
            <form className="wizard-form">
              <WizardInput label="Teamname" value={wizard.teamName} onChange={(teamName) => setWizard({ ...wizard, teamName })} />
              <WizardInput label="Besitzer / Operator" value={wizard.ownerName} onChange={(ownerName) => setWizard({ ...wizard, ownerName })} />
              <WizardInput label="Koordinator" value={wizard.coordinatorName} onChange={(coordinatorName) => setWizard({ ...wizard, coordinatorName })} />
              <WizardInput label="Agenten, kommagetrennt" value={wizard.agentNames} onChange={(agentNames) => setWizard({ ...wizard, agentNames })} />
              <WizardInput label="Projektpfad" value={wizard.projectPath} onChange={(projectPath) => setWizard({ ...wizard, projectPath })} />
              <WizardInput label="Notiz-/Obsidian-Pfad" value={wizard.notesPath} onChange={(notesPath) => setWizard({ ...wizard, notesPath })} />
              <WizardInput label="Output-/Video-Pfad" value={wizard.outputPath} onChange={(outputPath) => setWizard({ ...wizard, outputPath })} />
              <label className="field">
                <span>Theme</span>
                <select value={wizard.theme} onChange={(event) => setWizard({ ...wizard, theme: event.target.value as WizardState['theme'] })}>
                  <option value="bonys-agents-cyberpunk">Bonys Agents Cyberpunk</option>
                  <option value="default-dark">Default Dark</option>
                  <option value="minimal">Minimal</option>
                </select>
              </label>
              <div className="toggle-row">
                <label><input type="checkbox" checked={wizard.usesHermesPeers} onChange={(event) => setWizard({ ...wizard, usesHermesPeers: event.target.checked })} /> Hermes-Peers nutzen</label>
                <label><input type="checkbox" checked={wizard.usesObsidian} onChange={(event) => setWizard({ ...wizard, usesObsidian: event.target.checked })} /> Obsidian/Markdown nutzen</label>
              </div>
            </form>
            <div>
              <div className="generated-header">
                <div>
                  <p className="eyebrow">Generiertes Profil</p>
                  <span>Vorschau — Download oder geschütztes Speichern als lokales Serverprofil.</span>
                </div>
                <div className="profile-actions">
                  <button type="button" className="ghost-button" onMouseDown={copyProfile}>
                    <Copy size={16} /> {copyState === 'copied' ? 'Kopiert' : copyState === 'failed' ? 'Fehler' : 'Kopieren'}
                  </button>
                  <button type="button" className="primary-button" onMouseDown={downloadProfile}>
                    <Download size={16} /> YAML laden
                  </button>
                  <button type="button" className="primary-button" disabled={saveState === 'saving'} onClick={saveProfile}>
                    <Save size={16} /> {saveState === 'saving' ? 'Speichert …' : 'Lokal speichern'}
                  </button>
                </div>
              </div>
              {saveState !== 'idle' && saveState !== 'saving' && (
                <p className="muted" role="status">
                  {saveState === 'saved'
                    ? 'Lokales Profil sicher gespeichert.'
                    : saveState === 'exists'
                      ? 'Ein lokales Profil mit diesem Namen existiert bereits.'
                      : 'Profil konnte nicht gespeichert werden.'}
                </p>
              )}
              <pre className="generated-profile">{generatedProfile}</pre>
            </div>
          </div>
        </section>

        <section id="config" className="panel config-panel">
          <SectionTitle icon={<Settings2 />} title="Config-first Architektur" subtitle="Öffentliche Installation für alle Nutzer, Bonys Team als fertiges Profil." />
          <div className="config-grid">
            <pre>{generatedProfile}</pre>
            <div className="config-notes">
              <h3>Version 1 braucht:</h3>
              <ul>
                <li><FileText /> YAML/JSON Profile im Repository</li>
                <li><Settings2 /> Setup-Wizard beim ersten Start</li>
                <li><HardDrive /> frei konfigurierbare Projekt- und Output-Pfade</li>
                <li><RadioTower /> lokale oder entfernte Hermes-Peers</li>
                <li><Cpu /> Docker/self-hosted Deployment</li>
              </ul>
            </div>
          </div>
        </section>

        <section id="updates" className="panel update-panel">
          <SectionTitle icon={<Download />} title="Updates" subtitle="Prüft das offizielle GitHub-Release und zeigt den sicheren Update-Befehl für den Agent-PC." />
          <div className="update-actions">
            <button type="button" className="primary-button" onClick={checkForUpdates} disabled={updateState.status === 'checking'}>
              <Download size={16} /> {updateState.status === 'checking' ? 'Prüft …' : 'Nach Updates suchen'}
            </button>
            {updateState.command && (
              <button type="button" className="ghost-button" onClick={copyUpdateCommand}>
                <Copy size={16} /> Update-Befehl kopieren
              </button>
            )}
          </div>
          {updateState.status === 'ready' && updateState.latestVersion && (
            <p className="muted" role="status">
              {updateState.updateAvailable
                ? <>Update verfügbar: <strong>v{updateState.latestVersion}</strong>. Auf dem Agent-PC ausführen: <code>{updateState.command}</code></>
                : <>Mission Control ist aktuell auf <strong>v{updateState.currentVersion}</strong>.</>}
              {updateState.releaseUrl && <> <a href={updateState.releaseUrl} target="_blank" rel="noreferrer">Release ansehen</a></>}
            </p>
          )}
          {updateState.status === 'failed' && <p className="mission-error" role="alert">Update-Prüfung nicht verfügbar. Bitte später erneut versuchen.</p>}
        </section>

        <section id="status" className="status-strip">
          <Metric icon={<Activity />} label="Frontend" value="läuft" />
          <Metric
            icon={<Cpu />}
            label="Backend"
            value={apiState === 'backend' ? 'aktiv' : apiState === 'degraded' ? 'gestört' : 'Fallback'}
          />
          <Metric icon={<HardDrive />} label="Profile" value={activeProfile.publishSafe ? 'publish-safe' : 'lokal'} />
          <Metric icon={<ShieldCheck />} label="Private Daten" value={bootstrap.privacy?.privateValuesVisible ? 'sichtbar' : 'redigiert'} />
        </section>
      </section>
    </main>
  )
}


function buildAgentsFromConfig(config: AgentsConfig, profile: TeamProfile): Agent[] {
  const owner = profile.team?.owner?.trim() || 'Operator'
  const ownerAgent: Agent = {
    id: slugify(owner),
    name: owner,
    role: 'Operator / Creator',
    type: 'human',
    status: 'online',
    tags: ['strategy', 'approval', 'creative-direction'],
  }

  const configuredAgentSource = Array.isArray(profile.agents) ? profile.agents : config.agents
  const configuredAgents = (configuredAgentSource || [])
    .filter((agent) => agent.enabled !== false)
    .map((agent, index): Agent => {
      const id = agent.id || `agent-${index + 1}`
      return {
        id,
        name: agent.name || id,
        role: agent.role || 'Agent',
        type: agent.type || 'placeholder',
        status: normalizeAgentStatus(agent.status),
        endpoint: normalizeEndpoint(agent.endpoint),
        tags: Array.isArray(agent.tags) ? agent.tags : [],
      }
    })

  return [ownerAgent, ...configuredAgents]
}

function normalizeEndpoint(endpoint?: string) {
  if (!endpoint || endpoint.startsWith('CHANGE_ME')) {
    return undefined
  }

  return endpoint
}

function normalizeAgentStatus(status?: AgentStatus): AgentStatus {
  return status === 'online' || status === 'busy' || status === 'offline' ? status : 'standby'
}

function copyTextFallback(text: string) {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  const successful = document.execCommand('copy')
  textarea.remove()

  if (!successful) {
    throw new Error('Copy command failed')
  }
}

function MissionDetails({ mission }: { mission: Mission }) {
  const history = missionHistoryForDisplay(mission)
  return (
    <details className="mission-details">
      <summary>Details & Verlauf</summary>
      <div className="mission-details-body">
        <p className="muted">Erstellt: {formatMissionTime(mission.createdAt)} · Geändert: {formatMissionTime(mission.updatedAt)}</p>
        <p>Aktueller Versuch: {mission.runAttempt || 'Noch nicht gestartet'}</p>
        {history.length === 0 ? <p className="muted">Noch kein Verlauf vorhanden.</p> : (
          <ol className="mission-history">
            {history.map((entry) => (
              <li key={entry.attempt}>
                <strong>Versuch {entry.attempt}</strong>
                <span>{runStatusLabels[entry.status || 'starting'] || 'Unbekannt'}</span>
                {entry.agentId && <span> · {entry.agentId}</span>}
                {entry.startedAt && <time dateTime={entry.startedAt}> · Start {formatMissionTime(entry.startedAt)}</time>}
                {entry.finishedAt && <time dateTime={entry.finishedAt}> · Ende {formatMissionTime(entry.finishedAt)}</time>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  )
}

const runStatusLabels: Record<string, string> = {
  starting: 'Startet',
  running: 'Läuft',
  completed: 'Abgeschlossen',
  failed: 'Fehlgeschlagen',
  cancelled: 'Abgebrochen',
  interrupted: 'Unterbrochen',
}

function formatMissionTime(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })
}

function WizardInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  )
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'my-agent-team'
}

function buildProfileYaml(state: WizardState) {
  const slug = slugify(state.teamName)
  const agentList = state.agentNames
    .split(',')
    .map((agent) => agent.trim())
    .filter(Boolean)

  return `name: ${state.teamName}
slug: ${slug}
description: Configured agent team profile.
theme: ${state.theme}

team:
  owner: ${state.ownerName}
  coordinator: ${state.coordinatorName}
  agents:
${agentList.map((agent) => `    - ${agent}`).join('\n') || '    - Coordinator'}

integrations:
  hermes:
    enabled: ${state.usesHermesPeers}
    peers: []
  notes:
    enabled: ${state.usesObsidian}
    path: ${state.notesPath}

paths:
  projects: ${state.projectPath}
  outputs: ${state.outputPath}

privacy:
  contains_private_values: true
  publish_safe: false
`
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="metric-card">
      <div className="metric-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function SectionTitle({ id, icon, title, subtitle }: { id?: string; icon: React.ReactNode; title: string; subtitle: string }) {
  return (
    <div className="section-title">
      <div className="section-icon">{icon}</div>
      <div>
        <h2 id={id}>{title}</h2>
        <p>{subtitle}</p>
      </div>
    </div>
  )
}

export default App
