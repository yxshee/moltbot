import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  listProfilesForProvider,
  removeProfilesForProvider,
} from "../agents/auth-profiles/profiles.js";
import { ensureAuthProfileStore } from "../agents/auth-profiles/store.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { CONFIG_PATH } from "../config/paths.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";
import { confirm, select } from "./configure.shared.js";
import { removeProviderFromConfig } from "./models/auth-remove.js";
import { guardCancel } from "./onboard-helpers.js";

/**
 * Interactive wizard to remove a provider's config + auth profiles.
 * Modelled on `removeChannelConfigWizard` in `configure.channels.ts`.
 */
export async function removeProviderConfigWizard(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
): Promise<OpenClawConfig> {
  let next = { ...cfg };

  const listConfiguredProviders = (): string[] => {
    const providers = next.models?.providers;
    return providers ? Object.keys(providers) : [];
  };

  while (true) {
    const configured = listConfiguredProviders();
    if (configured.length === 0) {
      note("No provider config found in openclaw.json.", "Remove provider");
      return next;
    }

    const choice = guardCancel(
      await select({
        message: "Remove which provider?",
        options: [
          ...configured.map((id) => ({
            value: id,
            label: id,
            hint: "Removes config + auth credentials",
          })),
          { value: "done", label: "Done" },
        ],
      }),
      runtime,
    );

    if (choice === "done") {
      return next;
    }

    const providerKey = normalizeProviderId(choice);
    const confirmed = guardCancel(
      await confirm({
        message: `Delete ${providerKey} configuration and credentials from ${shortenHomePath(CONFIG_PATH)}?`,
        initialValue: false,
      }),
      runtime,
    );
    if (!confirmed) {
      continue;
    }

    // Remove from config
    next = removeProviderFromConfig(next, providerKey);

    // Remove auth profiles
    let profileCount = 0;
    try {
      const agentId = resolveDefaultAgentId(next);
      const agentDir = resolveAgentDir(next, agentId);
      const store = ensureAuthProfileStore(agentDir);
      if (listProfilesForProvider(store, providerKey).length > 0) {
        profileCount = await removeProfilesForProvider({
          provider: providerKey,
          agentDir,
        });
      }
    } catch {
      // No auth store file — nothing to clean
    }

    const parts = ["config removed"];
    if (profileCount > 0) {
      parts.push(`${profileCount} auth profile${profileCount === 1 ? "" : "s"} removed`);
    }
    note(`${providerKey}: ${parts.join(", ")}.`, "Provider removed");
  }
}
