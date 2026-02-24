const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) {
    return null;
  }
  return process.argv[index + 1];
}

const outputDir = readArg("--output");
if (!outputDir) {
  process.stderr.write("missing --output\n");
  process.exit(2);
}

fs.mkdirSync(outputDir, { recursive: true });

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
  stdio: ["ignore", "ignore", "ignore"]
});

const pidProbePath = path.join(outputDir, "pid-probe.json");
fs.writeFileSync(
  pidProbePath,
  `${JSON.stringify({ parentPid: process.pid, childPid: child.pid }, null, 2)}\n`,
  "utf8"
);

process.stdout.write(
  `${JSON.stringify({
    type: "job.progress",
    ts: new Date().toISOString(),
    jobId: "tree-hang",
    stage: "running",
    progress: 1,
    message: "started"
  })}\n`
);

if (process.env.ENGINE_BRIDGE_TEST_IGNORE_TERM === "1") {
  process.on("SIGTERM", () => {
    return;
  });
}

setInterval(() => {}, 1000);
