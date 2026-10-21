import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, mkdir, open, readdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  openVerifiedDataDirectory,
  openVerifiedProfilesDirectory,
} from './verified-profile-directories.mjs'

const fileOpenFlags = constants.O_RDONLY | constants.O_NOFOLLOW
const readableProfileFilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.ya?ml$/
const writableLocalProfileFilePattern = /^(?=.{1,75}$)[a-z0-9]+(?:-[a-z0-9]+)*\.local\.yaml$/

export async function listLocalProfileFiles(dataDir) {
  let dataHandle
  let profilesHandle
  try {
    dataHandle = await openVerifiedDataDirectory(path.resolve(dataDir))
    profilesHandle = await openVerifiedProfilesDirectory(
      path.join(`/proc/self/fd/${dataHandle.fd}`, 'profiles'),
      { missingAllowed: true },
    )
    if (!profilesHandle) return []
    return (await readdir(`/proc/self/fd/${profilesHandle.fd}`))
      .filter((file) => readableProfileFilePattern.test(file))
  } finally {
    await profilesHandle?.close().catch(() => {})
    await dataHandle?.close().catch(() => {})
  }
}

export async function readLocalProfile(dataDir, file) {
  if (!readableProfileFilePattern.test(file)) return undefined
  let dataHandle
  let profilesHandle
  try {
    dataHandle = await openVerifiedDataDirectory(path.resolve(dataDir))
    profilesHandle = await openVerifiedProfilesDirectory(
      path.join(`/proc/self/fd/${dataHandle.fd}`, 'profiles'),
      { missingAllowed: true },
    )
    if (!profilesHandle) return undefined
    return await readRegularFile(`/proc/self/fd/${profilesHandle.fd}`, file)
  } finally {
    await profilesHandle?.close().catch(() => {})
    await dataHandle?.close().catch(() => {})
  }
}

export async function readPrivateDataFile(dataDir, file) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(file)) return undefined
  let dataHandle
  try {
    dataHandle = await openVerifiedDataDirectory(path.resolve(dataDir))
    return await readRegularFile(`/proc/self/fd/${dataHandle.fd}`, file)
  } finally {
    await dataHandle?.close().catch(() => {})
  }
}

export async function writeLocalProfile(dataDir, file, content, { beforePublish } = {}) {
  if (!writableLocalProfileFilePattern.test(file)) throw invalidProfileFileError()
  const resolvedDataDir = path.resolve(dataDir)
  let dataHandle
  let profilesHandle
  let temporary

  try {
    dataHandle = await openVerifiedDataDirectory(resolvedDataDir)
    const dataHandlePath = `/proc/self/fd/${dataHandle.fd}`
    const profilesPath = path.join(dataHandlePath, 'profiles')
    await mkdir(profilesPath, { mode: 0o700 }).catch((error) => {
      if (error?.code !== 'EEXIST') throw error
    })

    profilesHandle = await openVerifiedProfilesDirectory(profilesPath)
    const profilesHandlePath = `/proc/self/fd/${profilesHandle.fd}`
    const target = path.join(profilesHandlePath, file)
    temporary = path.join(profilesHandlePath, `.${file}.${randomUUID()}.tmp`)

    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await beforePublish?.()
    await link(temporary, target)
  } catch (error) {
    if (error?.code === 'EEXIST') throw error
    if (error?.code === 'profile_storage_unsafe') throw error
    throw unsafeProfileStorageError()
  } finally {
    if (temporary) await unlink(temporary).catch(() => {})
    await profilesHandle?.close().catch(() => {})
    await dataHandle?.close().catch(() => {})
  }
}

async function readRegularFile(directoryHandlePath, file) {
  let handle
  try {
    handle = await open(path.join(directoryHandlePath, file), fileOpenFlags)
    const stats = await handle.stat()
    if (!stats.isFile()) throw unsafeProfileStorageError()
    return await handle.readFile('utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    if (error?.code === 'profile_storage_unsafe') throw error
    throw unsafeProfileStorageError()
  } finally {
    await handle?.close().catch(() => {})
  }
}

function invalidProfileFileError() {
  const error = new Error('Invalid local profile filename')
  error.code = 'profile_storage_invalid_file'
  return error
}

function unsafeProfileStorageError() {
  const error = new Error('Unsafe profile storage directory')
  error.code = 'profile_storage_unsafe'
  return error
}
