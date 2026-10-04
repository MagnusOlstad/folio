import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

import { afterPack, expectedConfig, verifyMacUpdateConfig } from '../scripts/macos-update-config.mjs';

async function createAppPath() {
  const appPath = await mkdtemp(path.join(tmpdir(), 'folio-update-config-'));
  await mkdir(path.join(appPath, 'Contents', 'Resources'), { recursive: true });
  return appPath;
}

test('macOS afterPack writes update settings for any target before signing', async () => {
  const appPath = await createAppPath();
  const resourcesPath = path.join(appPath, 'Contents', 'Resources');

  try {
    await afterPack({
      electronPlatformName: 'darwin',
      appOutDir: appPath,
      targets: [{ name: 'dir' }],
      packager: {
        config: { publish: { provider: 'github', owner: 'MagnusOlstad', repo: 'folio' } },
        appInfo: { name: 'okf-notetaker' },
        getResourcesDir: (outputPath) => path.join(outputPath, 'Contents', 'Resources'),
      },
    });

    const updateConfig = parse(await readFile(path.join(resourcesPath, 'app-update.yml'), 'utf8'));
    assert.deepEqual(updateConfig, expectedConfig({
      provider: 'github', owner: 'MagnusOlstad', repo: 'folio',
    }, 'okf-notetaker'));
    await verifyMacUpdateConfig(appPath, { provider: 'github', owner: 'MagnusOlstad', repo: 'folio' }, 'okf-notetaker');
  } finally {
    await rm(appPath, { recursive: true, force: true });
  }
});

test('update artifact validation rejects missing or mismatched provider settings', async () => {
  const appPath = await createAppPath();
  const configPath = path.join(appPath, 'Contents', 'Resources', 'app-update.yml');
  const publish = { provider: 'github', owner: 'MagnusOlstad', repo: 'folio' };

  try {
    await assert.rejects(verifyMacUpdateConfig(appPath, publish, 'okf-notetaker'), /app-update\.yml/);

    await writeFile(configPath, 'provider: generic\nurl: https://example.com\nupdaterCacheDirName: wrong\n');
    await assert.rejects(verifyMacUpdateConfig(appPath, publish, 'okf-notetaker'), /provider to github/);

    await writeFile(configPath, 'provider: github\nowner: MagnusOlstad\nrepo: folio\nupdaterCacheDirName: wrong\n');
    await assert.rejects(verifyMacUpdateConfig(appPath, publish, 'okf-notetaker'), /updaterCacheDirName to okf-notetaker-updater/);
  } finally {
    await rm(appPath, { recursive: true, force: true });
  }
});

test('non-macOS afterPack does not write macOS update configuration', async () => {
  const appPath = await createAppPath();
  try {
    await afterPack({ electronPlatformName: 'linux', appOutDir: appPath, packager: {} });
    await assert.rejects(readFile(path.join(appPath, 'Contents', 'Resources', 'app-update.yml')));
  } finally {
    await rm(appPath, { recursive: true, force: true });
  }
});
