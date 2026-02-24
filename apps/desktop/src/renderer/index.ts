const inputFileButton = document.getElementById("input-file-btn") as HTMLButtonElement | null;
const outputDirButton = document.getElementById("output-dir-btn") as HTMLButtonElement | null;
const runButton = document.getElementById("run-btn") as HTMLButtonElement | null;
const cancelButton = document.getElementById("cancel-btn") as HTMLButtonElement | null;
const openOutputButton = document.getElementById("open-output-btn") as HTMLButtonElement | null;
const inputFilePath = document.getElementById("input-file-path") as HTMLParagraphElement | null;
const outputDirPath = document.getElementById("output-dir-path") as HTMLParagraphElement | null;
const logPanel = document.getElementById("log-panel") as HTMLDivElement | null;
const statusSucceeded = document.getElementById("status-succeeded") as HTMLSpanElement | null;
const statusFailed = document.getElementById("status-failed") as HTMLSpanElement | null;
const statusCancelled = document.getElementById("status-cancelled") as HTMLSpanElement | null;

let selectedInputPath = "";
let selectedOutputDir = "";
let runningJobId: string | null = null;
let terminalState: "succeeded" | "failed" | "cancelled" | null = null;

function appendLog(record: unknown): void {
  if (!logPanel) {
    return;
  }
  const line = typeof record === "string" ? record : JSON.stringify(record);
  logPanel.textContent = `${logPanel.textContent}${line}\n`;
  logPanel.scrollTop = logPanel.scrollHeight;
}

function syncControls(): void {
  const hasInputPath = selectedInputPath.length > 0;
  const hasOutputDir = selectedOutputDir.length > 0;
  const isRunning = runningJobId !== null;

  if (inputFilePath) {
    inputFilePath.textContent = hasInputPath ? selectedInputPath : "No input file selected.";
  }
  if (outputDirPath) {
    outputDirPath.textContent = hasOutputDir ? selectedOutputDir : "No output folder selected.";
  }
  if (runButton) {
    runButton.disabled = !hasInputPath || !hasOutputDir || isRunning;
  }
  if (cancelButton) {
    cancelButton.disabled = !isRunning;
  }
  if (openOutputButton) {
    openOutputButton.disabled = !hasOutputDir;
  }
  if (statusSucceeded) {
    statusSucceeded.hidden = terminalState !== "succeeded";
  }
  if (statusFailed) {
    statusFailed.hidden = terminalState !== "failed";
  }
  if (statusCancelled) {
    statusCancelled.hidden = terminalState !== "cancelled";
  }
}

window.desktopApi.onJobEvent((jobEvent) => {
  if (runningJobId && jobEvent.jobId !== runningJobId) {
    return;
  }

  appendLog(jobEvent);

  if (jobEvent.state === "succeeded" || jobEvent.state === "failed" || jobEvent.state === "cancelled") {
    terminalState = jobEvent.state;
    runningJobId = null;
    syncControls();
  }
});

inputFileButton?.addEventListener("click", async () => {
  const selected = await window.desktopApi.pickInputFile();
  if (selected) {
    selectedInputPath = selected;
    appendLog({ type: "ui.pickInputFile", path: selected });
    syncControls();
  }
});

outputDirButton?.addEventListener("click", async () => {
  const selected = await window.desktopApi.pickOutputDir();
  if (selected) {
    selectedOutputDir = selected;
    appendLog({ type: "ui.pickOutputDir", path: selected });
    syncControls();
  }
});

runButton?.addEventListener("click", async () => {
  if (!selectedInputPath || !selectedOutputDir || runningJobId) {
    return;
  }

  terminalState = null;
  appendLog({ type: "ui.run", inputPath: selectedInputPath, outputDir: selectedOutputDir });
  syncControls();

  try {
    const runResult = await window.desktopApi.runJob({
      inputPath: selectedInputPath,
      outputDir: selectedOutputDir
    });
    runningJobId = runResult.jobId;
    appendLog({ type: "ui.jobStarted", jobId: runResult.jobId });
    syncControls();
  } catch (error) {
    terminalState = "failed";
    runningJobId = null;
    appendLog({ type: "ui.error", message: String(error) });
    syncControls();
  }
});

cancelButton?.addEventListener("click", async () => {
  if (!runningJobId) {
    return;
  }
  const currentJobId = runningJobId;
  const cancelled = await window.desktopApi.cancelJob(currentJobId);
  appendLog({ type: "ui.cancel", jobId: currentJobId, accepted: cancelled });
});

openOutputButton?.addEventListener("click", async () => {
  if (!selectedOutputDir) {
    return;
  }
  try {
    await window.desktopApi.openOutputDir(selectedOutputDir);
    appendLog({ type: "ui.openOutputDir", path: selectedOutputDir });
  } catch (error) {
    appendLog({ type: "ui.error", message: String(error) });
  }
});

syncControls();
