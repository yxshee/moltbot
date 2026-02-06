import type { AuthProfileCredential, AuthProfileStore } from "./types.js";
import { normalizeProviderId } from "../model-selection.js";
import {
  ensureAuthProfileStore,
  saveAuthProfileStore,
  updateAuthProfileStoreWithLock,
} from "./store.js";

export async function setAuthProfileOrder(params: {
  agentDir?: string;
  provider: string;
  order?: string[] | null;
}): Promise<AuthProfileStore | null> {
  const providerKey = normalizeProviderId(params.provider);
  const sanitized =
    params.order && Array.isArray(params.order)
      ? params.order.map((entry) => String(entry).trim()).filter(Boolean)
      : [];

  const deduped: string[] = [];
  for (const entry of sanitized) {
    if (!deduped.includes(entry)) {
      deduped.push(entry);
    }
  }

  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    updater: (store) => {
      store.order = store.order ?? {};
      if (deduped.length === 0) {
        if (!store.order[providerKey]) {
          return false;
        }
        delete store.order[providerKey];
        if (Object.keys(store.order).length === 0) {
          store.order = undefined;
        }
        return true;
      }
      store.order[providerKey] = deduped;
      return true;
    },
  });
}

export function upsertAuthProfile(params: {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
}): void {
  const store = ensureAuthProfileStore(params.agentDir);
  store.profiles[params.profileId] = params.credential;
  saveAuthProfileStore(store, params.agentDir);
}

export function listProfilesForProvider(store: AuthProfileStore, provider: string): string[] {
  const providerKey = normalizeProviderId(provider);
  return Object.entries(store.profiles)
    .filter(([, cred]) => normalizeProviderId(cred.provider) === providerKey)
    .map(([id]) => id);
}

/**
 * Remove all auth profiles, order entries, lastGood, and usageStats for a provider.
 * Returns the number of profiles removed (0 = nothing to clean).
 */
export async function removeProfilesForProvider(params: {
  provider: string;
  agentDir?: string;
}): Promise<number> {
  const providerKey = normalizeProviderId(params.provider);
  let removedCount = 0;

  await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    updater: (store) => {
      let changed = false;

      // Remove profile entries matching the provider
      for (const [id, cred] of Object.entries(store.profiles)) {
        if (normalizeProviderId(cred.provider) === providerKey) {
          delete store.profiles[id];
          removedCount++;
          changed = true;
        }
      }

      // Clean order
      if (store.order?.[providerKey]) {
        delete store.order[providerKey];
        if (Object.keys(store.order).length === 0) {
          store.order = undefined;
        }
        changed = true;
      }

      // Clean lastGood
      if (store.lastGood?.[providerKey]) {
        delete store.lastGood[providerKey];
        if (Object.keys(store.lastGood).length === 0) {
          store.lastGood = undefined;
        }
        changed = true;
      }

      // Clean usageStats for profiles that matched this provider
      if (store.usageStats) {
        for (const statsKey of Object.keys(store.usageStats)) {
          if (statsKey.startsWith(`${providerKey}:`)) {
            delete store.usageStats[statsKey];
            changed = true;
          }
        }
        if (Object.keys(store.usageStats).length === 0) {
          store.usageStats = undefined;
        }
      }

      return changed;
    },
  });

  return removedCount;
}

export async function markAuthProfileGood(params: {
  store: AuthProfileStore;
  provider: string;
  profileId: string;
  agentDir?: string;
}): Promise<void> {
  const { store, provider, profileId, agentDir } = params;
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      const profile = freshStore.profiles[profileId];
      if (!profile || profile.provider !== provider) {
        return false;
      }
      freshStore.lastGood = { ...freshStore.lastGood, [provider]: profileId };
      return true;
    },
  });
  if (updated) {
    store.lastGood = updated.lastGood;
    return;
  }
  const profile = store.profiles[profileId];
  if (!profile || profile.provider !== provider) {
    return;
  }
  store.lastGood = { ...store.lastGood, [provider]: profileId };
  saveAuthProfileStore(store, agentDir);
}
