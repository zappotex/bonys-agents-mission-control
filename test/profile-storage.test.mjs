import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeLocalProfile } from '../server/profile-storage.mjs'
import {
  openVerifiedDataDirectory,
  openVerifiedProfilesDirectory,
} from '../server/verified-profile-directories.mjs'

test('writeLocalProfile validiert den Dateinamen direkt in der exportierten Primitive', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-storage-filename-'))

  try {
    for (const file of [
      'unsafe.txt',
      'unsafe.local.yml',
      'public.yaml',
      'example.yaml',
      '../escape.local.yaml',
      'nested/escape.local.yaml',
    ]) {
      await assert.rejects(
        writeLocalProfile(dataDir, file, 'name: Unsafe\n'),
        (error) => error?.code === 'profile_storage_invalid_file',
      )
    }

    await writeLocalProfile(dataDir, 'safe-profile.local.yaml', 'name: Safe\n')
    assert.equal(readFileSync(path.join(dataDir, 'profiles', 'safe-profile.local.yaml'), 'utf8'), 'name: Safe\n')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('verzeichnisgebundene Veröffentlichung bleibt bei gleichzeitigem Pfadtausch im verifizierten Verzeichnis', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'mc-storage-race-'))
  const profilesPath = path.join(dataDir, 'profiles')
  const originalProfilesPath = path.join(dataDir, 'profiles-original')
  const escapePath = mkdtempSync(path.join(tmpdir(), 'mc-storage-escape-'))
  mkdirSync(profilesPath, { mode: 0o700 })

  try {
    await writeLocalProfile(dataDir, 'race-safe.local.yaml', 'name: Race Safe\n', {
      beforePublish: async () => {
        renameSync(profilesPath, originalProfilesPath)
        symlinkSync(escapePath, profilesPath, 'dir')
      },
    })

    assert.equal(readFileSync(path.join(originalProfilesPath, 'race-safe.local.yaml'), 'utf8'), 'name: Race Safe\n')
    assert.equal(existsSync(path.join(escapePath, 'race-safe.local.yaml')), false)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(escapePath, { recursive: true, force: true })
  }
})

test('openVerifiedProfilesDirectory schließt den Handle bei stat-Fehlern', async () => {
  let closeCalls = 0
  const handle = {
    fd: 41,
    stat: async () => { throw new Error('injected stat failure') },
    close: async () => { closeCalls += 1 },
  }

  await assert.rejects(
    openVerifiedProfilesDirectory('/verified/profiles', {
      dependencies: { open: async () => handle, realpath: async (value) => value },
    }),
    (error) => error?.code === 'profile_storage_unsafe',
  )
  assert.equal(closeCalls, 1)
})

test('openVerifiedDataDirectory schließt den Handle bei Prüfungsfehlern nach open', async () => {
  let closeCalls = 0
  const handle = {
    fd: 42,
    stat: async () => ({ isDirectory: () => true }),
    close: async () => { closeCalls += 1 },
  }
  let realpathCalls = 0

  await assert.rejects(
    openVerifiedDataDirectory('/verified/data', {
      open: async () => handle,
      realpath: async (value) => {
        realpathCalls += 1
        if (realpathCalls === 1) return value
        throw new Error('injected handle realpath failure')
      },
    }),
    (error) => error?.code === 'profile_storage_unsafe',
  )
  assert.equal(closeCalls, 1)
})
