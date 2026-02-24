const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { spawnSync } = require("child_process");

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const fixturePdf = path.join(repoRoot, "tests", "unittest", "pdfs", "test.pdf");
let playwright = null;
try {
  playwright = require("playwright");
} catch {
  playwright = null;
}

function runDesktopBuild() {
  const result = spawnSync("npm", ["run", "build"], {
    cwd: desktopRoot,
    encoding: "utf8",
    shell: process.platform === "win32"
  });

  if (result.error || result.status !== 0) {
    const details = [
      result.error?.message ? `spawn error: ${result.error.message}` : null,
      result.stdout,
      result.stderr
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(`desktop build failed\n${details}`);
  }
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitForFileText(filePath, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf8");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout waiting for file: ${filePath}`);
}

async function launchMockedDesktop(envOverrides) {
  if (!playwright) {
    throw new Error("playwright is not installed");
  }

  const { _electron: electron } = playwright;
  return electron.launch({
    args: [desktopRoot],
    env: {
      ...process.env,
      DESKTOP_E2E_MOCK_ENGINE: "1",
      DESKTOP_E2E_PICK_INPUT: fixturePdf,
      ...envOverrides
    }
  });
}

test.before(() => {
  assert.ok(fs.existsSync(fixturePdf), "fixture PDF must exist");
  runDesktopBuild();
});

test("renderer flow includes required data-testid hooks", () => {
  const htmlPath = path.join(desktopRoot, "src", "renderer", "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  const requiredTestIds = [
    "input-file",
    "output-dir",
    "run-btn",
    "cancel-btn",
    "open-output-btn",
    "log-panel",
    "status-succeeded",
    "status-failed",
    "status-cancelled"
  ];

  for (const testId of requiredTestIds) {
    assert.ok(html.includes(`data-testid=\"${testId}\"`), `missing data-testid: ${testId}`);
  }
});

test("renderer flow select-run-log-open succeeds in Electron Playwright", async (t) => {
  if (!playwright) {
    t.skip("playwright is not installed");
    return;
  }

  const outputDir = makeTempDir("desktop-renderer-flow-success-");
  const capturePath = path.join(outputDir, "open-output.capture.txt");

  const app = await launchMockedDesktop({
    DESKTOP_E2E_PICK_OUTPUT_DIR: outputDir,
    DESKTOP_E2E_OPEN_OUTPUT_CAPTURE: capturePath,
    DESKTOP_E2E_MOCK_TERMINAL_STATE: "succeeded"
  });

  try {
    const page = await app.firstWindow();
    await page.click('[data-testid="input-file"]');
    await page.click('[data-testid="output-dir"]');
    await page.click('[data-testid="run-btn"]');
    await page.locator('[data-testid="status-succeeded"]').waitFor({ state: "visible" });

    const logText = await page.locator('[data-testid="log-panel"]').innerText();
    assert.ok(logText.includes('"state":"running"'));
    assert.ok(logText.includes('"state":"succeeded"'));

    await page.click('[data-testid="open-output-btn"]');
    const captureText = await waitForFileText(capturePath, 3000);
    assert.ok(captureText.includes(outputDir));
  } finally {
    await app.close();
  }
});

test("renderer flow exposes failed and cancelled terminal badges", async (t) => {
  if (!playwright) {
    t.skip("playwright is not installed");
    return;
  }

  const failedOutputDir = makeTempDir("desktop-renderer-flow-failed-");
  const failedApp = await launchMockedDesktop({
    DESKTOP_E2E_PICK_OUTPUT_DIR: failedOutputDir,
    DESKTOP_E2E_MOCK_TERMINAL_STATE: "failed"
  });

  try {
    const page = await failedApp.firstWindow();
    await page.click('[data-testid="input-file"]');
    await page.click('[data-testid="output-dir"]');
    await page.click('[data-testid="run-btn"]');
    await page.locator('[data-testid="status-failed"]').waitFor({ state: "visible" });
  } finally {
    await failedApp.close();
  }

  const cancelledOutputDir = makeTempDir("desktop-renderer-flow-cancelled-");
  const cancelledApp = await launchMockedDesktop({
    DESKTOP_E2E_PICK_OUTPUT_DIR: cancelledOutputDir,
    DESKTOP_E2E_MOCK_TERMINAL_STATE: "succeeded"
  });

  try {
    const page = await cancelledApp.firstWindow();
    await page.click('[data-testid="input-file"]');
    await page.click('[data-testid="output-dir"]');
    await page.click('[data-testid="run-btn"]');
    await page.click('[data-testid="cancel-btn"]');
    await page.locator('[data-testid="status-cancelled"]').waitFor({ state: "visible" });
  } finally {
    await cancelledApp.close();
  }
});
