import { confirm as clackConfirm } from "@clack/prompts";
import type { RuntimeEnv } from "../../runtime.js";
import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  listProfilesForProvider,
  removeProfilesForProvider,
} from "../../agents/auth-profiles/profiles.js";
import { ensureAuthProfileStore } from "../../agents/auth-profiles/store.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { readConfigFileSnapshot, type OpenClawConfig } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import { CONFIG_PATH } from "../../config/paths.js";
import { note } from "../../terminal/note.js";
import { stylePromptMessage } from "../../terminal/prompt-style.js";
import { shortenHomePath } from "../../utils.js";
import { updateConfig } from "./shared.js";

const confirm = (params: Parameters<typeof clackConfirm>[0]) =>
  clackConfirm({
    ...params,
    message: stylePromptMessage(params.message),
  });

// ---------------------------------------------------------------------------
// Pure config mutator
// ---------------------------------------------------------------------------

/**
 * Remove a provider's configuration from the config object:
 * - Deletes `models.providers[providerId]`
 * - Removes model refs from `agents.defaults.models` whose key starts with `providerId/`
 * - Clears `agents.defaults.model.primary` if it starts with the removed provider prefix
 * Cleans up empty parent objects.
 */
export function removeProviderFromConfig(cfg: OpenClawConfig, providerId: string): OpenClawConfig {
  const providerKey = normalizeProviderId(providerId);
  let next = { ...cfg };

  // 1. Remove from models.providers
  if (next.models?.providers?.[providerKey]) {
    const providers = { ...next.models.providers };
    delete providers[providerKey];
    next = {
      ...next,
      models: {
        ...next.models,
        providers: Object.keys(providers).length > 0 ? providers : undefined,
      },
    };
    // Clean up empty models object
    if (
      next.models &&
      !next.models.providers &&
      !next.models.mode &&
      !next.models.bedrockDiscovery
    ) {
      next = { ...next, models: undefined };
    }
  }

  // 2. Remove matching model refs from agents.defaults.models
  const models = next.agents?.defaults?.models;
  if (models) {
    const prefix = `${providerKey}/`;
    const nextModels = { ...models };
    let changed = false;
    for (const key of Object.keys(nextModels)) {
      if (key === providerKey || key.startsWith(prefix)) {
        delete nextModels[key];
        changed = true;
      }
    }
    if (changed) {
      next = {
        ...next,
        agents: {
          ...next.agents,
          defaults: {
            ...next.agents?.defaults,
            models: Object.keys(nextModels).length > 0 ? nextModels : undefined,
          },
        },
      };
    }
  }

  // 3. Clear primary model if it references the removed provider
  const primary = next.agents?.defaults?.model?.primary;
  if (primary) {
    const prefix = `${providerKey}/`;
    if (primary === providerKey || primary.startsWith(prefix)) {
      const model = { ...next.agents?.defaults?.model };
      delete model.primary;
      const hasFields = Object.keys(model).length > 0;
      next = {
        ...next,
        agents: {
          ...next.agents,
          defaults: {
            ...next.agents?.defaults,
            model: hasFields ? model : undefined,
          },
        },
      };
    }
  }

  return next;
}

// ---------------------------------------------------------------------------
// CLI command handler
// ---------------------------------------------------------------------------

export type ModelsAuthRemoveOptions = {
  provider: string;
  yes?: boolean;
};

export async function modelsAuthRemoveCommand(
  opts: ModelsAuthRemoveOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const providerKey = normalizeProviderId(opts.provider);

  // Check current state
  const snapshot = await readConfigFileSnapshot();
  const cfg = snapshot.valid ? snapshot.config : ({} as OpenClawConfig);

  const hasProviderConfig = Boolean(cfg.models?.providers?.[providerKey]);
  const hasModelRefs =
    cfg.agents?.defaults?.models &&
    Object.keys(cfg.agents.defaults.models).some(
      (key) => key === providerKey || key.startsWith(`${providerKey}/`),
    );

  const agentId = resolveDefaultAgentId(cfg);
  const agentDir = resolveAgentDir(cfg, agentId);
  let hasAuthProfiles = false;
  try {
    const store = ensureAuthProfileStore(agentDir);
    hasAuthProfiles = listProfilesForProvider(store, providerKey).length > 0;
  } catch {
    // No auth store file — nothing to clean
  }

  if (!hasProviderConfig && !hasModelRefs && !hasAuthProfiles) {
    note(`Provider "${providerKey}" is not configured. Nothing to remove.`, "Remove provider");
    return;
  }

  // Confirmation
  if (!opts.yes) {
    const ok = await confirm({
      message: `Remove ${providerKey} configuration and credentials from ${shortenHomePath(CONFIG_PATH)}?`,
      initialValue: false,
    });
    if (ok !== true) {
      note("Cancelled.", "Remove provider");
      return;
    }
  }

  // Apply config changes
  const parts: string[] = [];

  if (hasProviderConfig || hasModelRefs) {
    await updateConfig((c) => removeProviderFromConfig(c, providerKey));
    parts.push("config entries removed");
  }

  if (hasAuthProfiles) {
    const count = await removeProfilesForProvider({
      provider: providerKey,
      agentDir,
    });
    parts.push(`${count} auth profile${count === 1 ? "" : "s"} removed`);
  }

  note(`${providerKey}: ${parts.join(", ")}.`, "Provider removed");
  logConfigUpdated(runtime);
}
