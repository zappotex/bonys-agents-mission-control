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
  Network,
  PlayCircle,
  RadioTower,
  Settings2,
  ShieldCheck,
  Sparkles,
  Users,
  WandSparkles,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { parse } from 'yaml'
import agentsYaml from '../config/agents.yaml?raw'
import bonysProfileYaml from '../profiles/bonys-agents.example.yaml?raw'
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
  tags: string[]
  endpoint?: string
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

type BootstrapData = {
  app?: {
    name: string
    version: string
  }
  source: 'backend' | 'fallback'
  activeProfile: ProfileMeta
  profiles: ProfileMeta[]
  agents: Agent[]
  privacy?: {
    privateValuesVisible: boolean
    redaction: string
  }
}

type Mission = {
  id: string
  title: string
  owner: string
  state: 'running' | 'planned' | 'review' | 'done'
  description: string
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
  agents: buildAgentsFromConfig(publicAgentsConfig, publicBonysProfile),
  privacy: {
    privateValuesVisible: false,
    redaction: 'frontend fallback uses publish-safe example data',
  },
}

const missions: Mission[] = [
  {
    id: 'mission-control',
    title: 'Bonys Agents Mission Control',
    owner: 'Phaseone0815',
    state: 'running',
    description: 'Open-source Dashboard für frei konfigurierbare Agenten-Teams.',
  },
  {
    id: 'profile-system',
    title: 'Konfigurierbares Profil-System',
    owner: 'Phaseone0815',
    state: 'running',
    description: 'Jeder Nutzer kann eigene Agenten, Pfade, Peers und Themes definieren.',
  },
  {
    id: 'bonys-preset',
    title: 'Bonys vorkonfiguriertes Teamprofil',
    owner: 'Bony + Phaseone0815',
    state: 'review',
    description: 'Teamprofil mit Bony, Phaseone0815, Barney, Current und Lily.',
  },
]

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

function App() {
  const [wizard, setWizard] = useState<WizardState>(defaultWizardState)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [bootstrap, setBootstrap] = useState<BootstrapData>(fallbackBootstrap)
  const [apiState, setApiState] = useState<'loading' | 'backend' | 'degraded' | 'fallback'>('loading')
  const [selectedProfile, setSelectedProfile] = useState('')
  const loadedProfileFile = useRef('')
  const hasBackendData = useRef(false)
  const confirmedProfileFile = useRef('')

  useEffect(() => {
    let isMounted = true
    let refreshTimer: number | undefined
    let controller: AbortController | undefined

    const loadBootstrap = async () => {
      controller = new AbortController()
      try {
        const profileQuery = selectedProfile ? `?profile=${encodeURIComponent(selectedProfile)}` : ''
        const response = await fetch(`/api/bootstrap${profileQuery}`, { signal: controller.signal })
        if (!response.ok) {
          throw new Error(`Backend returned ${response.status}`)
        }
        const data = await response.json() as BootstrapData
        if (!isMounted) return
        hasBackendData.current = true
        confirmedProfileFile.current = data.activeProfile.file
        setBootstrap({ ...data, source: 'backend' })
        if (loadedProfileFile.current !== data.activeProfile.file) {
          loadedProfileFile.current = data.activeProfile.file
          const owner = data.agents.find((agent) => agent.type === 'human')?.name
          const coordinator = data.agents.find((agent) => agent.id === 'coordinator')?.name
          const peerNames = data.agents.filter((agent) => agent.type !== 'human').map((agent) => agent.name)
          setWizard((current) => ({
            ...current,
            teamName: data.activeProfile.name,
            ownerName: owner || current.ownerName,
            coordinatorName: coordinator || peerNames[0] || current.coordinatorName,
            agentNames: peerNames.join(', '),
            theme: data.activeProfile.theme && ['bonys-agents-cyberpunk', 'default-dark', 'minimal'].includes(data.activeProfile.theme)
              ? data.activeProfile.theme as WizardState['theme']
              : current.theme,
          }))
        }
        setApiState('backend')
      } catch {
        if (!isMounted) return
        if (!hasBackendData.current) {
          setBootstrap(fallbackBootstrap)
          setApiState('fallback')
        } else {
          setBootstrap((current) => ({
            ...current,
            agents: current.agents.map((agent) => agent.statusSource === 'live'
              ? { ...agent, status: 'offline', statusSource: 'stale' }
              : agent),
          }))
          setApiState('degraded')
          if (selectedProfile && selectedProfile !== confirmedProfileFile.current) {
            setSelectedProfile(confirmedProfileFile.current)
          }
        }
      } finally {
        if (isMounted) refreshTimer = window.setTimeout(loadBootstrap, 15_000)
      }
    }

    loadBootstrap()

    return () => {
      isMounted = false
      controller?.abort()
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
    }
  }, [selectedProfile])

  const agents = bootstrap.agents
  const activeProfile = bootstrap.activeProfile

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

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand-mark">
          <Sparkles size={28} />
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
          <a href="#missions"><FolderKanban size={18} /> Mission Board</a>
          <a href="#setup"><WandSparkles size={18} /> Setup-Wizard</a>
          <a href="#config"><Settings2 size={18} /> Konfiguration</a>
          <a href="#status"><Activity size={18} /> Systemstatus</a>
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
                <option key={profile.file} value={profile.file}>{profile.name}</option>
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
            <Metric icon={<FolderKanban />} label="Missionen" value={missions.length.toString()} />
            <Metric icon={<ShieldCheck />} label="Lizenz" value="GPL" />
            <Metric
              icon={<GitBranch />}
              label="Datenquelle"
              value={apiState === 'backend' ? 'API' : apiState === 'degraded' ? 'API gestört' : 'Fallback'}
            />
          </div>
        </header>

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
                      ? 'Live über den Hermes-Healthcheck geprüft'
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
            <SectionTitle icon={<FolderKanban />} title="Mission Board" subtitle="Erste Arbeitsansicht für laufende Projekte, Reviews und geplante Aufgaben." />
            <div className="mission-list">
              {missions.map((mission) => (
                <article className="mission-row" key={mission.id}>
                  <div>
                    <span className={`mission-state state-${mission.state}`}>{stateLabels[mission.state]}</span>
                    <h3>{mission.title}</h3>
                    <p>{mission.description}</p>
                  </div>
                  <strong>{mission.owner}</strong>
                </article>
              ))}
            </div>
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
          </div>
        </section>

        <section id="setup" className="panel setup-panel">
          <SectionTitle icon={<WandSparkles />} title="Setup-Wizard" subtitle="Erste konfigurierbare Oberfläche für fremde Installationen. Später schreibt sie echte YAML-Dateien." />
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
                  <span>Vorschau — Download speichert lokal im Browser, kein Server-Schreiben.</span>
                </div>
                <div className="profile-actions">
                  <button type="button" className="ghost-button" onMouseDown={copyProfile}>
                    <Copy size={16} /> {copyState === 'copied' ? 'Kopiert' : copyState === 'failed' ? 'Fehler' : 'Kopieren'}
                  </button>
                  <button type="button" className="primary-button" onMouseDown={downloadProfile}>
                    <Download size={16} /> YAML laden
                  </button>
                </div>
              </div>
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

function SectionTitle({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle: string }) {
  return (
    <div className="section-title">
      <div className="section-icon">{icon}</div>
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
    </div>
  )
}

export default App
