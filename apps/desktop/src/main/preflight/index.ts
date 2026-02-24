import fs from "node:fs/promises";
import path from "node:path";

export const DESKTOP_BACKEND_DEFAULT = "pipeline";
export const E_OUTPUT_UNWRITABLE = "E_OUTPUT_UNWRITABLE";
const E_PREFLIGHT_PATH_INVALID = "E_PREFLIGHT_PATH_INVALID";

type ElectronPathName = "userData" | "sessionData" | "logs" | "temp";

export interface PreflightDirectories {
  userDataDir: string;
  sessionDataDir: string;
  logsDir: string;
  tempDir: string;
  outputDir: string;
}

export interface PreflightPolicy {
  backendDefault: typeof DESKTOP_BACKEND_DEFAULT;
  directories: PreflightDirectories;
  env: NodeJS.ProcessEnv;
}

export class PreflightError extends Error {
  public readonly code: string;
  public readonly cause: unknown;

  public constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = "PreflightError";
    this.code = code;
    this.cause = cause;
  }
}

export interface BuildPreflightPolicyOptions {
  getPath: (pathName: ElectronPathName) => string;
  env?: NodeJS.ProcessEnv;
  outputDirName?: string;
  probeWriteAccess?: (dirPath: string, markerName: string) => Promise<void>;
}

const REQUIRED_ENV_DEFAULTS: Readonly<Record<string, string>> = {
  MINERU_BACKEND: DESKTOP_BACKEND_DEFAULT,
  MINERU_METHOD: "auto",
  MINERU_MODEL_SOURCE: "huggingface"
};

async function defaultProbeWriteAccess(dirPath: string, markerName: string): Promise<void> {
  const markerPath = path.join(dirPath, markerName);
  await fs.writeFile(markerPath, "ok", "utf-8");
  await fs.unlink(markerPath);
}

function toAbsoluteDirectory(dirPath: string, dirLabel: string): string {
  const resolvedPath = path.resolve(dirPath);
  if (!path.isAbsolute(resolvedPath)) {
    throw new PreflightError(
      E_PREFLIGHT_PATH_INVALID,
      `Preflight path '${dirLabel}' must resolve to an absolute path.`
    );
  }
  return resolvedPath;
}

async function ensureDirectoryWritable(
  dirPath: string,
  errorCode: string,
  probeWriteAccess: (targetDirPath: string, markerName: string) => Promise<void>
): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
    await probeWriteAccess(dirPath, ".preflight-write-check");
  } catch (error) {
    throw new PreflightError(errorCode, `Directory is not writable: ${dirPath}`, error);
  }
}

export async function buildPreflightPolicy(options: BuildPreflightPolicyOptions): Promise<PreflightPolicy> {
  const env = options.env ?? process.env;
  const outputDirName = options.outputDirName ?? "output";
  const probeWriteAccess = options.probeWriteAccess ?? defaultProbeWriteAccess;

  const userDataDir = toAbsoluteDirectory(options.getPath("userData"), "userData");
  const sessionDataDir = toAbsoluteDirectory(options.getPath("sessionData"), "sessionData");
  const logsDir = toAbsoluteDirectory(options.getPath("logs"), "logs");
  const tempDir = toAbsoluteDirectory(options.getPath("temp"), "temp");
  const outputDir = path.resolve(userDataDir, outputDirName);

  await ensureDirectoryWritable(userDataDir, E_PREFLIGHT_PATH_INVALID, probeWriteAccess);
  await ensureDirectoryWritable(sessionDataDir, E_PREFLIGHT_PATH_INVALID, probeWriteAccess);
  await ensureDirectoryWritable(logsDir, E_PREFLIGHT_PATH_INVALID, probeWriteAccess);
  await ensureDirectoryWritable(tempDir, E_PREFLIGHT_PATH_INVALID, probeWriteAccess);
  await ensureDirectoryWritable(outputDir, E_OUTPUT_UNWRITABLE, probeWriteAccess);

  for (const [key, value] of Object.entries(REQUIRED_ENV_DEFAULTS)) {
    if (!env[key]) {
      env[key] = value;
    }
  }

  env.MINERU_OUTPUT_DIR = outputDir;

  return {
    backendDefault: DESKTOP_BACKEND_DEFAULT,
    directories: {
      userDataDir,
      sessionDataDir,
      logsDir,
      tempDir,
      outputDir
    },
    env: { ...env }
  };
}
