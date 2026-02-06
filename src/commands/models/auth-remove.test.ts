import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import { removeProviderFromConfig } from "./auth-remove.js";

const mockProvider = (overrides?: Partial<ModelProviderConfig>) =>
  ({ baseUrl: "https://example.com", models: [], ...overrides }) as ModelProviderConfig;

describe("removeProviderFromConfig", () => {
  it("removes provider from models.providers", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openrouter: mockProvider({ baseUrl: "https://openrouter.ai/api/v1" }),
          anthropic: mockProvider(),
        },
      },
    };
    const next = removeProviderFromConfig(cfg, "openrouter");
    expect(next.models?.providers?.openrouter).toBeUndefined();
    expect(next.models?.providers?.anthropic).toBeDefined();
  });

  it("cleans up models.providers when last provider removed", () => {
    const cfg: OpenClawConfig = {
      models: { providers: { openrouter: mockProvider() } },
    };
    const next = removeProviderFromConfig(cfg, "openrouter");
    expect(next.models?.providers).toBeUndefined();
  });

  it("cleans up models object when empty", () => {
    const cfg: OpenClawConfig = {
      models: { providers: { openrouter: mockProvider() } },
    };
    const next = removeProviderFromConfig(cfg, "openrouter");
    expect(next.models).toBeUndefined();
  });

  it("preserves models.mode when providers are removed", () => {
    const cfg: OpenClawConfig = {
      models: {
        mode: "routing" as OpenClawConfig["models"] extends { mode?: infer M } ? M : never,
        providers: { openrouter: mockProvider() },
      },
    };
    const next = removeProviderFromConfig(cfg, "openrouter");
    expect(next.models?.mode).toBe("routing");
  });

  it("removes matching model refs from agents.defaults.models", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "openrouter/moonshot/kimi-k2": {},
            "openrouter/other-model": {},
            "anthropic/claude-opus-4": {},
          },
        },
      },
    };
    const next = removeProviderFromConfig(cfg, "openrouter");
    const keys = Object.keys(next.agents?.defaults?.models ?? {});
    expect(keys).toEqual(["anthropic/claude-opus-4"]);
  });

  it("clears agents.defaults.models when all refs removed", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "openrouter/model-a": {},
            "openrouter/model-b": {},
          },
        },
      },
    };
    const next = removeProviderFromConfig(cfg, "openrouter");
    expect(next.agents?.defaults?.models).toBeUndefined();
  });

  it("clears primary model if it belongs to the removed provider", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "openrouter/moonshot/kimi-k2",
            fallbacks: ["anthropic/claude-opus-4"],
          },
        },
      },
    };
    const next = removeProviderFromConfig(cfg, "openrouter");
    expect(next.agents?.defaults?.model?.primary).toBeUndefined();
    expect(next.agents?.defaults?.model?.fallbacks).toEqual(["anthropic/claude-opus-4"]);
  });

  it("preserves primary model if it belongs to a different provider", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4" },
          models: {
            "openrouter/some-model": {},
            "anthropic/claude-opus-4": {},
          },
        },
      },
      models: {
        providers: {
          openrouter: mockProvider(),
          anthropic: mockProvider(),
        },
      },
    };
    const next = removeProviderFromConfig(cfg, "openrouter");
    expect(next.agents?.defaults?.model?.primary).toBe("anthropic/claude-opus-4");
    expect(next.models?.providers?.anthropic).toBeDefined();
  });

  it("handles normalised provider ids", () => {
    const cfg: OpenClawConfig = {
      models: { providers: { openrouter: mockProvider() } },
    };
    const next = removeProviderFromConfig(cfg, "OpenRouter");
    expect(next.models?.providers?.openrouter).toBeUndefined();
  });

  it("is a no-op when provider is not configured", () => {
    const cfg: OpenClawConfig = {
      models: { providers: { anthropic: mockProvider() } },
    };
    const next = removeProviderFromConfig(cfg, "openrouter");
    expect(next.models?.providers?.anthropic).toBeDefined();
  });

  it("does not mutate the original config object", () => {
    const cfg: OpenClawConfig = {
      models: { providers: { openrouter: mockProvider() } },
      agents: {
        defaults: {
          models: { "openrouter/model": {} },
          model: { primary: "openrouter/model" },
        },
      },
    };
    const original = JSON.parse(JSON.stringify(cfg));
    removeProviderFromConfig(cfg, "openrouter");
    expect(cfg).toEqual(original);
  });
});

describe("removeProfilesForProvider", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
  const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousAgentDir === undefined) {
      delete process.env.OPENCLAW_AGENT_DIR;
    } else {
      process.env.OPENCLAW_AGENT_DIR = previousAgentDir;
    }
    if (previousPiAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
    }
  });

  it("removes profiles matching the provider and returns count", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-remove-"));
    const agentDir = path.join(tempDir, "agent");
    await fs.mkdir(agentDir, { recursive: true });
    process.env.OPENCLAW_STATE_DIR = tempDir;
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    // Seed an auth-profiles.json with two providers
    const store = {
      profiles: {
        "openrouter:default": { type: "api_key", provider: "openrouter", key: "sk-or-xxx" },
        "openrouter:backup": { type: "api_key", provider: "openrouter", key: "sk-or-yyy" },
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-ant-xxx" },
      },
      order: {
        openrouter: ["openrouter:default", "openrouter:backup"],
        anthropic: ["anthropic:default"],
      },
      lastGood: {
        openrouter: "openrouter:default",
        anthropic: "anthropic:default",
      },
    };
    await fs.writeFile(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify(store, null, 2),
      "utf8",
    );

    const { removeProfilesForProvider } = await import("../../agents/auth-profiles/profiles.js");

    const count = await removeProfilesForProvider({
      provider: "openrouter",
      agentDir,
    });

    expect(count).toBe(2);

    // Verify remaining store
    const raw = await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8");
    const updated = JSON.parse(raw) as typeof store;
    expect(updated.profiles["anthropic:default"]).toBeDefined();
    expect(updated.profiles["openrouter:default"]).toBeUndefined();
    expect(updated.profiles["openrouter:backup"]).toBeUndefined();
    expect(updated.order?.openrouter).toBeUndefined();
    expect(updated.order?.anthropic).toBeDefined();
    expect(updated.lastGood?.openrouter).toBeUndefined();
    expect(updated.lastGood?.anthropic).toBeDefined();
  });

  it("returns 0 when provider has no profiles", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-remove-"));
    const agentDir = path.join(tempDir, "agent");
    await fs.mkdir(agentDir, { recursive: true });
    process.env.OPENCLAW_STATE_DIR = tempDir;
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    // Seed empty store
    const store = { profiles: {}, order: {}, lastGood: {} };
    await fs.writeFile(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify(store, null, 2),
      "utf8",
    );

    const { removeProfilesForProvider } = await import("../../agents/auth-profiles/profiles.js");

    const count = await removeProfilesForProvider({
      provider: "openrouter",
      agentDir,
    });

    expect(count).toBe(0);
  });
});
