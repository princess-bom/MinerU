type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

interface JobEvent {
  jobId: string;
  state: JobState;
  progressEvent?: {
    type: string;
    ts: string;
    jobId: string;
    stage: string;
    progress: number;
    message?: string;
    errorCode?: string | null;
    payload?: Record<string, unknown>;
  };
  errorCode?: string | null;
}

interface DesktopApi {
  pickInputFile: () => Promise<string | null>;
  pickOutputDir: () => Promise<string | null>;
  runJob: (payload: { inputPath: string; outputDir: string }) => Promise<{ jobId: string }>;
  cancelJob: (jobId: string) => Promise<boolean>;
  openOutputDir: (outputDir: string) => Promise<void>;
  onJobEvent: (handler: (event: JobEvent) => void) => () => void;
}

interface Window {
  desktopApi: DesktopApi;
}
