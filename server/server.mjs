import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const port = Number(process.env.MISSION_CONTROL_API_PORT || 8788)
const host = process.env.MISSION_CONTROL_API_HOST || '127.0.0.1'
const activeProfileFile = process.env.MISSION_CONTROL_PROFILE || 'bonys-agents.example.yaml'
const showPrivateValues = process.env.MISSION_CONTROL_SHOW_PRIVATE === 'true'
// Optionaler Datenordner (im Container ein Volume): eigene Profile in <data>/profiles
const dataDir = process.env.MISSION_CONTROL_DATA_DIR ? path.resolve(process.env.MISSION_CONTROL_DATA_DIR) : ''

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
        activeProfile: activeProfileFile,
        privateValuesVisible: showPrivateValues,
      })
    }

    if (request.method === 'GET' && url.pathname === '/api/profiles') {
      return sendJson(response, 200, { profiles: await listProfiles() })
    }

    if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
      const profileName = sanitizeProfileName(url.searchParams.get('profile') || activeProfileFile)
      const bootstrap = await buildBootstrap(profileName)
      return sendJson(response, 200, bootstrap)
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

async function buildBootstrap(profileName) {
  const agentsConfig = await readYaml(path.join(rootDir, 'config', 'agents.yaml'))
  const profile = await readYaml(profilePath(profileName))
  const profileMeta = profileMetaFromFile(profileName, profile)

  return {
    app: {
      name: 'Bonys Agents Mission Control',
      version: readPackageVersion(),
    },
    source: 'backend',
    activeProfile: profileMeta,
    profiles: await listProfiles(),
    agents: buildAgents(agentsConfig, profile),
    privacy: {
      privateValuesVisible: showPrivateValues,
      redaction: showPrivateValues ? 'disabled' : 'private profile values are redacted',
    },
  }
}

function buildAgents(agentsConfig, profile) {
  const owner = profile?.team?.owner || 'Operator'
  const ownerAgent = {
    id: slugify(owner),
    name: owner,
    role: 'Operator / Creator',
    type: 'human',
    status: 'online',
    tags: ['strategy', 'approval', 'creative-direction'],
  }

  const defaultStatusById = {
    coordinator: 'online',
    youtube: 'busy',
    writer: 'standby',
    research: 'standby',
  }

  const configuredAgents = (agentsConfig?.agents || [])
    .filter((agent) => agent?.enabled !== false)
    .map((agent, index) => {
      const id = agent.id || `agent-${index + 1}`
      return {
        id,
        name: agent.name || id,
        role: agent.role || 'Agent',
        type: agent.type || 'placeholder',
        status: defaultStatusById[id] || 'standby',
        endpoint: normalizePublicValue(agent.endpoint),
        tags: Array.isArray(agent.tags) ? agent.tags : [],
      }
    })

  return [ownerAgent, ...configuredAgents]
}

function profileDirs() {
  const dirs = [path.join(rootDir, 'profiles')]
  if (dataDir) {
    dirs.push(path.join(dataDir, 'profiles'))
  }
  return dirs
}

// Profile im Datenordner haben Vorrang vor gleichnamigen mitgelieferten Profilen
function profilePath(file) {
  const found = profileDirs().reverse().map((dir) => path.join(dir, file)).find((candidate) => existsSync(candidate))
  return found || path.join(rootDir, 'profiles', file)
}

async function listProfiles() {
  const files = new Set()
  for (const dir of profileDirs()) {
    if (existsSync(dir)) {
      for (const file of await readdir(dir)) {
        files.add(file)
      }
    }
  }
  const yamlFiles = [...files].filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'))
  const visibleFiles = showPrivateValues ? yamlFiles : yamlFiles.filter((file) => !file.endsWith('.local.yaml'))

  return Promise.all(
    visibleFiles.sort().map(async (file) => {
      const data = await readYaml(profilePath(file))
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

async function readYaml(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`YAML file not found: ${path.relative(rootDir, filePath)}`)
  }

  const raw = await readFile(filePath, 'utf8')
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
