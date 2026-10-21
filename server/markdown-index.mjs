import { createHmac, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { open, opendir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'yaml'

const directoryOpenFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const fileOpenFlags = constants.O_RDONLY | constants.O_NOFOLLOW
const defaultMaxEntries = 1000
const documentIdKey = randomBytes(32)

export async function indexMarkdownDirectory(basePath, {
  maxFiles = 100,
  maxEntries = defaultMaxEntries,
  maxBytes = 256 * 1024,
  maxDepth = 4,
  beforeRead,
} = {}) {
  const resolvedBase = path.resolve(basePath)
  let baseHandle
  try {
    const canonicalBase = await realpath(resolvedBase)
    if (canonicalBase !== resolvedBase) throw unsafeIndexError()
    baseHandle = await open(resolvedBase, directoryOpenFlags)
    const [stats, handlePath] = await Promise.all([
      baseHandle.stat(),
      realpath(`/proc/self/fd/${baseHandle.fd}`),
    ])
    if (!stats.isDirectory() || handlePath !== resolvedBase) throw unsafeIndexError()

    const state = {
      documents: [],
      entriesScanned: 0,
      maxFiles,
      maxEntries,
      maxBytes,
      maxDepth,
      beforeRead,
      idDomain: canonicalBase,
    }
    await walkDirectory(baseHandle, '', 0, state)
    return state.documents
  } catch (error) {
    if (error?.code === 'markdown_index_unsafe') throw error
    throw unsafeIndexError()
  } finally {
    await baseHandle?.close().catch(() => {})
  }
}

async function walkDirectory(directoryHandle, relativeDir, depth, state) {
  if (
    depth > state.maxDepth
    || state.documents.length >= state.maxFiles
    || state.entriesScanned >= state.maxEntries
  ) return
  const directoryHandlePath = `/proc/self/fd/${directoryHandle.fd}`
  const entries = await opendir(directoryHandlePath)

  for await (const entry of entries) {
    if (state.documents.length >= state.maxFiles || state.entriesScanned >= state.maxEntries) return
    state.entriesScanned += 1
    if (entry.isSymbolicLink()) continue
    const relativeName = relativeDir ? `${relativeDir}/${entry.name}` : entry.name

    if (entry.isDirectory() && depth < state.maxDepth) {
      let childHandle
      try {
        childHandle = await open(path.join(directoryHandlePath, entry.name), directoryOpenFlags)
        const stats = await childHandle.stat()
        if (stats.isDirectory()) await walkDirectory(childHandle, relativeName, depth + 1, state)
      } catch {
        // Unsichere oder gleichzeitig veränderte Einträge werden übersprungen.
      } finally {
        await childHandle?.close().catch(() => {})
      }
      continue
    }

    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
    const document = await readMarkdownDocument(directoryHandlePath, entry.name, relativeName, state)
    if (document) state.documents.push(document)
  }
}

async function readMarkdownDocument(directoryHandlePath, file, relativeName, state) {
  let handle
  try {
    handle = await open(path.join(directoryHandlePath, file), fileOpenFlags)
    const stats = await handle.stat()
    if (!stats.isFile() || stats.size > state.maxBytes) return undefined
    await state.beforeRead?.(relativeName)
    const raw = await readLimitedUtf8(handle, state.maxBytes)
    if (raw === undefined) return undefined
    const metadata = parseMarkdownMetadata(raw, stats.mtime)
    return {
      id: createHmac('sha256', documentIdKey)
        .update(state.idDomain)
        .update('\0')
        .update(relativeName)
        .digest('hex')
        .slice(0, 16),
      title: metadata.title,
      date: metadata.date,
      tags: metadata.tags,
    }
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function readLimitedUtf8(handle, maxBytes) {
  const buffer = Buffer.alloc(maxBytes + 1)
  let total = 0
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total)
    if (bytesRead === 0) break
    total += bytesRead
  }
  if (total > maxBytes) return undefined
  return buffer.toString('utf8', 0, total)
}

function parseMarkdownMetadata(raw, modifiedAt) {
  let frontmatter = {}
  let body = raw
  if (raw.startsWith('---\n')) {
    const end = raw.indexOf('\n---\n', 4)
    if (end !== -1) {
      try {
        frontmatter = parse(raw.slice(4, end)) || {}
      } catch {
        frontmatter = {}
      }
      body = raw.slice(end + 5)
    }
  }

  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim()
  const title = cleanText(frontmatter.title, 160)
    || cleanText(heading, 160)
    || 'Unbenanntes Dokument'
  const date = normalizeDate(frontmatter.date, modifiedAt)
  const tags = normalizeTags(frontmatter.tags)
  return { title, date, tags }
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return ''
  const text = value.trim().replace(/\p{C}/gu, '')
  return text.slice(0, maxLength)
}

function normalizeDate(value, modifiedAt) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10)
  const text = cleanText(String(value || ''), 40)
  return text || modifiedAt.toISOString().slice(0, 10)
}

function normalizeTags(value) {
  const tags = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  return [...new Set(tags.map((tag) => cleanText(String(tag), 40)).filter(Boolean))].slice(0, 20)
}

function unsafeIndexError() {
  const error = new Error('Unsafe markdown index directory')
  error.code = 'markdown_index_unsafe'
  return error
}
