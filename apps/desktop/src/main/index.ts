import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from "electron";
import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { buildPreflightPolicy, PreflightError } from "./preflight";
import { createEngineBridge, type EngineBridge } from "./engine-bridge";

type RunJobPayload = {
  inputPath: string;
  outputDir: string;
};

const IPC_PICK_INPUT_FILE = "desktop:pickInputFile";
const IPC_PICK_OUTPUT_DIR = "desktop:pickOutputDir";
const IPC_RUN_JOB = "desktop:runJob";
const IPC_CANCEL_JOB = "desktop:cancelJob";
const IPC_OPEN_OUTPUT_DIR = "desktop:openOutputDir";
const IPC_JOB_EVENT = "desktop:jobEvent";

function registerIpcHandlers(engineBridge: EngineBridge): void {
  const mockJobs = new Map<string, NodeJS.Timeout>();

  ipcMain.handle(IPC_PICK_INPUT_FILE, async (event) => {
    if (process.env.DESKTOP_E2E_PICK_INPUT) {
      return process.env.DESKTOP_E2E_PICK_INPUT;
    }

    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: OpenDialogOptions = {
      properties: ["openFile"],
      filters: [{ name: "PDF", extensions: ["pdf"] }]
    };
    const selected = ownerWindow
      ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (selected.canceled) {
      return null;
    }
    return selected.filePaths[0] ?? null;
  });

  ipcMain.handle(IPC_PICK_OUTPUT_DIR, async (event) => {
    if (process.env.DESKTOP_E2E_PICK_OUTPUT_DIR) {
      return process.env.DESKTOP_E2E_PICK_OUTPUT_DIR;
    }

    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: OpenDialogOptions = {
      properties: ["openDirectory", "createDirectory"]
    };
    const selected = ownerWindow
      ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (selected.canceled) {
      return null;
    }
    return selected.filePaths[0] ?? null;
  });

  ipcMain.handle(IPC_RUN_JOB, (event, payload: RunJobPayload) => {
    if (!payload?.inputPath || !payload?.outputDir) {
      throw new Error("inputPath and outputDir are required");
    }

    if (process.env.DESKTOP_E2E_MOCK_ENGINE === "1") {
      const jobId = randomUUID();
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC_JOB_EVENT, { jobId, state: "queued" });
        event.sender.send(IPC_JOB_EVENT, {
          jobId,
          state: "running",
          progressEvent: {
            type: "job.progress",
            ts: new Date().toISOString(),
            jobId,
            stage: "running",
            progress: 32,
            message: "Mock engine started"
          }
        });
      }

      const terminalState = process.env.DESKTOP_E2E_MOCK_TERMINAL_STATE ?? "succeeded";
      const timerRef = setTimeout(() => {
        mockJobs.delete(jobId);
        if (!event.sender.isDestroyed()) {
          event.sender.send(IPC_JOB_EVENT, {
            jobId,
            state: terminalState,
            errorCode: terminalState === "failed" ? "E_ENGINE_FAILED" : null
          });
        }
      }, 120);
      mockJobs.set(jobId, timerRef);
      return { jobId };
    }

    const job = engineBridge.run(
      {
        inputPath: payload.inputPath,
        outputDir: payload.outputDir,
        backend: "pipeline"
      },
      (jobEvent) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(IPC_JOB_EVENT, jobEvent);
        }
      }
    );

    return { jobId: job.jobId };
  });

  ipcMain.handle(IPC_CANCEL_JOB, (_event, jobId: string) => {
    if (!jobId) {
      return false;
    }
    const mockJob = mockJobs.get(jobId);
    if (mockJob) {
      clearTimeout(mockJob);
      mockJobs.delete(jobId);
      const ownerWindow = BrowserWindow.getAllWindows()[0];
      if (ownerWindow && !ownerWindow.webContents.isDestroyed()) {
        ownerWindow.webContents.send(IPC_JOB_EVENT, {
          jobId,
          state: "cancelled",
          errorCode: "E_CANCELLED"
        });
      }
      return true;
    }
    return engineBridge.cancel(jobId);
  });

  ipcMain.handle(IPC_OPEN_OUTPUT_DIR, async (_event, outputDir: string) => {
    if (!outputDir) {
      throw new Error("outputDir is required");
    }
    const capturePath = process.env.DESKTOP_E2E_OPEN_OUTPUT_CAPTURE;
    if (capturePath) {
      await fs.writeFile(capturePath, `${outputDir}\n`, "utf8");
      return;
    }

    const openError = await shell.openPath(outputDir);
    if (openError) {
      throw new Error(openError);
    }
  });
}

function createMainWindow(_engineBridge: EngineBridge): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile(path.join(app.getAppPath(), "src", "renderer", "index.html"));
}

app.whenReady().then(() => {
  void (async () => {
    try {
      await buildPreflightPolicy({
        getPath: (pathName) => app.getPath(pathName),
        env: process.env
      });

      const engineBridge = createEngineBridge({
        cwd: app.getAppPath(),
        env: process.env
      });

      registerIpcHandlers(engineBridge);

      createMainWindow(engineBridge);

      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          createMainWindow(engineBridge);
        }
      });
    } catch (error) {
      if (error instanceof PreflightError) {
        console.error(`[desktop-preflight:${error.code}] ${error.message}`);
      } else {
        console.error("[desktop-preflight] Unexpected startup error", error);
      }
      app.exit(1);
    }
  })();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
