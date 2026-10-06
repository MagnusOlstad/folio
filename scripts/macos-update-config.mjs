import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));

function getPublishConfig(publish) {
  const configs = Array.isArray(publish) ? publish : [publish];
  const config = configs.find((item) => item?.provider != null);
  assert.ok(config, 'build.publish must define an update provider');
  return config;
}

function expectedConfig(publish, packageName = packageJson.name) {
  const config = getPublishConfig(publish);
  return {
    ...config,
    updaterCacheDirName: `${packageName.toLowerCase()}-updater`,
  };
}

export async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appUpdateConfig = expectedConfig(
    context.packager.config.publish,
    context.packager.appInfo.name,
  );
  const resourcesPath = context.packager.getResourcesDir(context.appOutDir);
  await writeFile(path.join(resourcesPath, 'app-update.yml'), stringify(appUpdateConfig));
}

export async function verifyMacUpdateConfig(appPath, publish = packageJson.build.publish, packageName = packageJson.name) {
  const configPath = path.join(appPath, 'Contents', 'Resources', 'app-update.yml');
  const contents = await readFile(configPath, 'utf8');
  const actual = parse(contents);
  const expected = expectedConfig(publish, packageName);

  for (const key of ['provider', 'owner', 'repo', 'updaterCacheDirName']) {
    assert.equal(actual?.[key], expected[key], `${configPath} must set ${key} to ${expected[key]}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, appPath] = process.argv.slice(2);
  if (action !== 'verify' || !appPath) {
    throw new Error('Usage: node scripts/macos-update-config.mjs verify <FolioNotes.app>');
  }
  await verifyMacUpdateConfig(appPath);
}

export { expectedConfig };
