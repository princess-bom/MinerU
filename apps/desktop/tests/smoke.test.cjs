const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");

test("desktop package scripts include required workflow commands", () => {
  const packageJsonPath = path.join(desktopRoot, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

  assert.ok(packageJson.scripts);
  assert.ok(packageJson.scripts.dev);
  assert.ok(packageJson.scripts.typecheck);
  assert.strictEqual(packageJson.scripts.test, "node tests/run-tests.cjs");
  assert.ok(packageJson.scripts["build:mac"]);
  assert.ok(packageJson.scripts["build:win"]);
});

test("main process keeps secure webPreferences defaults", () => {
  const mainPath = path.join(desktopRoot, "src", "main", "index.ts");
  const source = fs.readFileSync(mainPath, "utf8");

  assert.ok(source.includes("nodeIntegration: false"));
  assert.ok(source.includes("contextIsolation: true"));
  assert.ok(source.includes("preload:"));
});
