const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const vm = require("vm");
const ts = require("typescript");

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const evidenceDir = path.join(repoRoot, ".sisyphus", "evidence");
const cancelEvidencePath = path.join(evidenceDir, "task-8-cancel.json");
const timeoutEvidencePath = path.join(evidenceDir, "task-8-timeout-error.json");
const treeEngineScriptPath = path.join(__dirname, "fixtures", "engine-bridge-tree-hang.cjs");

function loadEngineBridgeModule() {
  const sourcePath = path.join(desktopRoot, "src", "main", "engine-bridge", "index.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText;

  const module = { exports: {} };
  const context = {
    require,
    module,
    exports: module.exports,
    process,
    __dirname: path.dirname(sourcePath),
    __filename: sourcePath,
    console,
    Buffer,
    setTimeout,
    clearTimeout
  };

  vm.runInNewContext(transpiled, context, { filename: sourcePath });
  return module.exports;
}

function writeEvidence(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForFile(filePath, timeoutMs = 5000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (fs.existsSync(filePath)) {
        resolve();
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for file: ${filePath}`));
        return;
      }

      setTimeout(check, 50);
    };

    check();
  });
}

function readPidSet(outputDir) {
  const pidProbePath = path.join(outputDir, "pid-probe.json");
  return JSON.parse(fs.readFileSync(pidProbePath, "utf8"));
}

function isPidAlive(pid) {
  if (typeof pid !== "number" || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && (error.code === "EPERM" || error.code === "EACCES")) {
      return true;
    }
    return false;
  }
}

async function waitForPidsExit(pids, timeoutMs = 6000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (pids.every((pid) => !isPidAlive(pid))) {
      return;
    }
    await wait(75);
  }
  throw new Error(`Timed out waiting for pid exit: ${pids.join(", ")}`);
}

test("engine bridge cancel kills process tree with no orphan child", async () => {
  const { createEngineBridge } = loadEngineBridgeModule();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-bridge-cancel-tree-"));
  const pidProbePath = path.join(outputDir, "pid-probe.json");

  const bridge = createEngineBridge({
    command: process.execPath,
    commandPrefixArgs: [treeEngineScriptPath]
  });

  const job = bridge.run({
    jobId: "job-cancel-tree",
    inputPath: "/tmp/input.pdf",
    outputDir,
    backend: "pipeline",
    method: "txt"
  });

  await waitForFile(pidProbePath);
  const pids = readPidSet(outputDir);
  assert.ok(isPidAlive(pids.parentPid), "parent process should be alive before cancel");
  assert.ok(isPidAlive(pids.childPid), "child process should be alive before cancel");

  assert.strictEqual(bridge.cancel(job.jobId), true);
  const result = await job.done;

  assert.strictEqual(result.state, "cancelled");
  assert.strictEqual(result.errorCode, "E_CANCELLED");

  await waitForPidsExit([pids.parentPid, pids.childPid], 7000);

  writeEvidence(cancelEvidencePath, {
    jobId: result.jobId,
    state: result.state,
    errorCode: result.errorCode,
    pids,
    noOrphans: true
  });
});

test("engine bridge timeout kills process tree and returns deterministic E_TIMEOUT", async () => {
  const { createEngineBridge } = loadEngineBridgeModule();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-bridge-timeout-tree-"));
  const pidProbePath = path.join(outputDir, "pid-probe.json");

  const bridge = createEngineBridge({
    command: process.execPath,
    commandPrefixArgs: [treeEngineScriptPath],
    env: {
      ENGINE_BRIDGE_TEST_IGNORE_TERM: "1"
    }
  });

  const job = bridge.run({
    jobId: "job-timeout-tree",
    inputPath: "/tmp/input.pdf",
    outputDir,
    backend: "pipeline",
    method: "txt",
    timeoutMs: 300
  });

  await waitForFile(pidProbePath);
  const pids = readPidSet(outputDir);
  assert.ok(isPidAlive(pids.parentPid), "parent process should be alive before timeout");
  assert.ok(isPidAlive(pids.childPid), "child process should be alive before timeout");

  const result = await job.done;
  assert.strictEqual(result.state, "failed");
  assert.strictEqual(result.errorCode, "E_TIMEOUT");

  await waitForPidsExit([pids.parentPid, pids.childPid], 7000);

  writeEvidence(timeoutEvidencePath, {
    jobId: result.jobId,
    state: result.state,
    errorCode: result.errorCode,
    pids,
    noOrphans: true
  });
});
