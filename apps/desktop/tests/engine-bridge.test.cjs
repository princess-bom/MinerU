const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const vm = require("vm");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { spawnSync } = require("child_process");
const ts = require("typescript");

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const evidenceDir = path.join(repoRoot, ".sisyphus", "evidence");
const successEvidencePath = path.join(evidenceDir, "task-4-bridge.json");
const errorEvidencePath = path.join(evidenceDir, "task-4-bridge-error.json");
const uvCommand = process.platform === "win32" ? "uv.exe" : "uv";

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

class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.spawnargs = ["fake-engine"];
    this.killedWith = null;
  }

  kill(signal) {
    this.killedWith = signal;
    return true;
  }
}

test("engine bridge emits deterministic queued->running->succeeded and parses JSONL", async () => {
  const { createEngineBridge } = loadEngineBridgeModule();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-bridge-success-"));
  const events = [];
  const calls = [];

  const fakeProcess = new FakeChildProcess();
  const bridge = createEngineBridge({
    spawnProcess: (command, args) => {
      calls.push({ command, args });
      return fakeProcess;
    }
  });

  const job = bridge.run(
    {
      jobId: "job-success",
      inputPath: "/tmp/input.pdf",
      outputDir,
      backend: "pipeline",
      method: "txt",
      lang: "en"
    },
    (event) => events.push(event)
  );

  fakeProcess.stdout.write('{"type":"job.progress","ts":"2026-02-25T00:00:00.000Z","jobId":"job-success","stage":"running","progress":42,"message":"Parsing"}\n');
  fakeProcess.stdout.write("not-json\n");

  fs.writeFileSync(
    path.join(outputDir, "result.json"),
    JSON.stringify(
      {
        status: "succeeded",
        errorCode: null,
        outputDir,
        artifacts: { markdown: [], contentList: [], middleJson: [], modelJson: [] },
        engineVersion: "2.7.6",
        backend: "pipeline",
        method: "txt",
        timings: {
          startedAt: "2026-02-25T00:00:00.000Z",
          endedAt: "2026-02-25T00:00:02.000Z",
          durationMs: 2000
        }
      },
      null,
      2
    ),
    "utf8"
  );

  fakeProcess.emit("close", 0);
  const result = await job.done;

  assert.strictEqual(calls[0].command, "mineru-desktop-engine");
  assert.ok(calls[0].args.includes("--jsonl"));
  assert.deepStrictEqual(
    events.map((event) => event.state),
    ["queued", "running", "running", "succeeded"]
  );
  assert.strictEqual(result.state, "succeeded");
  assert.strictEqual(result.errorCode, null);
  assert.strictEqual(result.manifest.status, "succeeded");

  writeEvidence(successEvidencePath, {
    jobId: result.jobId,
    states: events.map((event) => event.state),
    progressEventTypes: events
      .map((event) => (event.progressEvent ? event.progressEvent.type : null))
      .filter(Boolean),
    final: {
      state: result.state,
      errorCode: result.errorCode,
      manifestStatus: result.manifest.status
    }
  });
});

test("engine bridge maps invalid input manifest to failed with stable errorCode", async () => {
  const { createEngineBridge } = loadEngineBridgeModule();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-bridge-error-"));
  const events = [];

  const fakeProcess = new FakeChildProcess();
  const bridge = createEngineBridge({
    spawnProcess: () => fakeProcess
  });

  const job = bridge.run(
    {
      jobId: "job-error",
      inputPath: "/tmp/missing.pdf",
      outputDir,
      backend: "pipeline",
      method: "txt"
    },
    (event) => events.push(event)
  );

  fs.writeFileSync(
    path.join(outputDir, "result.json"),
    JSON.stringify(
      {
        status: "failed",
        errorCode: "E_INVALID_INPUT",
        outputDir,
        artifacts: { markdown: [], contentList: [], middleJson: [], modelJson: [] },
        engineVersion: "2.7.6",
        backend: "pipeline",
        method: "txt",
        timings: {
          startedAt: "2026-02-25T00:00:00.000Z",
          endedAt: "2026-02-25T00:00:00.100Z",
          durationMs: 100
        }
      },
      null,
      2
    ),
    "utf8"
  );

  fakeProcess.emit("close", 2);
  const result = await job.done;

  assert.deepStrictEqual(
    events.map((event) => event.state),
    ["queued", "running", "failed"]
  );
  assert.strictEqual(result.state, "failed");
  assert.strictEqual(result.errorCode, "E_INVALID_INPUT");
  assert.strictEqual(result.manifest.errorCode, "E_INVALID_INPUT");

  writeEvidence(errorEvidencePath, {
    jobId: result.jobId,
    states: events.map((event) => event.state),
    final: {
      state: result.state,
      errorCode: result.errorCode,
      exitCode: result.exitCode
    }
  });
});

test("engine bridge cancel(jobId) forces cancelled final state", async () => {
  const { createEngineBridge } = loadEngineBridgeModule();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-bridge-cancel-"));

  const fakeProcess = new FakeChildProcess();
  const bridge = createEngineBridge({
    spawnProcess: () => fakeProcess
  });

  const job = bridge.run({
    jobId: "job-cancel",
    inputPath: "/tmp/input.pdf",
    outputDir,
    backend: "pipeline",
    method: "txt"
  });

  fs.writeFileSync(
    path.join(outputDir, "result.json"),
    JSON.stringify(
      {
        status: "failed",
        errorCode: "E_ENGINE_FAILED",
        outputDir,
        artifacts: { markdown: [], contentList: [], middleJson: [], modelJson: [] },
        engineVersion: "2.7.6",
        backend: "pipeline",
        method: "txt",
        timings: {
          startedAt: "2026-02-25T00:00:00.000Z",
          endedAt: "2026-02-25T00:00:00.100Z",
          durationMs: 100
        }
      },
      null,
      2
    ),
    "utf8"
  );

  assert.strictEqual(bridge.cancel(job.jobId), true);
  fakeProcess.emit("close", 1);

  const result = await job.done;
  assert.strictEqual(fakeProcess.killedWith, "SIGTERM");
  assert.strictEqual(result.state, "cancelled");
  assert.strictEqual(result.errorCode, "E_CANCELLED");
});

test("engine bridge integration smoke runs real mineru-desktop-engine", async (t) => {
  const uvCheck = spawnSync(uvCommand, ["--version"], { encoding: "utf8" });
  if (uvCheck.status !== 0) {
    t.skip("uv command not available");
    return;
  }

  const { createEngineBridge } = loadEngineBridgeModule();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-bridge-integration-"));
  const inputPath = path.join(repoRoot, "tests", "unittest", "pdfs", "test.pdf");
  assert.ok(fs.existsSync(inputPath), "integration fixture PDF must exist");

  const bridge = createEngineBridge({
    cwd: repoRoot,
    command: uvCommand,
    commandPrefixArgs: ["run", "mineru-desktop-engine"]
  });

  const job = bridge.run({
    inputPath,
    outputDir,
    backend: "pipeline",
    method: "txt",
    lang: "en",
    timeoutMs: 300000
  });

  const result = await job.done;
  assert.strictEqual(result.state, "succeeded");
  assert.strictEqual(result.errorCode, null);
  assert.ok(result.manifest);
  assert.strictEqual(result.manifest.status, "succeeded");
});
