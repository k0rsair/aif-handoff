import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { RuntimeRunInput, RuntimeRunResult, RuntimeEvent, RuntimeUsage } from "../../types.js";
import {
  makeProcessRunTimeoutError,
  makeProcessStartTimeoutError,
  resolveRetryDelay,
  sleepMs,
  withProcessTimeouts,
} from "../../timeouts.js";
import { assertSafeWindowsShellExecutablePath } from "../../shellSafety.js";
import { buildToolUseEvents } from "../../toolEvents.js";
import { PROXY_ENV_VARS } from "../../proxyEnv.js";
import { OPENCODE_MODEL_EFFORT_LEVELS, resolveModelEffortOption } from "../../modelEffort.js";
import { classifyOpenCodeRuntimeError, OpenCodeRuntimeAdapterError } from "./errors.js";
import { findOpenCodePath, resolveCliPath } from "./cliPath.js";

const IS_WINDOWS = process.platform === "win32";

export interface OpenCodeCliLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
  error?(context: Record<string, unknown>, message: string): void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/* ------------------------------------------------------------------ */
/*  Environment curation                                              */
/* ------------------------------------------------------------------ */

const ALLOWED_ENV_PREFIXES = [
  "OPENCODE_",
  "AIF_",
  "HANDOFF_",
  "NODE_",
  "npm_",
  "HOME",
  "XDG_",
  "USER",
  "LANG",
  "LC_",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TZ",
  "LOCALAPPDATA",
  "APPDATA",
  "USERPROFILE",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  ...PROXY_ENV_VARS,
];

export function buildCuratedEnv(
  executionEnv?: Record<string, string>,
  sourceEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value == null) continue;
    const upperKey = key.toUpperCase();
    if (
      ALLOWED_ENV_PREFIXES.some((prefix) => {
        const upperPrefix = prefix.toUpperCase();
        return upperKey === upperPrefix || upperKey.startsWith(upperPrefix);
      })
    ) {
      env[key] = value;
    }
  }
  Object.assign(env, executionEnv ?? {});
  return env;
}

/* ------------------------------------------------------------------ */
/*  Process lifecycle helpers                                         */
/* ------------------------------------------------------------------ */

export function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform): void {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return;
  if (platform === "win32") {
    let succeeded = false;
    try {
      const res = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      succeeded = !res?.error && res?.status === 0;
    } catch {
      succeeded = false;
    }
    if (!succeeded) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  }
}

function spawnCliPosix(
  cliPath: string,
  args: string[],
  cwd: string | undefined,
  env: Record<string, string>,
): ChildProcess {
  const lower = cliPath.toLowerCase();
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    throw new OpenCodeRuntimeAdapterError(
      `Executing OpenCode via batch script (${cliPath}) is prohibited.`,
      "OPENCODE_SECURITY_VIOLATION",
      "permission",
    );
  }
  return spawn(cliPath, args, {
    cwd,
    shell: false,
    windowsHide: true,
    env,
    detached: true,
  });
}

/* v8 ignore start -- Windows-only spawn logic, untestable in macOS/Linux CI */
function quoteIfNeeded(arg: string): string {
  return arg.includes(" ") || arg.includes('"') ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function spawnCliWindows(
  cliPath: string,
  args: string[],
  cwd: string | undefined,
  env: Record<string, string>,
): ChildProcess {
  assertSafeWindowsShellExecutablePath(cliPath, "OpenCode CLI path");
  const cmd = process.env.ComSpec ?? "cmd.exe";
  const cmdLine = [cliPath, ...args.map(quoteIfNeeded)].join(" ");
  return spawn(cmd, ["/d", "/c", cmdLine], {
    cwd,
    env,
    stdio: "pipe",
    windowsVerbatimArguments: true,
  });
}
/* v8 ignore stop */

function resolveTimeoutMs(input: RuntimeRunInput): number {
  return input.execution?.runTimeoutMs ?? 1_800_000; // 30m default for agentic CLI runs
}

/* ------------------------------------------------------------------ */
/*  CLI arguments                                                     */
/* ------------------------------------------------------------------ */

function resolveModelFlag(input: RuntimeRunInput): string | null {
  const model = readString(input.model);
  if (!model) return null;

  let selection = model;
  if (!model.includes("/")) {
    const options = asRecord(input.options);
    const providerID =
      readString(options.providerID) ??
      readString(options.defaultProviderID) ??
      readString(process.env.OPENCODE_PROVIDER_ID);
    if (providerID) selection = `${providerID}/${model}`;
  }

  // OpenCode 2 model syntax accepts `provider/model#variant`. The variant
  // name maps to a model reasoning-effort variant, giving CLI parity with
  // the API transport's `reasoningEffort` body field.
  const options = asRecord(input.options);
  const variant =
    readString(options.modelVariant) ??
    resolveModelEffortOption(options, "reasoningEffort", OPENCODE_MODEL_EFFORT_LEVELS);
  if (variant && !selection.includes("#")) {
    selection = `${selection}#${variant}`;
  }

  return selection;
}

export function buildCliArgs(input: RuntimeRunInput): string[] {
  const args: string[] = ["run", "--format", "json"];

  const model = resolveModelFlag(input);
  if (model) {
    args.push("--model", model);
  }

  const sessionId = readString(input.sessionId);
  if (sessionId && /^[\w:-]+$/.test(sessionId)) {
    args.push("--session", sessionId);
  }

  if (input.execution?.bypassPermissions === true) {
    // Auto-approve permissions that are not explicitly denied — the CLI
    // parity for execution.bypassPermissions. Explicit "deny" rules in
    // opencode.json are still enforced by the CLI itself.
    args.push("--auto");
  }

  return args;
}

function composeFullPrompt(input: RuntimeRunInput): string {
  const options = asRecord(input.options);
  const execution = input.execution;
  const systemAppend = execution?.systemPromptAppend ?? readString(options.systemPromptAppend);
  const parts: string[] = [];
  if (input.systemPrompt?.trim()) {
    parts.push(`[SYSTEM PROMPT]:\n${input.systemPrompt.trim()}`);
  }
  if (input.prompt) {
    parts.push(input.prompt);
  }
  if (systemAppend?.trim()) {
    parts.push(`[SYSTEM INSTRUCTIONS]:\n${systemAppend.trim()}`);
  }
  return parts.join("\n\n");
}

/* ------------------------------------------------------------------ */
/*  Stream processor — `opencode run --format json` (JSONL events)    */
/* ------------------------------------------------------------------ */

interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  sawStepFinish: boolean;
}

interface CliStreamState {
  sessionId: string | null;
  events: RuntimeEvent[];
  stepTexts: string[];
  finalText: string;
  plainTextFallback: string;
  usage: UsageAccumulator;
  errorEvent: { message: string; status?: number; retryAfterMs?: number } | null;
  initEmitted: boolean;
}

function createStreamState(fallbackSessionId: string | null): CliStreamState {
  return {
    sessionId: fallbackSessionId,
    events: [],
    stepTexts: [],
    finalText: "",
    plainTextFallback: "",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, sawStepFinish: false },
    errorEvent: null,
    initEmitted: false,
  };
}

function emitEvent(
  state: CliStreamState,
  execution: RuntimeRunInput["execution"],
  event: RuntimeEvent,
): void {
  state.events.push(event);
  execution?.onEvent?.(event);
}

function summarizeToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") {
    return input.length > 80 ? `${input.slice(0, 77)}...` : input;
  }
  try {
    const json = JSON.stringify(input);
    if (json.length <= 100) return json;
    return `${json.slice(0, 97)}...`;
  } catch {
    return "";
  }
}

export function processOpenCodeJsonLine(
  line: string,
  state: CliStreamState,
  input: RuntimeRunInput,
  logger?: OpenCodeCliLogger,
): void {
  const execution = input.execution;
  const trimmed = line.trim();
  if (!trimmed) return;

  let message: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") {
      state.plainTextFallback += (state.plainTextFallback ? "\n" : "") + trimmed;
      return;
    }
    message = parsed as Record<string, unknown>;
  } catch {
    state.plainTextFallback += (state.plainTextFallback ? "\n" : "") + trimmed;
    return;
  }

  const nowIso = new Date().toISOString();
  const sessionID = readString(message.sessionID);
  if (sessionID && !state.sessionId) {
    state.sessionId = sessionID;
  }

  const type = readString(message.type);
  const part = asRecord(message.part);

  switch (type) {
    case "step_start": {
      if (!state.initEmitted) {
        state.initEmitted = true;
        emitEvent(state, execution, {
          type: "system:init",
          timestamp: nowIso,
          level: "debug",
          message: "OpenCode session initialized",
          data: { sessionId: state.sessionId },
        });
      }
      return;
    }

    case "text": {
      const text = readString(part.text);
      if (text) {
        state.stepTexts.push(text);
        state.finalText = text;
        emitEvent(state, execution, {
          type: "stream:text",
          timestamp: nowIso,
          level: "debug",
          message: text,
          data: { text },
        });
      }
      return;
    }

    case "tool_use": {
      const toolName = String(part.tool ?? part.type ?? "unknown_tool");
      const toolUseId = readString(part.id) ?? readString(part.partID);
      const toolState = asRecord(part.state);
      const status = readString(toolState.status);
      const toolInput = toolState.input;
      const summary = summarizeToolInput(toolInput);
      const detailSuffix = summary ? ` ${summary}` : "";

      for (const ev of buildToolUseEvents({
        toolName,
        toolUseId,
        input: toolInput,
        timestamp: nowIso,
        detailSuffix,
      })) {
        emitEvent(state, execution, ev);
      }
      execution?.onToolUse?.(toolName, detailSuffix);

      if (status === "completed" || status === "error") {
        const output = status === "error" ? toolState.error : toolState.output;
        emitEvent(state, execution, {
          type: "tool:result",
          timestamp: nowIso,
          level: status === "error" ? "warn" : "info",
          message: summarizeToolInput(output),
          data: { name: toolName, id: toolUseId, output, error: status === "error" },
        });
      }
      return;
    }

    case "step_finish": {
      const tokens = asRecord(part.tokens);
      const cache = asRecord(tokens.cache);
      const inputTokens =
        (Number(tokens.input) || 0) + (Number(cache.read) || 0) + (Number(cache.write) || 0);
      const outputTokens = (Number(tokens.output) || 0) + (Number(tokens.reasoning) || 0);
      state.usage.inputTokens += inputTokens;
      state.usage.outputTokens += outputTokens;
      state.usage.totalTokens += inputTokens + outputTokens;
      const cost = Number(part.cost);
      if (Number.isFinite(cost)) {
        state.usage.costUsd += cost;
      }
      state.usage.sawStepFinish = true;
      return;
    }

    case "error": {
      const err = asRecord(message.error);
      const status = Number(err.status);
      const retryAfterMs = Number(err.retryAfterMs);
      state.errorEvent = {
        message: readString(err.message) ?? readString(err.type) ?? "OpenCode CLI error event",
        status: Number.isFinite(status) ? status : undefined,
        retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
      };
      return;
    }

    default: {
      logger?.debug?.(
        { runtimeId: input.runtimeId, unknownEventType: type },
        "Ignoring unknown OpenCode CLI event type",
      );
      return;
    }
  }
}

function finalizeUsage(usage: UsageAccumulator): RuntimeUsage | null {
  // PARTIAL contract: token usage is reported when `step_finish` events carry
  // it (local providers frequently omit token counts entirely).
  if (!usage.sawStepFinish) return null;
  const result: RuntimeUsage = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
  if (usage.costUsd > 0) {
    result.costUsd = usage.costUsd;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/*  Process runner                                                    */
/* ------------------------------------------------------------------ */

interface CliAttemptResult {
  result: RuntimeRunResult | null;
  startTimedOut: boolean;
}

function spawnSubprocess(
  cliPath: string,
  args: string[],
  cwd: string | undefined,
  env: Record<string, string>,
): ChildProcess {
  if (IS_WINDOWS) {
    return spawnCliWindows(cliPath, args, cwd, env);
  }
  return spawnCliPosix(cliPath, args, cwd, env);
}

async function runCliAttempt(
  input: RuntimeRunInput,
  cliPath: string,
  env: Record<string, string>,
  logger?: OpenCodeCliLogger,
): Promise<CliAttemptResult> {
  const execution = input.execution;
  const fullPrompt = composeFullPrompt(input);
  const args = buildCliArgs(input);

  const child = spawnSubprocess(cliPath, args, input.cwd ?? input.projectRoot, env);

  let killed = false;
  const rawKill = child.kill.bind(child);
  child.kill = ((signal?: NodeJS.Signals | number) => {
    if (!killed) {
      killed = true;
      if (child.pid && child.pid > 0) killProcessTree(child.pid);
    }
    if (IS_WINDOWS) {
      try {
        rawKill(signal as NodeJS.Signals | number);
      } catch {
        // ignore fallback error if already terminated
      }
      return true;
    }
    try {
      return rawKill(signal as NodeJS.Signals | number);
    } catch {
      return false;
    }
  }) as ChildProcess["kill"];

  const timeouts = withProcessTimeouts(child, {
    startTimeoutMs: execution?.startTimeoutMs,
    runTimeoutMs: execution?.runTimeoutMs ?? resolveTimeoutMs(input),
  });

  const state = createStreamState(input.sessionId ?? null);
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let stdoutBuffer = "";
  let stderr = "";
  const MAX_STDERR_BUFFER = 65_536;
  let streamProcessingError: unknown = null;

  emitEvent(state, execution, {
    type: "system:init",
    timestamp: new Date().toISOString(),
    level: "debug",
    message: "OpenCode process spawned",
    data: { pid: child.pid, transport: "cli" },
  });

  const flushCompleteLines = (): void => {
    let newlineIdx = stdoutBuffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = stdoutBuffer.slice(0, newlineIdx);
      stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
      processOpenCodeJsonLine(line, state, input, logger);
      newlineIdx = stdoutBuffer.indexOf("\n");
    }
  };

  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdoutBuffer += typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk);
    try {
      flushCompleteLines();
    } catch (err) {
      streamProcessingError = err;
      logger?.error?.({ runtimeId: input.runtimeId, err }, "OpenCode CLI stream processing error");
      child.kill("SIGTERM");
    }
  });

  child.stderr?.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : stderrDecoder.write(chunk);
    stderr += text;
    if (stderr.length > MAX_STDERR_BUFFER) {
      stderr = stderr.slice(-MAX_STDERR_BUFFER);
    }
    execution?.onStderr?.(text);
  });

  // Prompt goes via stdin — long agent prompts exceed argv length limits,
  // and `opencode run` reads the message from stdin when no positional
  // message is provided. Close stdin so the CLI does not wait for input.
  child.stdin?.on("error", () => {
    /* ignore broken-pipe */
  });
  if (fullPrompt) {
    child.stdin?.write(fullPrompt, "utf8");
  }
  child.stdin?.end();

  const abortSignal = execution?.abortController?.signal;
  const onAbort = () => {
    child.kill("SIGTERM");
  };
  if (abortSignal) {
    if (abortSignal.aborted) {
      onAbort();
    } else {
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      killed = true;
      timeouts.cleanup();
      abortSignal?.removeEventListener("abort", onAbort);
      reject(classifyOpenCodeRuntimeError(error));
    });

    child.on("close", async (code) => {
      if (settled) return;
      settled = true;
      killed = true;
      timeouts.cleanup();
      abortSignal?.removeEventListener("abort", onAbort);

      const trailingStderr = stderrDecoder.end();
      if (trailingStderr) {
        stderr += trailingStderr;
        execution?.onStderr?.(trailingStderr);
      }

      stdoutBuffer += stdoutDecoder.end();
      try {
        flushCompleteLines();
      } catch (err) {
        if (!streamProcessingError) {
          streamProcessingError = err;
        }
      }

      if (abortSignal?.aborted) {
        reject(
          new OpenCodeRuntimeAdapterError(
            "OpenCode execution was aborted",
            "OPENCODE_ABORTED",
            "unknown",
          ),
        );
        return;
      }

      if (stdoutBuffer.length > 0) {
        try {
          processOpenCodeJsonLine(stdoutBuffer, state, input, logger);
        } catch {
          /* ignore tail errors */
        }
        stdoutBuffer = "";
      }

      const startTimedOut = await timeouts.startTimedOut;

      if (streamProcessingError) {
        reject(classifyOpenCodeRuntimeError(streamProcessingError));
        return;
      }

      if (startTimedOut) {
        const startMs = execution?.startTimeoutMs ?? 0;
        logger?.warn?.(
          { runtimeId: input.runtimeId, startTimeoutMs: startMs },
          "OpenCode CLI start timeout — process produced no output",
        );
        resolve({ result: null, startTimedOut: true });
        return;
      }

      if (timeouts.runTimedOut) {
        const runMs = execution?.runTimeoutMs ?? resolveTimeoutMs(input);
        reject(makeProcessRunTimeoutError(runMs));
        return;
      }

      if (state.errorEvent) {
        // Structured provider error surfaced by the CLI (status, retryAfterMs).
        reject(
          classifyOpenCodeRuntimeError(
            new Error(`OpenCode CLI error: ${state.errorEvent.message}`),
            state.errorEvent.status,
            { retryAfterMs: state.errorEvent.retryAfterMs },
          ),
        );
        return;
      }

      if (code !== 0) {
        const message = `OpenCode CLI exited with code ${code}: ${
          stderr || state.finalText || state.plainTextFallback || "unknown error"
        }`;
        reject(classifyOpenCodeRuntimeError(message));
        return;
      }

      const finalOutput =
        state.finalText.trim() ||
        state.stepTexts.join("\n\n").trim() ||
        state.plainTextFallback.trim() ||
        "OpenCode completed execution.";

      logger?.info?.(
        {
          runtimeId: input.runtimeId,
          sessionId: state.sessionId,
          outputLength: finalOutput.length,
          hasUsage: state.usage.sawStepFinish,
        },
        "OpenCode CLI run completed",
      );

      resolve({
        result: {
          outputText: finalOutput,
          sessionId: state.sessionId,
          usage: finalizeUsage(state.usage),
          events: state.events,
        },
        startTimedOut: false,
      });
    });
  });
}

export async function runOpenCodeCli(
  input: RuntimeRunInput,
  logger?: OpenCodeCliLogger,
  adapterDefaults?: { opencodeCliPath?: string },
): Promise<RuntimeRunResult> {
  const cliPath = resolveCliPath(input.options, adapterDefaults?.opencodeCliPath);
  const execution = input.execution;
  const env = buildCuratedEnv(execution?.environment);

  logger?.info?.(
    {
      runtimeId: input.runtimeId,
      profileId: input.profileId ?? null,
      transport: "cli",
      cliPath,
      model: input.model ?? null,
      sessionId: input.sessionId ?? null,
      startTimeoutMs: execution?.startTimeoutMs ?? null,
      runTimeoutMs: execution?.runTimeoutMs ?? resolveTimeoutMs(input),
    },
    "Starting OpenCode CLI run",
  );

  const { result, startTimedOut } = await runCliAttempt(input, cliPath, env, logger);

  if (startTimedOut || !result) {
    const abortSignal = execution?.abortController?.signal;
    if (abortSignal?.aborted) {
      throw new OpenCodeRuntimeAdapterError(
        "OpenCode execution was aborted",
        "OPENCODE_ABORTED",
        "unknown",
      );
    }

    const retryDelayMs = resolveRetryDelay(execution ?? {});
    logger?.warn?.(
      { runtimeId: input.runtimeId, retryDelayMs },
      "OpenCode CLI start timeout, retrying once after delay",
    );
    await sleepMs(retryDelayMs);

    if (abortSignal?.aborted) {
      throw new OpenCodeRuntimeAdapterError(
        "OpenCode execution was aborted",
        "OPENCODE_ABORTED",
        "unknown",
      );
    }

    const retry = await runCliAttempt(input, cliPath, env, logger);
    if (retry.startTimedOut || !retry.result) {
      throw makeProcessStartTimeoutError(execution?.startTimeoutMs ?? 0);
    }
    return retry.result;
  }

  return result;
}

/* ------------------------------------------------------------------ */
/*  Model discovery via `opencode models`                             */
/* ------------------------------------------------------------------ */

export function parseOpenCodeModelsOutput(output: string): {
  id: string;
  label: string;
  supportsStreaming: boolean;
}[] {
  const models: { id: string; label: string; supportsStreaming: boolean }[] = [];
  const seen = new Set<string>();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.includes("/")) continue;
    const id = line;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: id, supportsStreaming: true });
  }
  return models;
}

export function listOpenCodeCliModels(
  input: { runtimeId: string; options?: Record<string, unknown> },
  logger?: OpenCodeCliLogger,
  adapterDefaults?: { opencodeCliPath?: string },
): { id: string; label: string; supportsStreaming: boolean }[] {
  const cliPath = resolveCliPath(input.options, adapterDefaults?.opencodeCliPath, findOpenCodePath);
  const env = buildCuratedEnv();
  const out = execFileSync(cliPath, ["models"], {
    timeout: 30_000,
    shell: IS_WINDOWS,
    encoding: "utf8",
    windowsHide: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const models = parseOpenCodeModelsOutput(out ?? "");
  logger?.debug?.(
    { runtimeId: input.runtimeId, cliPath, modelCount: models.length },
    "OpenCode CLI model discovery completed",
  );
  return models;
}
