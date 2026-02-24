import { contextBridge, ipcRenderer } from "electron";

const IPC_PICK_INPUT_FILE = "desktop:pickInputFile";
const IPC_PICK_OUTPUT_DIR = "desktop:pickOutputDir";
const IPC_RUN_JOB = "desktop:runJob";
const IPC_CANCEL_JOB = "desktop:cancelJob";
const IPC_OPEN_OUTPUT_DIR = "desktop:openOutputDir";
const IPC_JOB_EVENT = "desktop:jobEvent";

contextBridge.exposeInMainWorld("desktopApi", {
  pickInputFile: () => ipcRenderer.invoke(IPC_PICK_INPUT_FILE) as Promise<string | null>,
  pickOutputDir: () => ipcRenderer.invoke(IPC_PICK_OUTPUT_DIR) as Promise<string | null>,
  runJob: (payload: { inputPath: string; outputDir: string }) =>
    ipcRenderer.invoke(IPC_RUN_JOB, payload) as Promise<{ jobId: string }>,
  cancelJob: (jobId: string) => ipcRenderer.invoke(IPC_CANCEL_JOB, jobId) as Promise<boolean>,
  openOutputDir: (outputDir: string) => ipcRenderer.invoke(IPC_OPEN_OUTPUT_DIR, outputDir) as Promise<void>,
  onJobEvent: (handler: (event: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      handler(payload);
    };
    ipcRenderer.on(IPC_JOB_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(IPC_JOB_EVENT, listener);
    };
  }
});
