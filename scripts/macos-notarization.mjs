import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

export const MANIFEST_SCHEMA_VERSION = 1;
export const INSTALL_BLOCK_START = '<!-- folio-install-start -->';
export const INSTALL_BLOCK_END = '<!-- folio-install-end -->';

const STATUS_ALIASES = new Map([
  ['accepted', 'accepted'],
  ['complete', 'accepted'],
  ['completed', 'accepted'],
  ['in progress', 'pending'],
  ['in_progress', 'pending'],
  ['in-progress', 'pending'],
  ['submitted', 'pending'],
  ['pending', 'pending'],
  ['invalid', 'invalid'],
  ['rejected', 'rejected'],
]);

export function sha256File(path) {
  return readFile(path).then((contents) => createHash('sha256').update(contents).digest('hex'));
}

export function parseNotarytoolJson(output) {
  const text = String(output ?? '').trim();
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) {
      return null;
    }
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
}

export function parseSubmissionId(output) {
  const parsed = parseNotarytoolJson(output);
  if (parsed && typeof parsed.id === 'string' && parsed.id.trim()) {
    return parsed.id.trim();
  }

  const match = String(output ?? '').match(/(?:^|\n)\s*(?:id|submission\s*id)\s*:\s*([^\s]+)/i);
  return match?.[1]?.trim() ?? null;
}

export function parseNotaryStatus(output) {
  const parsed = parseNotarytoolJson(output);
  if (parsed && typeof parsed.status === 'string') {
    return parsed.status.trim();
  }

  const match = String(output ?? '').match(/(?:^|\n)\s*status\s*:\s*([^\n]+)/i);
  return match?.[1]?.trim() ?? null;
}

export function parseNotaryName(output) {
  const parsed = parseNotarytoolJson(output);
  if (parsed && typeof parsed.name === 'string' && parsed.name.trim()) {
    return parsed.name.trim();
  }

  const match = String(output ?? '').match(/(?:^|\n)\s*name\s*:\s*([^\n]+)/i);
  return match?.[1]?.trim() ?? null;
}

export function classifyNotaryStatus(status) {
  if (typeof status !== 'string') {
    return 'transient';
  }

  return STATUS_ALIASES.get(status.trim().toLowerCase()) ?? 'transient';
}

export function createManifest({ tag, commit, archiveName, sha256, submissionName = archiveName }) {
  if (!tag || !commit || !archiveName || !sha256) {
    throw new Error('tag, commit, archiveName, and sha256 are required');
  }

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    tag,
    commit,
    archiveName,
    sha256,
    submissionName,
  };
}

export async function createManifestForFile({ tag, commit, archiveName, archivePath }) {
  return createManifest({
    tag,
    commit,
    archiveName,
    sha256: await sha256File(archivePath),
  });
}

export async function validateManifest(manifest, {
  archivePath,
  tag,
  commit,
  submissionId,
  submissionName,
}) {
  const expected = [
    ['schemaVersion', manifest?.schemaVersion, MANIFEST_SCHEMA_VERSION],
    ['tag', manifest?.tag, tag],
    ['commit', manifest?.commit, commit],
    ['archiveName', manifest?.archiveName, basename(archivePath)],
    ['submissionName', manifest?.submissionName, submissionName ?? manifest?.archiveName],
  ];

  for (const [field, actual, wanted] of expected) {
    if (actual !== wanted) {
      throw new Error(`manifest ${field} mismatch`);
    }
  }

  if (submissionId && typeof submissionId !== 'string') {
    throw new Error('submissionId must be a string');
  }

  const actualHash = await sha256File(archivePath);
  if (manifest.sha256 !== actualHash) {
    throw new Error('manifest sha256 mismatch');
  }

  return true;
}

export function releaseNotesWithInstall(body, dmgName) {
  const normalized = String(body ?? '').trimEnd();
  const managedBlock = new RegExp(`(?:^|\\n)${INSTALL_BLOCK_START}\\n[\\s\\S]*?${INSTALL_BLOCK_END}(?=\\n|$)`, 'g');
  const base = normalized.replace(managedBlock, '').trimEnd();
  return `${base}\n\n${INSTALL_BLOCK_START}\n## Install\n\nDownload \`${dmgName}\`, open it, and drag Folio to Applications. This release is\nsigned with an Apple Developer ID certificate and notarized by Apple, so macOS Gatekeeper can verify it normally.\n${INSTALL_BLOCK_END}\n`;
}

export function resumeSummary({ sourceRunId, submissionId, repository, reason }) {
  return [
    '## macOS notarization recovery',
    '',
    `- Source workflow run: \`${sourceRunId}\``,
    `- Submission ID: \`${submissionId}\``,
    `- State: ${reason}`,
    '',
    'Resume after Apple finishes processing with:',
    '',
    '```sh',
    `gh workflow run release.yml --repo ${repository} --ref main --field source_run_id=${sourceRunId} --field submission_id=${submissionId}`,
    '```',
    '',
  ].join('\n');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main(argv) {
  const [command, ...args] = argv;
  if (command === 'submission-id' || command === 'status' || command === 'name') {
    const output = await new Promise((resolve, reject) => {
      let value = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { value += chunk; });
      process.stdin.on('end', () => resolve(value));
      process.stdin.on('error', reject);
    });
    const value = command === 'submission-id'
      ? parseSubmissionId(output)
      : command === 'status'
        ? classifyNotaryStatus(parseNotaryStatus(output))
        : parseNotaryName(output);
    if (!value) {
      throw new Error('notarytool output did not contain a submission id');
    }
    process.stdout.write(`${value}\n`);
    return;
  }

  if (command === 'manifest-create') {
    const manifest = await createManifestForFile({
      tag: args[args.indexOf('--tag') + 1],
      commit: args[args.indexOf('--commit') + 1],
      archiveName: args[args.indexOf('--archive-name') + 1],
      archivePath: args[args.indexOf('--archive') + 1],
    });
    await writeFile(args[args.indexOf('--output') + 1], `${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }

  if (command === 'manifest-validate') {
    const manifest = await readJson(args[args.indexOf('--manifest') + 1]);
    await validateManifest(manifest, {
      archivePath: args[args.indexOf('--archive') + 1],
      tag: args[args.indexOf('--tag') + 1],
      commit: args[args.indexOf('--commit') + 1],
      submissionId: args[args.indexOf('--submission-id') + 1],
      submissionName: args[args.indexOf('--submission-name') + 1],
    });
    return;
  }

  if (command === 'manifest-fields') {
    const manifest = await readJson(args[args.indexOf('--manifest') + 1]);
    for (const field of ['tag', 'commit', 'archiveName', 'sha256']) {
      process.stdout.write(`${field}=${manifest[field]}\n`);
    }
    return;
  }

  if (command === 'notes') {
    const body = await readFile(args[args.indexOf('--input') + 1], 'utf8');
    const output = releaseNotesWithInstall(body, args[args.indexOf('--dmg') + 1]);
    await writeFile(args[args.indexOf('--output') + 1], output);
    return;
  }

  if (command === 'summary') {
    process.stdout.write(resumeSummary({
      sourceRunId: args[args.indexOf('--source-run-id') + 1],
      submissionId: args[args.indexOf('--submission-id') + 1],
      repository: args[args.indexOf('--repository') + 1],
      reason: args[args.indexOf('--reason') + 1],
    }));
    return;
  }

  throw new Error(`unknown command: ${command ?? ''}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
