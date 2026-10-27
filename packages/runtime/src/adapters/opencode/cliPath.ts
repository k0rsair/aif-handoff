import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { assertSafeWindowsShellExecutablePath } from "../../shellSafety.js";

const IS_WINDOWS = process.platform === "win32";

/**
 * Find the OpenCode CLI executable from common install locations.
 * OpenCode 2 installs itself under `~/.opencode/bin` (curl installer and
 * `opencode upgrade --major`); npm globals land in the npm bin directory.
 */
export function findOpenCodePath(): string | undefined {
  const fromEnv = process.env.OPENCODE_CLI_PATH;
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv;
  }

  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const localAppData = process.env.LOCALAPPDATA ?? "";

  const candidates = IS_WINDOWS
    ? [
        resolve(homeDir, ".opencode/bin/opencode.exe"),
        resolve(localAppData, "opencode/bin/opencode.exe"),
        resolve(process.env.APPDATA ?? "", "npm/opencode.exe"),
      ]
    : [
        resolve(homeDir, ".opencode/bin/opencode"),
        resolve(homeDir, ".local/bin/opencode"),
        "/usr/local/bin/opencode",
        "/opt/homebrew/bin/opencode",
      ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Fallback: check PATH
  const locator = IS_WINDOWS ? "where" : "which";
  try {
    const result = execFileSync(locator, ["opencode"], {
      encoding: "utf8",
      timeout: 3_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^"(.*)"$/, "$1"))
      .find((line) => {
        if (!line || !existsSync(line)) return false;
        if (IS_WINDOWS) {
          const lower = line.toLowerCase();
          if (lower.endsWith(".cmd") || lower.endsWith(".bat")) return false;
        }
        return true;
      });

    if (result) return result;
  } catch {
    // locator command not found or opencode not in PATH
  }

  return undefined;
}

/**
 * Probe whether the OpenCode CLI is reachable and return its version banner.
 */
export function probeOpenCodeCli(cliPath: string): {
  ok: boolean;
  version?: string;
  error?: string;
} {
  try {
    if (IS_WINDOWS) {
      assertSafeWindowsShellExecutablePath(cliPath, "OpenCode CLI path");
    }
    const out = execFileSync(cliPath, ["--version"], {
      timeout: 5_000,
      shell: IS_WINDOWS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { ok: true, version: out.toString().trim() };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Unifies OpenCode CLI executable resolution across execution, validation,
 * and model discovery. Precedence: profile option → adapter default →
 * well-known install locations → PATH.
 */
export function resolveCliPath(
  options?: Record<string, unknown>,
  fallbackPath?: string,
  finder: () => string | undefined = findOpenCodePath,
): string {
  if (typeof options?.opencodeCliPath === "string" && options.opencodeCliPath.trim().length > 0) {
    return options.opencodeCliPath.trim();
  }
  const defaultBinary = IS_WINDOWS ? "opencode.exe" : "opencode";
  return fallbackPath ?? finder() ?? defaultBinary;
}
