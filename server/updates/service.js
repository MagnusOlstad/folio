export function createReleaseService(runtime) {
  const { updateRepo, updateCheckTtl, appVersion } = runtime
  let latestReleaseCache = null

function compareVersions(left, right) {
  const parse = (value) => String(value).replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const [leftParts, rightParts] = [parse(left), parse(right)]
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] > rightParts[index] ? 1 : -1
  }
  return 0
}

async function fetchLatestRelease(force = false) {
  if (!force && latestReleaseCache && Date.now() - latestReleaseCache.checkedAt < updateCheckTtl) {
    return latestReleaseCache
  }
  try {
    const response = await fetch(`https://api.github.com/repos/${updateRepo}/releases/latest`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `folio/${appVersion}`,
        ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) throw new Error(`GitHub responded ${response.status}`)
    const release = await response.json()
    latestReleaseCache = {
      checkedAt: Date.now(),
      version: String(release.tag_name || '').replace(/^v/, ''),
      url: release.html_url || `https://github.com/${updateRepo}/releases/latest`,
      publishedAt: release.published_at || null,
      error: null,
    }
  } catch (error) {
    latestReleaseCache = {
      checkedAt: Date.now(),
      version: null,
      url: `https://github.com/${updateRepo}/releases/latest`,
      publishedAt: null,
      error: error.message,
    }
  }
  return latestReleaseCache
}


  return { compareVersions, fetchLatestRelease }
}


