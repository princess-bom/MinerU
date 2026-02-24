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
const successEvidencePath = path.join(evidenceDir, "task-5-preflight.json");
const errorEvidencePath = path.join(evidenceDir, "task-5-preflight-error.json");

function loadPreflightModule() {
  const sourcePath = path.join(desktopRoot, "src", "main", "preflight", "index.ts");
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

test("preflight resolves OS paths and injects MINERU defaults", async () => {
  const { buildPreflightPolicy, DESKTOP_BACKEND_DEFAULT } = loadPreflightModule();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mineru-preflight-"));
  const env = {};

  const pathMap = {
    userData: path.join(tempRoot, "userData"),
    sessionData: path.join(tempRoot, "sessionData"),
    logs: path.join(tempRoot, "logs"),
    temp: path.join(tempRoot, "temp")
  };

  const policy = await buildPreflightPolicy({
    getPath: (name) => pathMap[name],
    env
  });

  assert.strictEqual(policy.backendDefault, DESKTOP_BACKEND_DEFAULT);
  assert.strictEqual(policy.backendDefault, "pipeline");
  assert.strictEqual(policy.env.MINERU_BACKEND, "pipeline");
  assert.strictEqual(policy.env.MINERU_METHOD, "auto");
  assert.strictEqual(policy.env.MINERU_MODEL_SOURCE, "huggingface");
  assert.ok(path.isAbsolute(policy.directories.outputDir));

  for (const dirPath of Object.values(policy.directories)) {
    assert.ok(path.isAbsolute(dirPath));
    assert.ok(fs.existsSync(dirPath));
  }

  writeEvidence(successEvidencePath, {
    backendDefault: policy.backendDefault,
    directories: policy.directories,
    env: {
      MINERU_BACKEND: policy.env.MINERU_BACKEND,
      MINERU_METHOD: policy.env.MINERU_METHOD,
      MINERU_MODEL_SOURCE: policy.env.MINERU_MODEL_SOURCE,
      MINERU_OUTPUT_DIR: policy.env.MINERU_OUTPUT_DIR
    }
  });
});

test("preflight returns deterministic E_OUTPUT_UNWRITABLE error", async () => {
  const { buildPreflightPolicy, E_OUTPUT_UNWRITABLE, PreflightError } = loadPreflightModule();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mineru-preflight-error-"));
  const outputDir = path.join(tempRoot, "userData", "output");

  const pathMap = {
    userData: path.join(tempRoot, "userData"),
    sessionData: path.join(tempRoot, "sessionData"),
    logs: path.join(tempRoot, "logs"),
    temp: path.join(tempRoot, "temp")
  };

  await assert.rejects(
    () =>
      buildPreflightPolicy({
        getPath: (name) => pathMap[name],
        probeWriteAccess: async (dirPath) => {
          if (dirPath === outputDir) {
            const error = new Error("write blocked by test");
            error.code = "EACCES";
            throw error;
          }
        }
      }),
    (error) => {
      assert.ok(error instanceof PreflightError);
      assert.strictEqual(error.code, E_OUTPUT_UNWRITABLE);
      assert.strictEqual(error.code, "E_OUTPUT_UNWRITABLE");
      assert.ok(error.message.includes(outputDir));

      writeEvidence(errorEvidencePath, {
        code: error.code,
        message: error.message,
        outputDir
      });

      return true;
    }
  );
});
