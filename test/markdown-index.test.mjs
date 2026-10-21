import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { indexMarkdownDirectory } from '../server/markdown-index.mjs'

test('Markdown-Index liest begrenzte Metadaten rekursiv ohne Pfade oder Symlink-Ziele', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mc-markdown-index-'))
  const outside = mkdtempSync(path.join(tmpdir(), 'mc-markdown-outside-'))
  mkdirSync(path.join(root, 'projects'))
  writeFileSync(path.join(root, 'overview.md'), '---\ntitle: Übersicht\ndate: 2026-10-16\ntags: [mission, review]\n---\n# Ignored heading\nBody')
  writeFileSync(path.join(root, 'projects', 'alpha.md'), '# Alpha Projekt\n\nInhalt')
  writeFileSync(path.join(root, 'ignore.txt'), '# Kein Markdown')
  writeFileSync(path.join(outside, 'secret.md'), '# Secret Outside')
  symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'linked.md'))
  symlinkSync(outside, path.join(root, 'linked-dir'), 'dir')

  try {
    const documents = await indexMarkdownDirectory(root)
    assert.deepEqual(documents.map((document) => document.title).sort(), ['Alpha Projekt', 'Übersicht'].sort())
    const overview = documents.find((document) => document.title === 'Übersicht')
    assert.deepEqual(overview.tags, ['mission', 'review'])
    assert.equal(overview.date, '2026-10-16')
    assert.equal(documents.every((document) => !('path' in document) && !('file' in document)), true)
    assert.equal(documents.every((document) => /^[a-f0-9]{16}$/.test(document.id)), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('Markdown-Index verwendet ohne Frontmatter-Titel oder H1 keinen Dateinamen als Titel', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mc-markdown-title-'))
  writeFileSync(path.join(root, 'vertraulicher-projektname.md'), 'Nur Fließtext ohne Überschrift.\n')

  try {
    const documents = await indexMarkdownDirectory(root)
    assert.equal(documents.length, 1)
    assert.equal(documents[0].title, 'Unbenanntes Dokument')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Markdown-Index hält maxEntries-Grenzen und die Interaktion mit maxFiles deterministisch ein', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mc-markdown-budget-'))
  writeFileSync(path.join(root, 'first.md'), '# First')
  writeFileSync(path.join(root, 'second.md'), '# Second')

  try {
    assert.equal((await indexMarkdownDirectory(root, { maxEntries: 0 })).length, 0)
    assert.equal((await indexMarkdownDirectory(root, { maxEntries: 1 })).length, 1)
    assert.equal((await indexMarkdownDirectory(root, { maxEntries: 2 })).length, 2)
    assert.equal((await indexMarkdownDirectory(root, { maxEntries: 2, maxFiles: 1 })).length, 1)
    assert.equal((await indexMarkdownDirectory(root, { maxEntries: 1, maxFiles: 2 })).length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Markdown-Index begrenzt den tatsächlichen Lesevorgang race-sicher auf maxBytes plus ein Byte', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mc-markdown-read-limit-'))
  const file = path.join(root, 'growing.md')
  writeFileSync(file, '# A')

  try {
    const documents = await indexMarkdownDirectory(root, {
      maxBytes: 8,
      beforeRead: () => appendFileSync(file, '0123456789'),
    })
    assert.deepEqual(documents, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Markdown-IDs bleiben im selben Vault pro Prozess stabil und sind zwischen Vaults domänengetrennt', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mc-markdown-id-'))
  const secondRoot = mkdtempSync(path.join(tmpdir(), 'mc-markdown-id-second-'))
  const relativeName = 'geheimes-projekt.md'
  writeFileSync(path.join(root, relativeName), '# Projekt')
  writeFileSync(path.join(secondRoot, relativeName), '# Projekt')

  try {
    const first = await indexMarkdownDirectory(root)
    const second = await indexMarkdownDirectory(root)
    const otherVault = await indexMarkdownDirectory(secondRoot)
    const predictableId = createHash('sha256').update(relativeName).digest('hex').slice(0, 16)

    assert.equal(first[0].id, second[0].id)
    assert.notEqual(first[0].id, otherVault[0].id)
    assert.notEqual(first[0].id, predictableId)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(secondRoot, { recursive: true, force: true })
  }
})

test('Markdown-Index lehnt einen verlinkten Basisordner ab', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'mc-markdown-link-'))
  const outside = mkdtempSync(path.join(tmpdir(), 'mc-markdown-target-'))
  const linked = path.join(parent, 'vault')
  symlinkSync(outside, linked, 'dir')

  try {
    await assert.rejects(indexMarkdownDirectory(linked), (error) => error?.code === 'markdown_index_unsafe')
  } finally {
    rmSync(parent, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
