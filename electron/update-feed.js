import { parse as parseYaml } from 'yaml'

const GITHUB_API_ROOT = 'https://api.github.com/repos'
const STABLE_VERSION_TAG = /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/

function parseGithubRepository(repositoryUrl) {
  let url
  try {
    url = new URL(repositoryUrl)
  } catch {
    throw new Error('The configured updater repository is invalid.')
  }

  const parts = url.pathname.split('/').filter(Boolean)
  if (url.hostname !== 'github.com' || parts.length !== 2) {
    throw new Error('The configured updater repository must be a GitHub owner/repository URL.')
  }

  const repository = parts[1].replace(/\.git$/i, '')
  if (!parts[0] || !repository) throw new Error('The configured updater repository is invalid.')
  return { owner: parts[0], repository }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assetApiUrl(owner, repository, id) {
  return `${GITHUB_API_ROOT}/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/releases/assets/${id}`
}

function createAssetsProvider({ Provider, owner, repository, release }) {
  const assetsByName = new Map(release.assets.map((asset) => [asset.name, asset]))
  const metadataAsset = assetsByName.get('latest-mac.yml')

  return class GithubReleaseAssetsProvider extends Provider {
    constructor(options, updater, runtimeOptions) {
      super({ ...runtimeOptions, isUseMultipleRangeRequest: false })
      this.release = release
      this.metadataAsset = metadataAsset
    }

    get isUseMultipleRangeRequest() {
      return false
    }

    get fileExtraDownloadHeaders() {
      return { Accept: 'application/octet-stream' }
    }

    async getLatestVersion() {
      const rawInfo = await this.httpRequest(
        new URL(assetApiUrl(owner, repository, this.metadataAsset.id)),
        { Accept: 'application/octet-stream' },
      )
      let updateInfo
      try {
        updateInfo = parseYaml(rawInfo)
      } catch (error) {
        throw new Error(`GitHub returned invalid macOS update metadata: ${error.message}`)
      }

      const expectedVersion = this.release.tag_name.replace(/^v/, '')
      if (!isRecord(updateInfo) || updateInfo.version !== expectedVersion) {
        throw new Error('GitHub macOS update metadata does not match the stable release tag.')
      }

      const files = Array.isArray(updateInfo.files) && updateInfo.files.length > 0
        ? updateInfo.files
        : (typeof updateInfo.path === 'string' ? [{ url: updateInfo.path, sha512: updateInfo.sha512, size: updateInfo.size }] : [])
      const arm64Zips = files.filter((file) => isRecord(file)
        && typeof file.url === 'string'
        && file.url.toLowerCase().endsWith('.zip')
        && /arm64/i.test(file.url)
        && typeof file.sha512 === 'string'
        && file.sha512.length > 0)
      if (arm64Zips.length !== 1) {
        throw new Error('GitHub macOS update metadata must contain exactly one checksummed arm64 ZIP.')
      }

      updateInfo.files = arm64Zips
      updateInfo.assets = this.release.assets
      return updateInfo
    }

    resolveFiles(updateInfo) {
      const files = Array.isArray(updateInfo.files) ? updateInfo.files : []
      return files.map((file) => {
        if (!isRecord(file) || typeof file.url !== 'string' || !file.url.toLowerCase().endsWith('.zip')
          || !/arm64/i.test(file.url) || typeof file.sha512 !== 'string' || file.sha512.length === 0) {
          throw new Error('GitHub macOS update metadata contains an invalid arm64 ZIP entry.')
        }
        const filename = file.url.split(/[?#]/, 1)[0].split('/').at(-1)
        const asset = assetsByName.get(filename)
        if (!asset || !Number.isSafeInteger(asset.id) || asset.id <= 0 || asset.state !== 'uploaded') {
          throw new Error(`GitHub stable release is missing uploaded ZIP asset "${filename}".`)
        }
        return {
          url: new URL(assetApiUrl(owner, repository, asset.id)),
          info: file,
        }
      })
    }
  }
}

/** Configure a public GitHub asset API provider pinned to the latest stable release. */
export async function configureStableGithubReleaseFeed({
  updater,
  Provider,
  repositoryUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
}) {
  if (!updater || typeof updater.setFeedURL !== 'function') {
    throw new Error('The desktop updater is unavailable.')
  }
  if (typeof Provider !== 'function') throw new Error('The desktop updater provider is unavailable.')
  if (typeof fetchImpl !== 'function') throw new Error('The GitHub release service is unavailable.')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('The GitHub release timeout is invalid.')

  const { owner, repository } = parseGithubRepository(repositoryUrl)
  const endpoint = `${GITHUB_API_ROOT}/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/releases/latest`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()

  try {
    const response = await fetchImpl(endpoint, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`GitHub release discovery returned HTTP ${response.status}.`)

    const release = await response.json()
    if (!isRecord(release)
      || release.draft !== false
      || release.prerelease !== false
      || typeof release.tag_name !== 'string'
      || !STABLE_VERSION_TAG.test(release.tag_name)
      || !Array.isArray(release.assets)) {
      throw new Error('GitHub did not return a valid stable macOS update release.')
    }

    const metadataAsset = release.assets.find((asset) => isRecord(asset)
      && asset.name === 'latest-mac.yml'
      && Number.isSafeInteger(asset.id)
      && asset.id > 0
      && asset.state === 'uploaded')
    if (!metadataAsset) throw new Error('GitHub stable release is missing uploaded macOS update metadata.')

    const ProviderClass = createAssetsProvider({ Provider, owner, repository, release })
    updater.setFeedURL({
      provider: 'custom',
      updateProvider: ProviderClass,
    })
    return { owner, repository, tag: release.tag_name, metadataAssetId: metadataAsset.id }
  } finally {
    clearTimeout(timeout)
  }
}
