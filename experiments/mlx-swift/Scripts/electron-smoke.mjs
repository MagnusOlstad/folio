import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

const experimentDirectory = fileURLToPath(new URL("..", import.meta.url));
const fixturePath = process.env.FOLIO_MLX_FIXTURES ?? join(experimentDirectory, "Fixtures", "folio-prompts.jsonl");
const responseTimeoutMs = 5 * 60 * 1000;

function readFixtures() {
  return readFileSync(fixturePath, "utf8")
    .trim()
    .split("\n")
    .slice(0, 2)
    .map((line) => JSON.parse(line));
}

async function smoke() {
  const helperPath = process.env.FOLIO_MLX_HELPER;
  if (!helperPath) throw new Error("Set FOLIO_MLX_HELPER to the staged folio-mlx executable");

  const cachePath = process.env.FOLIO_MLX_HUB_CACHE ?? join(app.getPath("userData"), "models", "huggingface");
  const environment = { ...process.env, HF_HOME: cachePath, HF_HUB_CACHE: cachePath };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("DYLD_")) delete environment[key];
  }

  const child = spawn(helperPath, ["--model", "mlx-community/Qwen3.5-4B-MLX-4bit", "--max-tokens", "256", "--temperature", "0"], {
    cwd: app.getPath("temp"),
    env: environment,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const spawnError = new Promise((_, reject) => child.once("error", reject));
  const results = [];

  try {
    for (const fixture of readFixtures()) {
      child.stdin.write(`${JSON.stringify(fixture)}\n`);
      let timeout;
      const response = await Promise.race([
        lines.next(),
        spawnError,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${fixture.id}`)), responseTimeoutMs);
        }),
      ]).finally(() => clearTimeout(timeout));
      const next = response;
      if (next.done) throw new Error(`Native helper exited before responding (code ${child.exitCode})`);
      const result = JSON.parse(next.value);
      if (result.id !== fixture.id || result.error) throw new Error(`Invalid helper response for ${fixture.id}: ${JSON.stringify(result)}`);
      const filing = JSON.parse(result.text);
      const concept = filing?.concept;
      if (!concept || !Array.isArray(concept.path) || !Array.isArray(concept.tags)) {
        throw new Error(`Response ${fixture.id} is not a filing JSON object`);
      }
      if (fixture.validation.expectedKind && concept.kind !== fixture.validation.expectedKind) {
        throw new Error(`Response ${fixture.id} kind mismatch: ${concept.kind}`);
      }
      if (fixture.validation.expectedPath && JSON.stringify(concept.path) !== JSON.stringify(fixture.validation.expectedPath)) {
        throw new Error(`Response ${fixture.id} path mismatch: ${JSON.stringify(concept.path)}`);
      }
      results.push(result);
    }
    child.stdin.end();
    const exitCode = await Promise.race([
      new Promise((resolve) => child.once("close", resolve)),
      spawnError,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for native helper exit")), responseTimeoutMs)),
    ]);
    if (exitCode !== 0) throw new Error(`Native helper exited with code ${exitCode}`);
    process.stdout.write(`${JSON.stringify({ electronVersion: process.versions.electron, bundleResourcesPath: process.resourcesPath, results }, null, 2)}\n`);
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

app.whenReady().then(smoke).catch((error) => {
  console.error(error);
  app.exit(1);
}).finally(() => app.quit());
