import {
  RuntimeTransport,
  UsageReporting,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeConnectionValidationInput,
  type RuntimeConnectionValidationResult,
  type RuntimeDiagnoseErrorInput,
  type RuntimeModel,
  type RuntimeModelListInput,
  type RuntimeRunInput,
  type RuntimeRunResult,
  type RuntimeSession,
  type RuntimeSessionEventsInput,
  type RuntimeSessionGetInput,
  type RuntimeSessionListInput,
  type RuntimeEvent,
} from "../../types.js";
import {
  getOpenCodeSession,
  listOpenCodeApiModels,
  listOpenCodeSessionEvents,
  listOpenCodeSessions,
  runOpenCodeApi,
  validateOpenCodeApiConnection,
  type OpenCodeApiLogger,
} from "./api.js";
import { listOpenCodeCliModels, runOpenCodeCli } from "./cli.js";
import { probeOpenCodeCli, resolveCliPath } from "./cliPath.js";
import { classifyOpenCodeRuntimeError, OpenCodeRuntimeAdapterError } from "./errors.js";
import { RuntimeExecutionError } from "../../errors.js";

export type OpenCodeRuntimeAdapterLogger = OpenCodeApiLogger;

export interface CreateOpenCodeRuntimeAdapterOptions {
  runtimeId?: string;
  providerId?: string;
  displayName?: string;
  logger?: OpenCodeRuntimeAdapterLogger;
  /** Explicit OpenCode CLI executable default (overridable per-run via options.opencodeCliPath). */
  cliPath?: string;
}

const API_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: true,
  supportsSessionFork: false,
  supportsSessionList: true,
  supportsAgentDefinitions: false,
  supportsStreaming: true,
  supportsModelDiscovery: true,
  supportsApprovals: false,
  supportsCustomEndpoint: true,
  // OpenCode server returns messages but does not surface token counts in its
  // message payload. The run() path never populates RuntimeRunResult.usage,
  // so declare the contract honestly as NONE — dashboards will show this
  // provider as opted-out of usage tracking rather than showing phantom zeros.
  usageReporting: UsageReporting.NONE,
};

// CLI transport (`opencode run --format json`): `step_finish` events carry
// token/cost totals when the provider reports usage (local models often do
// not), and timeout/kill paths may miss the final step, so PARTIAL is the
// honest declaration. Session browsing is an API-server feature only.
const CLI_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: true,
  supportsSessionFork: false,
  supportsSessionList: false,
  supportsAgentDefinitions: false,
  supportsStreaming: true,
  supportsModelDiscovery: true,
  supportsApprovals: false,
  supportsCustomEndpoint: false,
  usageReporting: UsageReporting.PARTIAL,
};

function resolveTransport(
  input: { transport?: RuntimeTransport; options?: Record<string, unknown> },
  logger?: OpenCodeRuntimeAdapterLogger,
): RuntimeTransport {
  const raw =
    input.transport ??
    (typeof input.options?.transport === "string" ? input.options.transport : undefined);

  if (raw === RuntimeTransport.CLI) return RuntimeTransport.CLI;
  if (raw === RuntimeTransport.API || raw === undefined) return RuntimeTransport.API;

  logger?.warn?.(
    {
      runtimeId: "opencode",
      unknownTransport: raw,
      fallbackTransport: RuntimeTransport.API,
    },
    "OpenCode adapter received an unsupported transport; falling back to API",
  );
  return RuntimeTransport.API;
}

const DEFAULT_OPENCODE_MODELS: RuntimeModel[] = [
  {
    id: "anthropic/claude-sonnet-4",
    label: "anthropic/claude-sonnet-4",
    supportsStreaming: true,
  },
  {
    id: "openai/gpt-5.4",
    label: "openai/gpt-5.4",
    supportsStreaming: true,
  },
];

function createFallbackLogger(): OpenCodeRuntimeAdapterLogger {
  return {
    debug(context, message) {
      console.debug("[runtime:opencode]", message, context);
    },
    info(context, message) {
      console.info("INFO [runtime:opencode]", message, context);
    },
    warn(context, message) {
      console.warn("WARN [runtime:opencode]", message, context);
    },
    error(context, message) {
      console.error("ERROR [runtime:opencode]", message, context);
    },
  };
}

function diagnoseErrorMessage(input: RuntimeDiagnoseErrorInput): string {
  const message = input.error instanceof Error ? input.error.message : String(input.error);

  // CLI-specific: spawn failure for a missing binary (structured code)
  if (
    input.error instanceof OpenCodeRuntimeAdapterError &&
    input.error.adapterCode === "OPENCODE_CLI_NOT_FOUND"
  ) {
    return "OpenCode CLI binary not found. Install OpenCode (https://opencode.ai) or point options.opencodeCliPath / OPENCODE_CLI_PATH at the executable. On the host, `opencode auth login` configures provider credentials (including local models).";
  }

  // Primary: dispatch on structured category when available
  if (input.error instanceof RuntimeExecutionError && input.error.category !== "unknown") {
    switch (input.error.category) {
      case "auth":
        return "OpenCode server authentication failed. Verify OPENCODE_SERVER_PASSWORD (and OPENCODE_SERVER_USERNAME if customized).";
      case "rate_limit":
        return "OpenCode request was rate-limited. Retry with backoff or reduce request frequency.";
      case "timeout":
        return "OpenCode request timed out. Increase timeoutMs or check server responsiveness.";
      case "transport":
        return "Cannot reach OpenCode server. Start opencode serve and verify baseUrl/port.";
      case "model_not_found":
        return "OpenCode provider/model is not available. Check GET /config/providers and use an exact providerID/modelID pair from that response.";
      case "permission":
        return `OpenCode permission denied. ${message}`;
      case "stream":
        return `OpenCode stream interrupted. ${message}`;
    }
  }

  // Fallback: string matching for unclassified errors or plain Error instances
  const combined = `${message} ${input.stderrTail ?? ""}`.toLowerCase();

  if (
    combined.includes("unauthorized") ||
    combined.includes("invalid password") ||
    combined.includes("401") ||
    combined.includes("403")
  ) {
    return "OpenCode server authentication failed. Verify OPENCODE_SERVER_PASSWORD (and OPENCODE_SERVER_USERNAME if customized).";
  }
  if (combined.includes("rate") || combined.includes("429") || combined.includes("quota")) {
    return "OpenCode request was rate-limited. Retry with backoff or reduce request frequency.";
  }
  if (
    combined.includes("connection refused") ||
    combined.includes("econnrefused") ||
    combined.includes("fetch failed") ||
    combined.includes("network")
  ) {
    return "Cannot reach OpenCode server. Start opencode serve and verify baseUrl/port.";
  }
  if (combined.includes("session") && combined.includes("not found")) {
    return "OpenCode session not found. Create a new session or provide a valid sessionId.";
  }
  if (
    combined.includes("providermodelnotfounderror") ||
    combined.includes("modelnotfounderror") ||
    combined.includes("provider not found") ||
    combined.includes("model not found")
  ) {
    return "OpenCode provider/model is not available. Check GET /config/providers and use an exact providerID/modelID pair from that response.";
  }

  return `OpenCode error: ${message}`;
}

export function createOpenCodeRuntimeAdapter(
  options: CreateOpenCodeRuntimeAdapterOptions = {},
): RuntimeAdapter {
  const runtimeId = options.runtimeId ?? "opencode";
  const providerId = options.providerId ?? "opencode";
  const logger = options.logger ?? createFallbackLogger();
  const cliDefaults = options.cliPath ? { opencodeCliPath: options.cliPath } : undefined;

  return {
    descriptor: {
      id: runtimeId,
      providerId,
      displayName: options.displayName ?? "OpenCode",
      supportsProjectInit: true,
      projectInitAgentName: "opencode",
      lightModel: null,
      defaultBaseUrlEnvVar: "OPENCODE_BASE_URL",
      defaultModelPlaceholder: "anthropic/claude-sonnet-4",
      supportedTransports: [RuntimeTransport.API, RuntimeTransport.CLI],
      defaultTransport: RuntimeTransport.API,
      capabilities: API_CAPABILITIES,
    },

    getEffectiveCapabilities(transport?: RuntimeTransport): RuntimeCapabilities {
      return transport === RuntimeTransport.CLI ? CLI_CAPABILITIES : API_CAPABILITIES;
    },

    async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
      const transport = resolveTransport(input, logger);

      logger.info?.(
        {
          runtimeId,
          profileId: input.profileId ?? null,
          transport,
          sessionId: input.sessionId ?? null,
          model: input.model ?? null,
          stream: input.stream ?? null,
        },
        "OpenCode adapter run invoked",
      );

      try {
        if (transport === RuntimeTransport.CLI) {
          return await runOpenCodeCli(
            { ...input, transport: RuntimeTransport.CLI },
            logger,
            cliDefaults,
          );
        }
        return await runOpenCodeApi({ ...input, transport: RuntimeTransport.API }, logger);
      } catch (error) {
        logger.error?.(
          {
            runtimeId,
            profileId: input.profileId ?? null,
            error: error instanceof Error ? error.message : String(error),
          },
          "OpenCode adapter run failed",
        );
        throw classifyOpenCodeRuntimeError(error);
      }
    },

    async resume(input: RuntimeRunInput & { sessionId: string }): Promise<RuntimeRunResult> {
      const transport = resolveTransport(input, logger);

      logger.info?.(
        {
          runtimeId,
          profileId: input.profileId ?? null,
          transport,
          sessionId: input.sessionId,
        },
        "OpenCode adapter resume invoked",
      );

      try {
        if (transport === RuntimeTransport.CLI) {
          return await runOpenCodeCli(
            { ...input, transport: RuntimeTransport.CLI, resume: true },
            logger,
            cliDefaults,
          );
        }
        return await runOpenCodeApi(
          { ...input, transport: RuntimeTransport.API, resume: true },
          logger,
        );
      } catch (error) {
        throw classifyOpenCodeRuntimeError(error);
      }
    },

    async listSessions(input: RuntimeSessionListInput): Promise<RuntimeSession[]> {
      return listOpenCodeSessions(input, logger);
    },

    async getSession(input: RuntimeSessionGetInput): Promise<RuntimeSession | null> {
      return getOpenCodeSession(input, logger);
    },

    async listSessionEvents(input: RuntimeSessionEventsInput): Promise<RuntimeEvent[]> {
      return listOpenCodeSessionEvents(input, logger);
    },

    async validateConnection(
      input: RuntimeConnectionValidationInput,
    ): Promise<RuntimeConnectionValidationResult> {
      const transport = resolveTransport(input, logger);

      if (transport === RuntimeTransport.CLI) {
        const cliPath = resolveCliPath(input.options, cliDefaults?.opencodeCliPath);
        const probe = probeOpenCodeCli(cliPath);
        if (!probe.ok) {
          return {
            ok: false,
            message: `OpenCode CLI is not reachable (${cliPath}): ${probe.error ?? "unknown error"}`,
          };
        }
        return {
          ok: true,
          message: `OpenCode CLI ${probe.version ?? "unknown"} (${cliPath})`,
        };
      }

      return validateOpenCodeApiConnection({ ...input, transport: RuntimeTransport.API });
    },

    async listModels(input: RuntimeModelListInput): Promise<RuntimeModel[]> {
      const transport = resolveTransport(input, logger);

      try {
        if (transport === RuntimeTransport.CLI) {
          const models = listOpenCodeCliModels(input, logger, cliDefaults);
          if (models.length > 0) {
            logger.debug?.(
              {
                runtimeId: input.runtimeId,
                profileId: input.profileId ?? null,
                modelCount: models.length,
              },
              "Fetched model list from OpenCode CLI",
            );
            return models;
          }
          throw new Error("OpenCode CLI returned an empty model list");
        }

        const models = await listOpenCodeApiModels(input);
        if (models.length > 0) {
          logger.debug?.(
            {
              runtimeId: input.runtimeId,
              profileId: input.profileId ?? null,
              modelCount: models.length,
            },
            "Fetched model list from OpenCode API",
          );
          return models;
        }
      } catch {
        logger.warn?.(
          {
            runtimeId: input.runtimeId,
            profileId: input.profileId ?? null,
            transport,
          },
          "OpenCode model discovery failed, falling back to built-in list",
        );
      }

      return DEFAULT_OPENCODE_MODELS;
    },

    async diagnoseError(input: RuntimeDiagnoseErrorInput): Promise<string> {
      return diagnoseErrorMessage(input);
    },
  };
}
