#!/usr/bin/env node

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);

const scriptDir = __dirname;
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const fixturePdf = path.join(repoRoot, "tests", "unittest", "pdfs", "test.pdf");
const invalidInputPath = path.join(repoRoot, ".sisyphus", "tmp", "task-10-missing-input.pdf");
const evidenceDir = path.join(repoRoot, ".sisyphus", "evidence");

function parseArgs(argv) {
  const parsed = {
    mode: "unpackaged",
    executable: null,
    label: "unpackaged",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === "--mode" && next) {
      parsed.mode = next;
      index += 1;
      continue;
    }
    if (current === "--executable" && next) {
      parsed.executable = next;
      index += 1;
      continue;
    }
    if (current === "--label" && next) {
      parsed.label = next;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${current}`);
  }

  if (parsed.mode !== "unpackaged" && parsed.mode !== "packaged") {
    throw new Error(`unsupported mode: ${parsed.mode}`);
  }

  if (parsed.mode === "packaged" && !parsed.executable) {
    throw new Error("--executable is required in packaged mode");
  }

  return parsed;
}

function runDesktopBuildIfNeeded(mode) {
  if (mode !== "unpackaged") {
    return;
  }

  const result = spawnSync("npm", ["run", "build"], {
    cwd: desktopRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    const spawnError = result.error?.message ?? "none";
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    throw new Error(
      `desktop build failed before smoke run\nspawn error: ${spawnError}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
}

function ensureEvidenceDir() {
  fs.mkdirSync(evidenceDir, { recursive: true });
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitForFileText(filePath, timeoutMs) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf8");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`timeout waiting for file: ${filePath}`);
}

function parseJsonLines(logText) {
  const records = [];
  const lines = logText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith("{")) {
      continue;
    }
    try {
      records.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return records;
}

function pickTerminalRecord(records) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record && TERMINAL_STATES.has(record.state)) {
      return record;
    }
  }
  return null;
}

function writeEvidence(fileName, payload) {
  const evidencePath = path.join(evidenceDir, fileName);
  fs.writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return evidencePath;
}

async function launchElectronApp(playwright, config, envOverrides) {
  const launchOptions = {
    env: {
      ...process.env,
      ...envOverrides,
    },
  };

  if (config.mode === "unpackaged") {
    launchOptions.args = [desktopRoot];
  } else {
    launchOptions.executablePath = config.executable;
    launchOptions.args = [];
  }

  return playwright._electron.launch(launchOptions);
}

async function runScenario(playwright, config, scenario) {
  const outputDir = makeTempDir(`desktop-smoke-${config.label}-${scenario.name}-`);
  const capturePath = path.join(outputDir, "open-output.capture.txt");
  const env = {
    DESKTOP_E2E_MOCK_ENGINE: "1",
    DESKTOP_E2E_PICK_INPUT: scenario.inputPath,
    DESKTOP_E2E_PICK_OUTPUT_DIR: outputDir,
    DESKTOP_E2E_OPEN_OUTPUT_CAPTURE: capturePath,
    DESKTOP_E2E_MOCK_TERMINAL_STATE: scenario.mockTerminalState,
  };

  const app = await launchElectronApp(playwright, config, env);
  const startedAt = new Date().toISOString();
  let terminalRecord = null;
  let status = "failed";
  let failureReason = null;

  try {
    const page = await app.firstWindow();
    await page.click('[data-testid="input-file"]');
    await page.click('[data-testid="output-dir"]');
    await page.click('[data-testid="run-btn"]');

    if (scenario.name === "cancel") {
      await page.click('[data-testid="cancel-btn"]');
    }

    await page.locator(`[data-testid="status-${scenario.expectedState}"]`).waitFor({ state: "visible", timeout: 6000 });

    if (scenario.name === "success") {
      await page.click('[data-testid="open-output-btn"]');
      const captureText = await waitForFileText(capturePath, 4000);
      assert.ok(captureText.includes(outputDir), "open-output capture must include outputDir");
    }

    const logText = await page.locator('[data-testid="log-panel"]').innerText();
    const records = parseJsonLines(logText);
    terminalRecord = pickTerminalRecord(records);

    assert.ok(terminalRecord, "terminal IPC record is required");
    assert.strictEqual(terminalRecord.state, scenario.expectedState, "terminal state must match");
    if (scenario.expectedErrorCode === null) {
      assert.ok(terminalRecord.errorCode == null, "errorCode must be null for success");
    } else {
      assert.strictEqual(terminalRecord.errorCode, scenario.expectedErrorCode, "errorCode must match");
    }

    status = "passed";
  } catch (error) {
    failureReason = String(error);
  } finally {
    await app.close();
  }

  const evidencePayload = {
    smoke: config.label,
    mode: config.mode,
    scenario: scenario.name,
    startedAt,
    endedAt: new Date().toISOString(),
    inputPath: scenario.inputPath,
    outputDir,
    expectedState: scenario.expectedState,
    expectedErrorCode: scenario.expectedErrorCode,
    status,
    failureReason,
    terminalRecord,
  };

  const evidencePath = writeEvidence(`task-10-smoke-${config.label}-${scenario.name}.json`, evidencePayload);
  if (status !== "passed") {
    throw new Error(`scenario failed (${scenario.name}), evidence: ${evidencePath}`);
  }

  return evidencePath;
}

async function main() {
  const config = parseArgs(process.argv);
  ensureEvidenceDir();

  assert.ok(fs.existsSync(fixturePdf), "fixture PDF must exist");
  runDesktopBuildIfNeeded(config.mode);

  let playwright;
  try {
    playwright = require("playwright");
  } catch {
    throw new Error("playwright is required for smoke automation");
  }

  if (config.mode === "packaged") {
    assert.ok(fs.existsSync(config.executable), `packaged executable missing: ${config.executable}`);
  }

  const scenarios = [
    {
      name: "success",
      inputPath: fixturePdf,
      mockTerminalState: "succeeded",
      expectedState: "succeeded",
      expectedErrorCode: null,
    },
    {
      name: "forced-failure",
      inputPath: invalidInputPath,
      mockTerminalState: "failed",
      expectedState: "failed",
      expectedErrorCode: "E_ENGINE_FAILED",
    },
    {
      name: "cancel",
      inputPath: fixturePdf,
      mockTerminalState: "succeeded",
      expectedState: "cancelled",
      expectedErrorCode: "E_CANCELLED",
    },
  ];

  const evidenceFiles = [];
  for (const scenario of scenarios) {
    const evidencePath = await runScenario(playwright, config, scenario);
    evidenceFiles.push(evidencePath);
  }

  writeEvidence(`task-10-smoke-${config.label}-summary.json`, {
    smoke: config.label,
    mode: config.mode,
    status: "passed",
    scenarios: scenarios.map((scenario) => scenario.name),
    evidenceFiles,
    generatedAt: new Date().toISOString(),
  });
}

main().catch((error) => {
  const fallbackEvidence = {
    smoke: "unknown",
    mode: "unknown",
    status: "failed",
    error: String(error),
    generatedAt: new Date().toISOString(),
  };

  try {
    ensureEvidenceDir();
    writeEvidence("task-10-smoke-unpackaged-crash.json", fallbackEvidence);
  } catch {
    // ignore secondary failure
  }

  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
