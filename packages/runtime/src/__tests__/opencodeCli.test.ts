import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeRunInput } from "../types.js";
import { TEST_USAGE_CONTEXT } from "./helpers/usageContext.js";
import { getCliSpawnInvocation } from "./helpers/cliSpawn.js";

const {
  mockStdout,
  mockStderr,
  mockStdin,
  mockChild,
  mockSpawn,
  mockSpawnSync,
  mockExecFileSync,
  mockWithProcessTimeouts,
  mockSleepMs,
} = vi.hoisted(() => {
  const stdout = { on: vi.fn() };
  const stderr = { on: vi.fn() };
  const stdin = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
  const child = {
    pid: 4321,
    stdout,
    stderr,
    stdin,
    on: vi.fn(),
    kill: vi.fn(),
  };
  const spawn = vi.fn().mockReturnValue(child);
  return {
    mockStdout: stdout,
    mockStderr: stderr,
    mockStdin: stdin,
    mockChild: child,
    mockSpawn: spawn,
    mockSpawnSync: vi.fn().mockReturnValue({ status: 0 }),
    mockExecFileSync: vi.fn().mockReturnValue("opencode v2.1.4"),
    mockWithProcessTimeouts: vi.fn(),
    mockSleepMs: vi.fn(),
  };
});

const mockProcessKill = vi.spyOn(process, "kill").mockImplementation((() => true) as never);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: mockSpawn,
    spawnSync: mockSpawnSync,
    execFileSync: mockExecFileSync,
  };
});

vi.mock("../timeouts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../timeouts.js")>();
  return {
    ...actual,
    withProcessTimeouts: (...args: unknown[]) => {
      if (mockWithProcessTimeouts.getMockImplementation()) {
        return mockWithProcessTimeouts(...args);
      }
      return (actual.withProcessTimeouts as (...a: unknown[]) => unknown)(...args);
    },
    sleepMs: (...args: unknown[]) => {
      if (mockSleepMs.getMockImplementation()) {
        return mockSleepMs(...args);
      }
      return (actual.sleepMs as (...a: unknown[]) => unknown)(...args);
    },
  };
});

const {
  buildCliArgs,
  processOpenCodeJsonLine,
  parseOpenCodeModelsOutput,
  listOpenCodeCliModels,
  runOpenCodeCli,
  buildCuratedEnv,
} = await import("../adapters/opencode/cli.js");
const { resolveCliPath, findOpenCodePath, probeOpenCodeCli } =
  await import("../adapters/opencode/cliPath.js");
const { OpenCodeRuntimeAdapterError } = await import("../adapters/opencode/errors.js");

function createInput(overrides: Partial<RuntimeRunInput> = {}): RuntimeRunInput {
  return {
    runtimeId: "opencode",
    providerId: "opencode",
    prompt: "Test prompt",
    options: {},
    projectRoot: "/tmp/project",
    cwd: "/tmp/project",
    usageContext: TEST_USAGE_CONTEXT,
    ...overrides,
  };
}

function findLastCall<T>(calls: T[], predicate: (item: T) => boolean): T | undefined {
  for (let i = calls.length - 1; i >= 0; i--) {
    const item = calls[i];
    if (item !== undefined && predicate(item)) {
      return item;
    }
  }
  return undefined;
}

/** Real `opencode run --format json` event shapes captured from OpenCode v2.1.4. */
function stepStartEvent(sessionId: string) {
  return {
    type: "step_start",
    timestamp: 1793128694714,
    sessionID: sessionId,
    part: { id: "prt_1", sessionID: sessionId, messageID: "msg_1", type: "step-start" },
  };
}

function textEvent(sessionId: string, text: string) {
  return {
    type: "text",
    timestamp: 1793128695137,
    sessionID: sessionId,
    part: { id: "prt_2", sessionID: sessionId, messageID: "msg_1", type: "text", text },
  };
}

function toolUseEvent(sessionId: string) {
  return {
    type: "tool_use",
    timestamp: 1793128777934,
    sessionID: sessionId,
    part: {
      partID: "prt_3",
      sessionID: sessionId,
      messageID: "msg_1",
      type: "tool",
      id: "call_1",
      tool: "shell",
      state: {
        status: "completed",
        input: { command: "echo hello" },
        output: "hello\n",
        title: "shell",
      },
    },
  };
}

function stepFinishEvent(sessionId: string, tokens: Record<string, unknown>, cost = 0) {
  return {
    type: "step_finish",
    timestamp: 1793128777934,
    sessionID: sessionId,
    part: {
      id: "prt_4",
      sessionID: sessionId,
      messageID: "msg_1",
      type: "step-finish",
      reason: "stop",
      cost,
      tokens,
    },
  };
}

function simulateStreamAndClose(code: number, jsonlLines: unknown[] = [], stderrText = "") {
  const stdoutHandler = findLastCall(
    mockStdout.on.mock.calls,
    (c: unknown[]) => c[0] === "data",
  )?.[1] as ((chunk: string) => void) | undefined;
  for (const line of jsonlLines) {
    const text = typeof line === "string" ? line : JSON.stringify(line);
    stdoutHandler?.(text + "\n");
  }

  if (stderrText) {
    const stderrHandler = findLastCall(
      mockStderr.on.mock.calls,
      (c: unknown[]) => c[0] === "data",
    )?.[1] as ((chunk: string) => void) | undefined;
    stderrHandler?.(stderrText);
  }

  const closeHandler = findLastCall(
    mockChild.on.mock.calls,
    (c: unknown[]) => c[0] === "close",
  )?.[1] as ((code: number) => void) | undefined;
  closeHandler?.(code);
}

describe("OpenCode CLI transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockClear();
    mockSpawn.mockReturnValue(mockChild);
    mockProcessKill.mockClear();
    mockProcessKill.mockImplementation((() => true) as never);
    mockSpawnSync.mockReset();
    mockSpawnSync.mockReturnValue({ status: 0 });
    mockExecFileSync.mockReset();
    mockExecFileSync.mockReturnValue("opencode v2.1.4");
    mockWithProcessTimeouts.mockReset();
    mockSleepMs.mockReset();
  });

  afterAll(() => {
    mockProcessKill.mockRestore();
  });

  describe("buildCliArgs", () => {
    it("builds non-interactive JSON run args with model", () => {
      const args = buildCliArgs(createInput({ model: "lmstudio/qwen2.5-vl-7b-instruct" }));
      expect(args.slice(0, 3)).toEqual(["run", "--format", "json"]);
      expect(args).toContain("--model");
      expect(args).toContain("lmstudio/qwen2.5-vl-7b-instruct");
    });

    it("prepends provider when model lacks provider/model syntax", () => {
      const args = buildCliArgs(
        createInput({ model: "qwen3.5-27b", options: { providerID: "localllm" } }),
      );
      expect(args).toContain("localllm/qwen3.5-27b");
    });

    it("maps reasoningEffort option to the model variant suffix", () => {
      const args = buildCliArgs(
        createInput({
          model: "strata/qwen3.8-flash",
          options: { reasoningEffort: "high" },
        }),
      );
      expect(args).toContain("strata/qwen3.8-flash#high");
    });

    it("prefers explicit modelVariant over reasoningEffort", () => {
      const args = buildCliArgs(
        createInput({
          model: "strata/qwen3.8-flash",
          options: { modelVariant: "xhigh", reasoningEffort: "high" },
        }),
      );
      expect(args).toContain("strata/qwen3.8-flash#xhigh");
    });

    it("passes session id for resume flows", () => {
      const args = buildCliArgs(createInput({ sessionId: "ses_abc123" }));
      const idx = args.indexOf("--session");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe("ses_abc123");
    });

    it("adds --auto only for bypassPermissions", () => {
      expect(buildCliArgs(createInput())).not.toContain("--auto");
      const args = buildCliArgs(createInput({ execution: { bypassPermissions: true } }));
      expect(args).toContain("--auto");
    });
  });

  describe("buildCuratedEnv", () => {
    it("forwards OPENCODE_* and blocks unrelated provider keys", () => {
      const env = buildCuratedEnv(
        { CUSTOM: "yes" },
        {
          OPENCODE_CONFIG_DIR: "/tmp/ocfg",
          OPENCODE_DISABLE_AUTOUPDATE: "true",
          PATH: "/usr/bin",
          HOME: "/home/node",
          OPENAI_API_KEY: "secret",
          ANTHROPIC_API_KEY: "secret",
        },
      );
      expect(env.OPENCODE_CONFIG_DIR).toBe("/tmp/ocfg");
      expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe("true");
      expect(env.PATH).toBe("/usr/bin");
      expect(env.CUSTOM).toBe("yes");
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });
  });

  describe("runOpenCodeCli", () => {
    it("spawns with curated args, delivers prompt via stdin, and maps events", async () => {
      const onEvent = vi.fn();
      const onToolUse = vi.fn();
      const sessionId = "ses_test123";

      const runPromise = runOpenCodeCli(
        createInput({
          model: "lmstudio/qwen2.5-vl-7b-instruct",
          execution: { onEvent, onToolUse },
        }),
        undefined,
        { opencodeCliPath: "/usr/local/bin/opencode" },
      );

      simulateStreamAndClose(0, [
        stepStartEvent(sessionId),
        toolUseEvent(sessionId),
        stepFinishEvent(
          sessionId,
          { input: 8601, output: 47, reasoning: 0, cache: { read: 100, write: 0 } },
          0.25,
        ),
        stepStartEvent(sessionId),
        textEvent(sessionId, "First step answer"),
        textEvent(sessionId, "Final answer"),
      ]);

      const result = await runPromise;

      const { cliPath, cliArgs, spawnOptions } = getCliSpawnInvocation(mockSpawn as never);
      expect(cliPath).toBe("/usr/local/bin/opencode");
      expect(cliArgs.slice(0, 3)).toEqual(["run", "--format", "json"]);
      expect(spawnOptions.cwd).toBe("/tmp/project");
      expect(spawnOptions.detached).toBe(true);

      expect(result.sessionId).toBe(sessionId);
      expect(result.outputText).toBe("Final answer");
      expect(result.usage).toEqual({
        inputTokens: 8701,
        outputTokens: 47,
        totalTokens: 8748,
        costUsd: 0.25,
      });

      expect(onToolUse).toHaveBeenCalledWith("shell", expect.stringContaining("echo hello"));
      const eventTypes = onEvent.mock.calls.map((c: unknown[]) => (c[0] as { type: string }).type);
      expect(eventTypes).toContain("system:init");
      expect(eventTypes).toContain("tool:use");
      expect(eventTypes).toContain("tool:result");
      expect(eventTypes.filter((t: string) => t === "stream:text")).toHaveLength(2);

      // Prompt goes to stdin, not argv
      expect(mockStdin.write).toHaveBeenCalledWith("Test prompt", "utf8");
      expect(mockStdin.end).toHaveBeenCalled();
    });

    it("reports null usage when no step_finish events arrive (local model without tokens)", async () => {
      const runPromise = runOpenCodeCli(createInput({ model: "strata/local-model" }));
      simulateStreamAndClose(0, [stepStartEvent("ses_x"), textEvent("ses_x", "PONG")]);

      const result = await runPromise;
      expect(result.outputText).toBe("PONG");
      expect(result.usage).toBeNull();
    });

    it("accumulates usage across multiple step_finish events", async () => {
      const runPromise = runOpenCodeCli(createInput());
      simulateStreamAndClose(0, [
        stepStartEvent("ses_x"),
        stepFinishEvent("ses_x", {
          input: 100,
          output: 10,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        }),
        stepFinishEvent(
          "ses_x",
          { input: 200, output: 20, reasoning: 5, cache: { read: 50, write: 0 } },
          0.5,
        ),
        textEvent("ses_x", "done"),
      ]);

      const result = await runPromise;
      expect(result.usage).toEqual({
        inputTokens: 350,
        outputTokens: 35,
        totalTokens: 385,
        costUsd: 0.5,
      });
    });

    it("classifies provider error events with structured status metadata", async () => {
      const runPromise = runOpenCodeCli(createInput());

      simulateStreamAndClose(1, [
        {
          type: "error",
          timestamp: 1793128644722,
          sessionID: "ses_err",
          error: {
            type: "provider.free-limit",
            message: "Free usage limit reached.",
            status: 429,
            retryAfterMs: 16956000,
          },
        },
      ]);

      await expect(runPromise).rejects.toMatchObject({
        name: "OpenCodeRuntimeAdapterError",
        category: "rate_limit",
        adapterCode: "OPENCODE_RATE_LIMIT",
        httpStatus: 429,
        retryAfterMs: 16956000,
      });
    });

    it("classifies ENOENT spawn failures as OPENCODE_CLI_NOT_FOUND", async () => {
      const runPromise = runOpenCodeCli(createInput());

      const errorHandler = findLastCall(
        mockChild.on.mock.calls,
        (c: unknown[]) => c[0] === "error",
      )?.[1] as ((err: Error) => void) | undefined;
      const spawnError = Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" });
      errorHandler?.(spawnError);

      await expect(runPromise).rejects.toBeInstanceOf(OpenCodeRuntimeAdapterError);
      await expect(runPromise).rejects.toMatchObject({
        adapterCode: "OPENCODE_CLI_NOT_FOUND",
        category: "transport",
      });
    });

    it("classifies non-zero exit without error event", async () => {
      const runPromise = runOpenCodeCli(createInput());
      simulateStreamAndClose(2, [], "boom");

      await expect(runPromise).rejects.toMatchObject({
        name: "OpenCodeRuntimeAdapterError",
        message: expect.stringContaining("exited with code 2"),
      });
    });

    it("falls back to plain text when stdout is not JSONL", async () => {
      const runPromise = runOpenCodeCli(createInput());
      simulateStreamAndClose(0, ["not json at all", "still text"]);

      const result = await runPromise;
      expect(result.outputText).toContain("not json at all");
      expect(result.usage).toBeNull();
    });

    it("rejects with timeout error when run timeout fires", async () => {
      mockWithProcessTimeouts.mockReturnValue({
        cleanup: vi.fn(),
        startTimedOut: Promise.resolve(false),
        runTimedOut: true,
      });

      const runPromise = runOpenCodeCli(createInput());
      simulateStreamAndClose(null as never, [stepStartEvent("ses_x")]);

      await expect(runPromise).rejects.toMatchObject({ category: "timeout" });
    });

    it("retries once after a start timeout", async () => {
      mockSleepMs.mockImplementation(() => Promise.resolve());
      let attempt = 0;
      mockWithProcessTimeouts.mockImplementation(() => {
        attempt += 1;
        if (attempt === 1) {
          return {
            cleanup: vi.fn(),
            startTimedOut: Promise.resolve(true),
            runTimedOut: false,
          };
        }
        return {
          cleanup: vi.fn(),
          startTimedOut: Promise.resolve(false),
          runTimedOut: false,
        };
      });

      const runPromise = runOpenCodeCli(createInput({ model: "strata/local-model" }));
      simulateStreamAndClose(0, []);
      await new Promise((resolve) => setTimeout(resolve, 0));
      simulateStreamAndClose(0, [stepStartEvent("ses_retry"), textEvent("ses_retry", "RECOVERED")]);

      const result = await runPromise;
      expect(result.outputText).toBe("RECOVERED");
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    it("rejects when aborted", async () => {
      const abortController = new AbortController();
      abortController.abort();

      const runPromise = runOpenCodeCli(createInput({ execution: { abortController } }));
      simulateStreamAndClose(0, [stepStartEvent("ses_x"), textEvent("ses_x", "hi")]);

      await expect(runPromise).rejects.toMatchObject({
        adapterCode: "OPENCODE_ABORTED",
      });
    });
  });

  describe("processOpenCodeJsonLine", () => {
    it("captures sessionID from any event and ignores unknown types", () => {
      const state = {
        sessionId: null,
        events: [],
        stepTexts: [],
        finalText: "",
        plainTextFallback: "",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          sawStepFinish: false,
        },
        errorEvent: null,
        initEmitted: false,
      };
      processOpenCodeJsonLine(
        JSON.stringify({ type: "some_future_event", sessionID: "ses_future" }),
        state as never,
        createInput(),
      );
      expect(state.sessionId).toBe("ses_future");
      expect(state.events).toHaveLength(0);
    });
  });

  describe("model discovery", () => {
    it("parses provider/model lines and deduplicates", () => {
      const models = parseOpenCodeModelsOutput(
        [
          "lmstudio/qwen2.5-vl-7b-instruct",
          "strata/qwen3.8-flash-next-iq3_s",
          "",
          "garbage line",
          "lmstudio/qwen2.5-vl-7b-instruct",
        ].join("\n"),
      );
      expect(models).toHaveLength(2);
      expect(models[0].id).toBe("lmstudio/qwen2.5-vl-7b-instruct");
    });

    it("invokes `opencode models` via the resolved CLI path", () => {
      mockExecFileSync.mockReturnValue("lmstudio/qwen2.5-vl-7b-instruct\nlocalllm/qwen3.5-27b\n");
      const models = listOpenCodeCliModels(
        { runtimeId: "opencode", options: { opencodeCliPath: "/usr/local/bin/opencode" } },
        undefined,
        { opencodeCliPath: "/usr/local/bin/opencode" },
      );
      expect(models).toHaveLength(2);
      const call = mockExecFileSync.mock.calls.find(
        (c: unknown[]) => c[0] === "/usr/local/bin/opencode",
      );
      expect(call?.[1]).toEqual(["models"]);
    });
  });

  describe("cli path resolution", () => {
    it("prefers options.opencodeCliPath over adapter default", () => {
      expect(
        resolveCliPath(
          { opencodeCliPath: " /custom/opencode " },
          "/default/opencode",
          () => undefined,
        ),
      ).toBe("/custom/opencode");
    });

    it("falls back to adapter default, then finder, then bare binary", () => {
      expect(resolveCliPath({}, "/default/opencode", () => "/found/opencode")).toBe(
        "/default/opencode",
      );
      expect(resolveCliPath({}, undefined, () => "/found/opencode")).toBe("/found/opencode");
      expect(resolveCliPath({}, undefined, () => undefined)).toBe("opencode");
    });

    it("honors OPENCODE_CLI_PATH env var when it exists", () => {
      const previous = process.env.OPENCODE_CLI_PATH;
      process.env.OPENCODE_CLI_PATH = process.execPath;
      try {
        expect(findOpenCodePath()).toBe(process.execPath);
      } finally {
        if (previous === undefined) delete process.env.OPENCODE_CLI_PATH;
        else process.env.OPENCODE_CLI_PATH = previous;
      }
    });

    it("probes CLI version via --version", () => {
      mockExecFileSync.mockReturnValue("opencode v2.1.4\n");
      const probe = probeOpenCodeCli("/usr/local/bin/opencode");
      expect(probe.ok).toBe(true);
      expect(probe.version).toBe("opencode v2.1.4");
    });

    it("reports probe failure when the binary is missing", () => {
      mockExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" });
      });
      const probe = probeOpenCodeCli("opencode");
      expect(probe.ok).toBe(false);
      expect(probe.error).toContain("ENOENT");
    });
  });
});
