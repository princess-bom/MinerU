import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

export type EngineBridgeState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface EngineJsonlEvent {
  type: string;
  ts: string;
  jobId: string;
  stage: string;
  progress: number;
  message?: string;
  errorCode?: string | null;
  payload?: Record<string, unknown>;
}

export interface EngineResultManifest {
  status: "succeeded" | "failed" | "cancelled" | "timeout";
  errorCode: string | null;
  outputDir: string;
  artifacts: Record<string, unknown>;
  engineVersion: string;
  backend: string;
  method: string;
  timings: {
    startedAt: string;
    endedAt: string;
    durationMs: number;
  };
}

export interface EngineBridgeRequest {
  inputPath: string;
  outputDir: string;
  jobId?: string;
  backend?: string;
  method?: string;
  lang?: string;
  start?: number;
  end?: number;
  timeoutMs?: number | null;
}

export interface EngineBridgeEvent {
  jobId: string;
  state: EngineBridgeState;
  progressEvent?: EngineJsonlEvent;
  errorCode?: string | null;
}

export interface EngineBridgeResult {
  jobId: string;
  state: EngineBridgeState;
  exitCode: number | null;
  errorCode: string | null;
  manifest: EngineResultManifest | null;
}

export interface EngineBridgeJob {
  jobId: string;
  done: Promise<EngineBridgeResult>;
}

export type SpawnProcess = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

export interface EngineBridgeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  command?: string;
  commandPrefixArgs?: string[];
  spawnProcess?: SpawnProcess;
}

interface ActiveJob {
  process: ChildProcessWithoutNullStreams;
  outputDir: string;
  requestedCancel: boolean;
  timedOut: boolean;
  settled: boolean;
  runningEmitted: boolean;
  timeoutRef?: NodeJS.Timeout;
  killTreeRef?: Promise<void>;
  stdoutRemainder: string;
  resolve: (result: EngineBridgeResult) => void;
}

const EXIT_CODE_ERROR_MAP: Readonly<Record<number, string>> = {
  1: "E_ENGINE_FAILED",
  2: "E_INVALID_INPUT",
  3: "E_OUTPUT_UNWRITABLE",
  4: "E_CANCELLED",
  5: "E_TIMEOUT"
};

const KILL_TREE_ESCALATION_MS = 750;

function mapExitCodeToErrorCode(exitCode: number | null): string {
  if (typeof exitCode !== "number") {
    return "E_ENGINE_FAILED";
  }
  return EXIT_CODE_ERROR_MAP[exitCode] ?? "E_ENGINE_FAILED";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function sendSignal(processRef: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try {
    processRef.kill(signal);
  } catch {
    return;
  }
}

function killPosixProcessTree(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

async function killWindowsProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true
    });
    killer.once("error", () => {
      resolve();
    });
    killer.once("close", () => {
      resolve();
    });
  });
}

async function killProcessTree(processRef: ChildProcessWithoutNullStreams): Promise<void> {
  const pid = processRef.pid;
  if (typeof pid !== "number" || pid <= 0) {
    sendSignal(processRef, "SIGTERM");
    await sleep(KILL_TREE_ESCALATION_MS);
    if (processRef.exitCode === null) {
      sendSignal(processRef, "SIGKILL");
    }
    return;
  }

  if (process.platform === "win32") {
    await killWindowsProcessTree(pid);
    return;
  }

  const termSent = killPosixProcessTree(pid, "SIGTERM");
  if (!termSent) {
    return;
  }

  await sleep(KILL_TREE_ESCALATION_MS);
  if (processRef.exitCode === null) {
    killPosixProcessTree(pid, "SIGKILL");
  }
}

async function readResultManifest(outputDir: string): Promise<EngineResultManifest | null> {
  try {
    const raw = await fs.readFile(`${outputDir}/result.json`, "utf8");
    return JSON.parse(raw) as EngineResultManifest;
  } catch {
    return null;
  }
}

export class EngineBridge {
  private readonly cwd?: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly command: string;
  private readonly commandPrefixArgs: string[];
  private readonly spawnProcess: SpawnProcess;
  private readonly activeJobs = new Map<string, ActiveJob>();

  public constructor(options: EngineBridgeOptions = {}) {
    this.cwd = options.cwd;
    this.env = options.env;
    this.command = options.command ?? "mineru-desktop-engine";
    this.commandPrefixArgs = options.commandPrefixArgs ?? [];
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  public run(request: EngineBridgeRequest, onEvent?: (event: EngineBridgeEvent) => void): EngineBridgeJob {
    const jobId = request.jobId ?? randomUUID();
    const backend = request.backend ?? "pipeline";
    const method = request.method ?? "auto";

    const args = [...this.commandPrefixArgs, "--input", request.inputPath, "--output", request.outputDir, "--job-id", jobId, "--backend", backend, "--method", method, "--jsonl"];
    if (typeof request.timeoutMs === "number") {
      args.push("--timeout-ms", String(request.timeoutMs));
    }
    if (request.lang) {
      args.push("--lang", request.lang);
    }
    if (typeof request.start === "number") {
      args.push("--start", String(request.start));
    }
    if (typeof request.end === "number") {
      args.push("--end", String(request.end));
    }

    const processRef = this.spawnProcess(this.command, args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });

    const done = new Promise<EngineBridgeResult>((resolve) => {
      this.activeJobs.set(jobId, {
        process: processRef,
        outputDir: request.outputDir,
        requestedCancel: false,
        timedOut: false,
        settled: false,
        runningEmitted: false,
        stdoutRemainder: "",
        resolve
      });
    });

    this.emitState(jobId, "queued", onEvent);
    this.emitRunningOnce(jobId, onEvent);

    if (typeof request.timeoutMs === "number" && request.timeoutMs > 0) {
      const activeJob = this.activeJobs.get(jobId);
      if (activeJob) {
        activeJob.timeoutRef = setTimeout(() => {
          const pendingJob = this.activeJobs.get(jobId);
          if (!pendingJob || pendingJob.settled) {
            return;
          }
          pendingJob.timedOut = true;
          this.requestKillTree(jobId);
        }, request.timeoutMs + KILL_TREE_ESCALATION_MS);
      }
    }

    processRef.stdout.on("data", (chunk: Buffer | string) => {
      this.emitRunningOnce(jobId, onEvent);
      this.consumeStdout(jobId, chunk, onEvent);
    });

    processRef.on("error", (error) => {
      this.finishJob(jobId, null, onEvent, error);
    });

    processRef.on("close", (exitCode) => {
      this.finishJob(jobId, exitCode, onEvent);
    });

    return { jobId, done };
  }

  public cancel(jobId: string): boolean {
    const activeJob = this.activeJobs.get(jobId);
    if (!activeJob || activeJob.settled) {
      return false;
    }
    activeJob.requestedCancel = true;
    this.requestKillTree(jobId);
    return true;
  }

  private requestKillTree(jobId: string): void {
    const activeJob = this.activeJobs.get(jobId);
    if (!activeJob || activeJob.settled || activeJob.killTreeRef) {
      return;
    }

    activeJob.killTreeRef = killProcessTree(activeJob.process)
      .catch(() => {
        return;
      })
      .finally(() => {
        const pendingJob = this.activeJobs.get(jobId);
        if (pendingJob) {
          pendingJob.killTreeRef = undefined;
        }
      });
  }

  private emitState(jobId: string, state: EngineBridgeState, onEvent?: (event: EngineBridgeEvent) => void, event?: EngineJsonlEvent, errorCode?: string | null): void {
    onEvent?.({
      jobId,
      state,
      progressEvent: event,
      errorCode
    });
  }

  private emitRunningOnce(jobId: string, onEvent?: (event: EngineBridgeEvent) => void): void {
    const activeJob = this.activeJobs.get(jobId);
    if (!activeJob || activeJob.runningEmitted) {
      return;
    }
    activeJob.runningEmitted = true;
    this.emitState(jobId, "running", onEvent);
  }

  private consumeStdout(jobId: string, chunk: Buffer | string, onEvent?: (event: EngineBridgeEvent) => void): void {
    const activeJob = this.activeJobs.get(jobId);
    if (!activeJob) {
      return;
    }

    const nextBuffer = `${activeJob.stdoutRemainder}${chunk.toString("utf8")}`;
    const lines = nextBuffer.split(/\r?\n/);
    activeJob.stdoutRemainder = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed) as EngineJsonlEvent;
        this.emitState(jobId, "running", onEvent, parsed);
      } catch {
        continue;
      }
    }
  }

  private async finishJob(jobId: string, exitCode: number | null, onEvent?: (event: EngineBridgeEvent) => void, spawnError?: unknown): Promise<void> {
    const activeJob = this.activeJobs.get(jobId);
    if (!activeJob || activeJob.settled) {
      return;
    }

    activeJob.settled = true;
    if (activeJob.timeoutRef) {
      clearTimeout(activeJob.timeoutRef);
    }

    const requestManifest = await readResultManifest(activeJob.outputDir);

    let state: EngineBridgeState;
    let errorCode: string | null;

    if (exitCode === 0 && requestManifest?.status === "succeeded") {
      state = "succeeded";
      errorCode = null;
    } else if (activeJob.requestedCancel || exitCode === 4 || requestManifest?.status === "cancelled") {
      state = "cancelled";
      errorCode = activeJob.requestedCancel ? "E_CANCELLED" : (requestManifest?.errorCode ?? "E_CANCELLED");
    } else {
      state = "failed";
      if (activeJob.timedOut) {
        errorCode = "E_TIMEOUT";
      } else if (requestManifest?.errorCode) {
        errorCode = requestManifest.errorCode;
      } else if (spawnError) {
        errorCode = "E_ENGINE_FAILED";
      } else {
        errorCode = mapExitCodeToErrorCode(exitCode);
      }
    }

    this.emitState(jobId, state, onEvent, undefined, errorCode);

    this.activeJobs.delete(jobId);
    activeJob.resolve({
      jobId,
      state,
      exitCode,
      errorCode,
      manifest: requestManifest
    });
  }
}

export function createEngineBridge(options: EngineBridgeOptions = {}): EngineBridge {
  return new EngineBridge(options);
}
