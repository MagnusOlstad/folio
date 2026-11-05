import os from 'node:os'
import path from 'node:path'

export function helperPath(projectRoot, configuredPath = null) {
  if (configuredPath || process.env.FOLIO_MLX_HELPER) return configuredPath || process.env.FOLIO_MLX_HELPER
  if (process.resourcesPath) return path.join(process.resourcesPath, 'mlx', 'MacOS', 'folio-mlx')
  return path.join(projectRoot, 'experiments', 'mlx-swift', '.cache', 'staged', 'Folio.app', 'Contents', 'MacOS', 'folio-mlx')
}

export function nativeMlxAvailable() {
  const darwinMajorVersion = Number(os.release().split('.')[0])
  return process.platform === 'darwin' && process.arch === 'arm64'
    && Number.isFinite(darwinMajorVersion) && darwinMajorVersion >= 23
}
