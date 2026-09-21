import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  classifyNotaryStatus,
  createManifestForFile,
  INSTALL_BLOCK_END,
  INSTALL_BLOCK_START,
  parseNotaryStatus,
  parseSubmissionId,
  releaseNotesWithInstall,
  validateManifest,
} from '../scripts/macos-notarization.mjs';

test('parses JSON and text notarytool responses', () => {
  assert.equal(parseSubmissionId('{"id":"abc-123","status":"In Progress"}'), 'abc-123');
  assert.equal(parseSubmissionId('id: abc-123\nstatus: In Progress'), 'abc-123');
  assert.equal(parseNotaryStatus('{"id":"abc-123","status":"Accepted"}'), 'Accepted');
  assert.equal(classifyNotaryStatus('In Progress'), 'pending');
  assert.equal(classifyNotaryStatus('Submitted'), 'pending');
  assert.equal(classifyNotaryStatus('Accepted'), 'accepted');
  assert.equal(classifyNotaryStatus('Invalid'), 'invalid');
  assert.equal(classifyNotaryStatus('Rejected'), 'rejected');
  assert.equal(classifyNotaryStatus('service unavailable'), 'transient');
});

test('creates and validates a recovery manifest and archive hash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'folio-notarization-'));
  const archive = join(directory, 'Folio-v1-arm64-notarization-42.zip');
  await writeFile(archive, 'archive bytes');

  const manifest = await createManifestForFile({
    tag: 'v1.2.3',
    commit: '0123456789abcdef',
    archiveName: 'Folio-v1-arm64-notarization-42.zip',
    archivePath: archive,
  });

  assert.equal(manifest.schemaVersion, 1);
  await assert.doesNotReject(() => validateManifest(manifest, {
    archivePath: archive,
    tag: 'v1.2.3',
    commit: '0123456789abcdef',
    submissionId: 'abc-123',
    submissionName: archive.split('/').pop(),
  }));

  await writeFile(archive, 'tampered bytes');
  await assert.rejects(
    () => validateManifest(manifest, {
      archivePath: archive,
      tag: 'v1.2.3',
      commit: '0123456789abcdef',
      submissionName: manifest.archiveName,
    }),
    /sha256 mismatch/,
  );
});

test('replaces only the managed install notes block idempotently', () => {
  const original = '## Changes\n\n- One\n\n## Install\n\nKeep this unrelated section.\n\n## More\n\n- Two';
  const first = releaseNotesWithInstall(original, 'Folio-1.2.3-arm64.dmg');
  const second = releaseNotesWithInstall(first, 'Folio-1.2.3-arm64.dmg');
  assert.equal(second, first);
  assert.equal((second.match(/## Install/g) ?? []).length, 2);
  assert.match(second, /Keep this unrelated section/);
  assert.match(second, /## More\n\n- Two/);
  assert.match(second, /Download `Folio-1\.2\.3-arm64\.dmg`/);
  assert.match(second, new RegExp(`${INSTALL_BLOCK_START}[\\s\\S]*${INSTALL_BLOCK_END}`));
});

test('does not require a package dependency to use the helper', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(packageJson.scripts.test.includes('node --test'));
});
