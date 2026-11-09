import assert from 'node:assert/strict'
import test from 'node:test'
import { Provider } from 'electron-updater'
import { configureStableGithubReleaseFeed } from '../electron/update-feed.js'

const repositoryUrl = 'https://github.com/MagnusOlstad/folio.git'
const metadataUrl = 'https://api.github.com/repos/MagnusOlstad/folio/releases/assets/726603503'
const zipUrl = 'https://api.github.com/repos/MagnusOlstad/folio/releases/assets/726603504'
const zipName = 'FolioNotes-0.9.0-arm64.zip'
const sha512 = 'a'.repeat(88)

function createResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body }
}

function createRelease(overrides = {}) {
  return {
    draft: false,
    prerelease: false,
    tag_name: 'v0.9.0',
    assets: [
      { id: 726603503, name: 'latest-mac.yml', state: 'uploaded' },
      { id: 726603504, name: zipName, state: 'uploaded' },
      { id: 726603505, name: 'FolioNotes-0.9.0-arm64.dmg', state: 'uploaded' },
    ],
    ...overrides,
  }
}

function createMetadata(overrides = {}) {
  return [
    `version: ${overrides.version ?? '0.9.0'}`,
    'files:',
    `  - url: ${overrides.url ?? zipName}`,
    `    sha512: ${overrides.sha512 ?? sha512}`,
    `    size: ${overrides.size ?? 133000000}`,
    `path: ${overrides.path ?? zipName}`,
    `sha512: ${overrides.sha512 ?? sha512}`,
  ].join('\n')
}

async function createConfiguredProvider({ release = createRelease(), metadata = createMetadata(), fetchImpl } = {}) {
  let options
  const calls = []
  const fetchRelease = fetchImpl ?? (async (url, init) => {
    calls.push({ url, init })
    return createResponse(release)
  })
  await configureStableGithubReleaseFeed({
    repositoryUrl,
    Provider,
    updater: { setFeedURL: (value) => { options = value } },
    fetchImpl: fetchRelease,
  })
  const provider = new options.updateProvider({}, {}, {
    platform: 'darwin',
    isUseMultipleRangeRequest: true,
    executor: {
      request: async (request) => {
        calls.push({ request })
        return metadata
      },
    },
  })
  return { provider, options, calls }
}

test('configures a public custom provider from the GitHub stable-release API', async () => {
  const { provider, options, calls } = await createConfiguredProvider()
  const updateInfo = await provider.getLatestVersion()
  const files = provider.resolveFiles(updateInfo)

  assert.equal(calls[0].url, 'https://api.github.com/repos/MagnusOlstad/folio/releases/latest')
  assert.equal(calls[0].init.headers.Accept, 'application/vnd.github+json')
  assert.equal(calls[0].init.headers['X-GitHub-Api-Version'], '2022-11-28')
  assert.ok(calls[0].init.signal instanceof AbortSignal)
  assert.deepEqual(Object.keys(options), ['provider', 'updateProvider'])
  assert.equal(options.provider, 'custom')
  assert.equal(typeof options.updateProvider, 'function')
  assert.equal(calls[1].request.headers.Accept, 'application/octet-stream')
  assert.equal(calls[1].request.protocol, 'https:')
  assert.equal(calls[1].request.hostname, 'api.github.com')
  assert.equal(calls[1].request.path, '/repos/MagnusOlstad/folio/releases/assets/726603503')
  assert.equal(updateInfo.version, '0.9.0')
  assert.equal(provider.isUseMultipleRangeRequest, false)
  assert.deepEqual(provider.fileExtraDownloadHeaders, { Accept: 'application/octet-stream' })
  assert.equal(files.length, 1)
  assert.equal(files[0].url.href, zipUrl)
  assert.equal(files[0].info.url, zipName)
  assert.equal(files[0].info.sha512, sha512)
})

for (const [description, release] of [
  ['draft releases', createRelease({ draft: true })],
  ['prereleases', createRelease({ prerelease: true, tag_name: 'v1.0.0-beta.1' })],
  ['invalid stable tags', createRelease({ tag_name: 'preview' })],
  ['releases without update metadata', createRelease({ assets: [] })],
  ['metadata assets without a valid ID', createRelease({ assets: [{ id: 0, name: 'latest-mac.yml', state: 'uploaded' }] })],
]) {
  test(`rejects ${description} without changing the configured feed`, async () => {
    let configured = false
    await assert.rejects(configureStableGithubReleaseFeed({
      repositoryUrl,
      Provider,
      updater: { setFeedURL: () => { configured = true } },
      fetchImpl: async () => createResponse(release),
    }))
    assert.equal(configured, false)
  })
}

test('does not configure a provider when release discovery fails', async () => {
  let configured = false
  await assert.rejects(configureStableGithubReleaseFeed({
    repositoryUrl,
    Provider,
    updater: { setFeedURL: () => { configured = true } },
    fetchImpl: async () => createResponse({}, { ok: false, status: 504 }),
  }), /HTTP 504/)
  assert.equal(configured, false)
})

test('aborts release discovery when the configured timeout expires', async () => {
  let configured = false
  const keepAlive = setTimeout(() => {}, 100)
  try {
    await assert.rejects(configureStableGithubReleaseFeed({
      repositoryUrl,
      timeoutMs: 5,
      Provider,
      updater: { setFeedURL: () => { configured = true } },
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true })
      }),
    }), /request aborted/)
  } finally {
    clearTimeout(keepAlive)
  }
  assert.equal(configured, false)
})

test('rejects update metadata whose tag, SHA512, or release asset does not match', async (context) => {
  const cases = [
    { name: 'version mismatch', metadata: createMetadata({ version: '0.8.0' }), expected: /does not match/ },
    { name: 'missing SHA512', metadata: createMetadata({ sha512: '' }), expected: /checksummed arm64 ZIP/ },
    { name: 'missing release ZIP', release: createRelease({ assets: [{ id: 726603503, name: 'latest-mac.yml', state: 'uploaded' }] }), expected: /missing uploaded ZIP asset/ },
    { name: 'non-arm64 artifact', metadata: createMetadata({ url: 'FolioNotes-0.9.0-x64.zip' }), expected: /checksummed arm64 ZIP/ },
  ]
  for (const item of cases) {
    await context.test(item.name, async () => {
      const { provider } = await createConfiguredProvider({ release: item.release, metadata: item.metadata })
      if (item.name === 'missing release ZIP') {
        const updateInfo = await provider.getLatestVersion()
        assert.throws(() => provider.resolveFiles(updateInfo), item.expected)
      } else {
        await assert.rejects(provider.getLatestVersion(), item.expected)
      }
    })
  }
})

test('rejects non-GitHub updater repository configuration', async () => {
  let requested = false
  await assert.rejects(configureStableGithubReleaseFeed({
    repositoryUrl: 'https://example.com/MagnusOlstad/folio',
    Provider,
    updater: { setFeedURL() {} },
    fetchImpl: async () => { requested = true; return createResponse({}) },
  }), /must be a GitHub/)
  assert.equal(requested, false)
})
