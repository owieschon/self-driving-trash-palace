import { lstat } from 'node:fs/promises'

const privateEnvironmentFiles = ['.env', '.env.local', '.env.live.local']

for (const file of privateEnvironmentFiles) {
  let metadata
  try {
    metadata = await lstat(file)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') continue
    throw error
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${file} must be a regular local file`)
  }
  const permissions = metadata.mode & 0o777
  if ((permissions & 0o077) !== 0) {
    throw new Error(`${file} must not be readable or writable by group or others`)
  }
}
