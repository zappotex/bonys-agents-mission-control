import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'

const directoryOpenFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const defaultDependencies = { open, realpath }

export async function openVerifiedDataDirectory(resolvedDataDir, dependencies = defaultDependencies) {
  let handle
  try {
    const canonicalPath = await dependencies.realpath(resolvedDataDir)
    if (canonicalPath !== resolvedDataDir) throw unsafeProfileStorageError()

    handle = await dependencies.open(resolvedDataDir, directoryOpenFlags)
    const [stats, handlePath] = await Promise.all([
      handle.stat(),
      dependencies.realpath(`/proc/self/fd/${handle.fd}`),
    ])
    if (!stats.isDirectory() || handlePath !== resolvedDataDir) throw unsafeProfileStorageError()
    return handle
  } catch (error) {
    await handle?.close().catch(() => {})
    if (error?.code === 'profile_storage_unsafe') throw error
    throw unsafeProfileStorageError()
  }
}

export async function openVerifiedProfilesDirectory(
  profilesPath,
  { missingAllowed = false, dependencies = defaultDependencies } = {},
) {
  let handle
  try {
    handle = await dependencies.open(profilesPath, directoryOpenFlags)
    const stats = await handle.stat()
    if (!stats.isDirectory()) throw unsafeProfileStorageError()
    return handle
  } catch (error) {
    await handle?.close().catch(() => {})
    if (missingAllowed && error?.code === 'ENOENT') return undefined
    if (error?.code === 'profile_storage_unsafe') throw error
    throw unsafeProfileStorageError()
  }
}

function unsafeProfileStorageError() {
  const error = new Error('Unsafe profile storage directory')
  error.code = 'profile_storage_unsafe'
  return error
}
