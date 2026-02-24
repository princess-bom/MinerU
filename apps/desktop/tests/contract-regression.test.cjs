const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const fixtureDir = path.join(repoRoot, "tests", "fixtures", "desktop");
const uvCommand = process.platform === "win32" ? "uv.exe" : "uv";
const REQUIRED_MANIFEST_KEYS = [
  "status",
  "errorCode",
  "outputDir",
  "artifacts",
  "engineVersion",
  "backend",
  "method",
  "timings",
];
const REQUIRED_ARTIFACT_KEYS = ["markdown", "contentList", "middleJson", "modelJson"];
const REQUIRED_TIMING_KEYS = ["startedAt", "endedAt", "durationMs"];

function readJson(fileName) {
  const fullPath = path.join(fixtureDir, fileName);
  const raw = fs.readFileSync(fullPath, "utf-8");
  return JSON.parse(raw);
}

function runDesktopEngine({ inputPath, outputDir, backend, method, lang }) {
  return spawnSync(
    uvCommand,
    [
      "run",
      "mineru-desktop-engine",
      "--input",
      inputPath,
      "--output",
      outputDir,
      "--backend",
      backend,
      "--method",
      method,
      "--lang",
      lang,
      "--jsonl",
    ],
    {
      cwd: repoRoot,
      encoding: "utf-8",
    },
  );
}

function assertManifestSchema(manifest) {
  for (const key of REQUIRED_MANIFEST_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(manifest, key), `manifest missing key: ${key}`);
  }

  assert.strictEqual(typeof manifest.outputDir, "string");
  assert.strictEqual(typeof manifest.engineVersion, "string");
  assert.strictEqual(typeof manifest.backend, "string");
  assert.strictEqual(typeof manifest.method, "string");

  assert.strictEqual(typeof manifest.artifacts, "object");
  for (const key of REQUIRED_ARTIFACT_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(manifest.artifacts, key), `artifacts missing key: ${key}`);
    assert.ok(Array.isArray(manifest.artifacts[key]), `artifacts.${key} must be an array`);
  }

  assert.strictEqual(typeof manifest.timings, "object");
  for (const key of REQUIRED_TIMING_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(manifest.timings, key), `timings missing key: ${key}`);
  }
  assert.ok(Number.isInteger(manifest.timings.durationMs));
  assert.ok(manifest.timings.durationMs >= 0);
}

function loadManifestFrom(outputDir) {
  const resultPath = path.join(outputDir, "result.json");
  assert.ok(fs.existsSync(resultPath), `result manifest missing at ${resultPath}`);
  return JSON.parse(fs.readFileSync(resultPath, "utf-8"));
}

function deterministicSnapshot(manifest) {
  return {
    status: manifest.status,
    errorCode: manifest.errorCode,
    backend: manifest.backend,
    method: manifest.method,
    requiredKeys: Object.keys(manifest).sort(),
    artifactKeys: Object.keys(manifest.artifacts).sort(),
  };
}

function mkTempOutputDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function getSkipReason() {
  if (process.env.CI) {
    return "contract regression tests are skipped in CI (heavy and download-dependent)";
  }

  const uvCheck = spawnSync(uvCommand, ["--version"], { encoding: "utf-8" });
  if (uvCheck.status !== 0) {
    return "uv command not available";
  }

  return null;
}

test("desktop wrapper success path is contract-compliant and deterministic", (t) => {
  const skipReason = getSkipReason();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const successFixture = readJson("contract_input.json");
  const inputPath = path.join(repoRoot, successFixture.inputRelPath);
  assert.ok(fs.existsSync(inputPath), "fixture PDF must exist");

  const firstOutputDir = mkTempOutputDir("desktop-contract-success-1");
  const firstRun = runDesktopEngine({
    inputPath,
    outputDir: firstOutputDir,
    backend: successFixture.backend,
    method: successFixture.method,
    lang: successFixture.lang,
  });
  assert.strictEqual(firstRun.status, 0, firstRun.stderr);

  const firstManifest = loadManifestFrom(firstOutputDir);
  assertManifestSchema(firstManifest);
  assert.strictEqual(firstManifest.status, "succeeded");
  assert.strictEqual(firstManifest.errorCode, null);
  assert.strictEqual(firstManifest.backend, "pipeline");
  assert.strictEqual(firstManifest.method, successFixture.method);

  const secondOutputDir = mkTempOutputDir("desktop-contract-success-2");
  const secondRun = runDesktopEngine({
    inputPath,
    outputDir: secondOutputDir,
    backend: successFixture.backend,
    method: successFixture.method,
    lang: successFixture.lang,
  });
  assert.strictEqual(secondRun.status, 0, secondRun.stderr);

  const secondManifest = loadManifestFrom(secondOutputDir);
  assertManifestSchema(secondManifest);
  assert.strictEqual(secondManifest.status, "succeeded");
  assert.strictEqual(secondManifest.errorCode, null);

  assert.deepStrictEqual(deterministicSnapshot(firstManifest), deterministicSnapshot(secondManifest));
});

test("desktop wrapper failure path has stable failed status and errorCode", (t) => {
  const skipReason = getSkipReason();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const failureFixture = readJson("contract_missing_input.json");
  const inputPath = path.join(repoRoot, failureFixture.inputRelPath);
  assert.strictEqual(fs.existsSync(inputPath), false, "fixture input must be missing");

  const outputDir = mkTempOutputDir("desktop-contract-failure");
  const failedRun = runDesktopEngine({
    inputPath,
    outputDir,
    backend: failureFixture.backend,
    method: failureFixture.method,
    lang: failureFixture.lang,
  });

  assert.strictEqual(failedRun.status, 2, failedRun.stderr);
  const manifest = loadManifestFrom(outputDir);

  assertManifestSchema(manifest);
  assert.strictEqual(manifest.status, "failed");
  assert.strictEqual(manifest.errorCode, "E_INVALID_INPUT");
  assert.strictEqual(manifest.backend, "pipeline");
  assert.strictEqual(manifest.method, failureFixture.method);
});
