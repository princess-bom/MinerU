const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const allTestFiles = fs
  .readdirSync(__dirname)
  .filter((name) => name.endsWith(".test.cjs"))
  .map((name) => path.join(__dirname, name));

const selectors = process.argv.slice(2);
const testFiles =
  selectors.length === 0
    ? allTestFiles
    : allTestFiles.filter((filePath) => {
        const baseName = path.basename(filePath);
        return selectors.some((selector) => baseName.includes(selector));
      });

if (testFiles.length === 0) {
  process.stderr.write(`No test files matched selectors: ${selectors.join(", ")}\n`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit"
});

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);
