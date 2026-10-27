import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const dockerfile = readFileSync(resolve(repositoryRoot, ".docker/Dockerfile"), "utf8");
const developmentCompose = readFileSync(resolve(repositoryRoot, "docker-compose.yml"), "utf8");
const productionCompose = readFileSync(
  resolve(repositoryRoot, "docker-compose.production.yml"),
  "utf8",
);
const environmentExample = readFileSync(resolve(repositoryRoot, ".env.example"), "utf8");
const configurationReference = readFileSync(
  resolve(repositoryRoot, "docs/configuration.md"),
  "utf8",
);
const gettingStarted = readFileSync(resolve(repositoryRoot, "docs/getting-started.md"), "utf8");
const providers = readFileSync(resolve(repositoryRoot, "docs/providers.md"), "utf8");

const reviewedOpenCodeVersion = "2.1.4";

describe("Docker OpenCode CLI version resolution", () => {
  it("pins the @opencode/cli package in runtime image builds", () => {
    expect(countMatches(dockerfile, `ARG OPENCODE_VERSION=${reviewedOpenCodeVersion}`)).toBe(2);
    expect(countMatches(dockerfile, "@opencode/cli@${OPENCODE_VERSION}")).toBe(2);
    // The legacy v1-line package must never be installed instead.
    expect(dockerfile).not.toMatch(/npm i -g [^\n]*opencode-ai/);
  });

  it("points OPENCODE_CLI_PATH at the pinned global install", () => {
    expect(countMatches(dockerfile, "OPENCODE_CLI_PATH=/usr/local/bin/opencode")).toBe(2);
  });

  it.each([
    ["development", developmentCompose],
    ["production", productionCompose],
  ])("passes OPENCODE_VERSION through the %s image builds", (_name, compose) => {
    expect(
      compose.match(
        new RegExp(`OPENCODE_VERSION: \\$\\{OPENCODE_VERSION:-${reviewedOpenCodeVersion}\\}`, "g"),
      ),
    ).toHaveLength(2);
  });

  it.each([
    ["development", developmentCompose],
    ["production", productionCompose],
  ])("mounts persistent opencode auth state in the %s compose", (_name, compose) => {
    expect(countMatches(compose, "opencode-auth:/home/node/.local/share/opencode")).toBe(2);
    expect(compose).toMatch(/\nvolumes:\n(?:[^\n]+\n)*\s+opencode-auth:/);
  });

  it("documents the CLI transport and its environment in references", () => {
    expect(providers).toContain("opencode run --format json");
    expect(providers).toContain("`OPENCODE_CLI_PATH`");
    expect(environmentExample).toContain("OPENCODE_CLI_PATH=");

    const cliPathRow = configurationReference
      .split("\n")
      .find((line) => line.includes("| `OPENCODE_CLI_PATH`"));
    expect(cliPathRow).toBeDefined();
    expect(cliPathRow).toContain("| string");
    expect(cliPathRow).toContain("Resolution order");

    const versionRow = configurationReference
      .split("\n")
      .find((line) => line.includes("| `OPENCODE_VERSION`"));
    expect(versionRow).toBeDefined();
    expect(versionRow).toContain(`| \`${reviewedOpenCodeVersion}\``);
    expect(versionRow).toContain("build-time");

    const gettingStartedRow = gettingStarted
      .split("\n")
      .find((line) => line.includes("| `OPENCODE_VERSION`"));
    expect(gettingStartedRow).toContain(`\`${reviewedOpenCodeVersion}\``);
  });
});

function countMatches(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
