import { invoke } from "@tauri-apps/api/core";
import {
  loadAccountRegistry,
  saveAccountRegistry,
  type AccountRegistry,
  type ProviderAccount,
} from "@/modules/settings/store";
import {
  getProvider,
  KEYRING_SERVICE,
  PROVIDERS,
  providerSupportsKey,
  type ProviderId,
} from "../config";

export type ProviderKeys = Record<ProviderId, string | null>;

export const EMPTY_PROVIDER_KEYS: ProviderKeys = {
  openai: null,
  anthropic: null,
  google: null,
  xai: null,
  cerebras: null,
  groq: null,
  deepseek: null,
  mistral: null,
  openrouter: null,
  "openai-compatible": null,
  lmstudio: null,
  mlx: null,
  ollama: null,
};

// ── Keyring slot naming ─────────────────────────────────────────────────────
// The Rust `secrets` backend keys on (service, account). Single-account terax
// used the bare provider slot (e.g. "anthropic-api-key"); multi-account suffixes
// it with the account uuid: "anthropic-api-key::<uuid>". The bare slot is the
// "legacy" slot we migrate from (and keep as a rollback net for one release).

function legacySlot(provider: ProviderId): string {
  return getProvider(provider).keyringAccount;
}

function accountSlot(provider: ProviderId, accountId: string): string {
  return `${getProvider(provider).keyringAccount}::${accountId}`;
}

async function rawGet(slot: string): Promise<string | null> {
  if (!slot) return null;
  try {
    const v = await invoke<string | null>("secrets_get", {
      service: KEYRING_SERVICE,
      account: slot,
    });
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

async function rawSet(slot: string, key: string): Promise<void> {
  await invoke("secrets_set", {
    service: KEYRING_SERVICE,
    account: slot,
    password: key,
  });
}

async function rawDelete(slot: string): Promise<void> {
  if (!slot) return;
  try {
    await invoke("secrets_delete", {
      service: KEYRING_SERVICE,
      account: slot,
    });
  } catch {
    // already absent — fine
  }
}

// ── Migration ───────────────────────────────────────────────────────────────
// On first multi-account launch a provider may have a legacy single-key slot
// but no accounts. Mint a "Default" account, copy the secret into its slot, and
// mark it active. Idempotent: once an account exists for a provider we skip it.
// The registry mutation (if any) is persisted by the caller's save.

async function migrateLegacyKeys(registry: AccountRegistry): Promise<boolean> {
  let changed = false;
  for (const p of PROVIDERS) {
    if (!providerSupportsKey(p.id)) continue;
    const slot = legacySlot(p.id);
    if (!slot) continue; // keyless providers have empty keyringAccount
    const hasAccount = registry.accounts.some((a) => a.provider === p.id);
    if (hasAccount) continue;
    const legacy = await rawGet(slot);
    if (!legacy) continue;
    const account: ProviderAccount = {
      id: crypto.randomUUID(),
      provider: p.id,
      label: "Default",
      kind: "api-key",
      createdAt: Date.now(),
    };
    await rawSet(accountSlot(p.id, account.id), legacy);
    registry.accounts.push(account);
    registry.activeByProvider[p.id] = account.id;
    changed = true;
  }
  return changed;
}

// ── Account-aware registry helpers ──────────────────────────────────────────

export function accountsForProvider(
  registry: AccountRegistry,
  provider: ProviderId,
): ProviderAccount[] {
  return registry.accounts.filter((a) => a.provider === provider);
}

export function activeAccountId(
  registry: AccountRegistry,
  provider: ProviderId,
): string | null {
  const explicit = registry.activeByProvider[provider];
  if (
    explicit &&
    registry.accounts.some((a) => a.id === explicit && a.provider === provider)
  ) {
    return explicit;
  }
  // Fall back to the first account for the provider if active is stale/unset.
  const first = registry.accounts.find((a) => a.provider === provider);
  return first?.id ?? null;
}

/** Load the registry, running legacy migration if needed. */
export async function getRegistry(): Promise<AccountRegistry> {
  const registry = await loadAccountRegistry();
  const migrated = await migrateLegacyKeys(registry);
  if (migrated) await saveAccountRegistry(registry);
  return registry;
}

/** Add a new account for a provider, store its key, and make it active. */
export async function addAccount(
  provider: ProviderId,
  label: string,
  key: string,
): Promise<ProviderAccount> {
  if (!providerSupportsKey(provider)) {
    throw new Error(`${provider} does not use an API key`);
  }
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API key is empty");
  const registry = await getRegistry();
  const account: ProviderAccount = {
    id: crypto.randomUUID(),
    provider,
    label: label.trim() || "Account",
    kind: "api-key",
    createdAt: Date.now(),
  };
  await rawSet(accountSlot(provider, account.id), trimmed);
  registry.accounts.push(account);
  registry.activeByProvider[provider] = account.id;
  await saveAccountRegistry(registry);
  return account;
}

/** Replace the stored key for an existing account. */
export async function updateAccountKey(
  provider: ProviderId,
  accountId: string,
  key: string,
): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API key is empty");
  await rawSet(accountSlot(provider, accountId), trimmed);
  // No registry change, but notify listeners the active key may have changed.
  await saveAccountRegistry(await getRegistry());
}

/** Rename an account. */
export async function renameAccount(
  accountId: string,
  label: string,
): Promise<void> {
  const registry = await getRegistry();
  const acc = registry.accounts.find((a) => a.id === accountId);
  if (!acc) return;
  acc.label = label.trim() || acc.label;
  await saveAccountRegistry(registry);
}

/** Set the active account for a provider. */
export async function setActiveAccount(
  provider: ProviderId,
  accountId: string,
): Promise<void> {
  const registry = await getRegistry();
  if (!registry.accounts.some((a) => a.id === accountId)) return;
  registry.activeByProvider[provider] = accountId;
  await saveAccountRegistry(registry);
}

/** Remove an account, delete its key slot, and promote another if it was active. */
export async function removeAccount(
  provider: ProviderId,
  accountId: string,
): Promise<void> {
  const registry = await getRegistry();
  await rawDelete(accountSlot(provider, accountId));
  registry.accounts = registry.accounts.filter((a) => a.id !== accountId);
  if (registry.activeByProvider[provider] === accountId) {
    const next = registry.accounts.find((a) => a.provider === provider);
    if (next) registry.activeByProvider[provider] = next.id;
    else delete registry.activeByProvider[provider];
  }
  await saveAccountRegistry(registry);
}

// ── Active-key resolution (the boundary) ────────────────────────────────────
// Everything below returns the SAME flat ProviderKeys the rest of the app
// consumes — downstream code (transport, agent, chatStore) is unchanged.

/** The active account's key for a provider, or null. */
export async function getKey(provider: ProviderId): Promise<string | null> {
  if (!providerSupportsKey(provider)) return null;
  const registry = await getRegistry();
  const id = activeAccountId(registry, provider);
  if (!id) return null;
  return rawGet(accountSlot(provider, id));
}

/** A specific account's stored key (not necessarily the active one). */
export async function getAccountKey(
  provider: ProviderId,
  accountId: string,
): Promise<string | null> {
  if (!providerSupportsKey(provider)) return null;
  return rawGet(accountSlot(provider, accountId));
}

/**
 * Resolve the active account's key for every keyed provider into the flat
 * ProviderKeys map. Runs legacy migration on first call. One IPC roundtrip
 * for the batch read.
 */
export async function getAllKeys(): Promise<ProviderKeys> {
  const out = { ...EMPTY_PROVIDER_KEYS };
  const registry = await getRegistry();
  const need = PROVIDERS.filter((p) => providerSupportsKey(p.id));

  const slots: { id: ProviderId; slot: string }[] = [];
  for (const p of need) {
    const accountId = activeAccountId(registry, p.id);
    if (accountId) slots.push({ id: p.id, slot: accountSlot(p.id, accountId) });
  }
  if (slots.length === 0) return out;

  try {
    const results = await invoke<(string | null)[]>("secrets_get_all", {
      service: KEYRING_SERVICE,
      accounts: slots.map((s) => s.slot),
    });
    slots.forEach((s, i) => {
      const v = results[i];
      out[s.id] = v && v.length > 0 ? v : null;
    });
    return out;
  } catch {
    const entries = await Promise.all(
      slots.map(async (s) => [s.id, await rawGet(s.slot)] as const),
    );
    for (const [id, v] of entries) out[id] = v;
    return out;
  }
}

export function hasAnyKey(keys: ProviderKeys): boolean {
  return PROVIDERS.some((p) => providerSupportsKey(p.id) && !!keys[p.id]);
}

// ── Single-account convenience (key-optional local providers) ───────────────
// openai-compatible / openrouter manage exactly one optional key. They use the
// same account registry but never expose a multi-account UI, so these helpers
// upsert/clear a single implicit account for the provider.

/** Set the provider's single key — reuses the active account or creates one. */
export async function setKey(provider: ProviderId, key: string): Promise<void> {
  if (!providerSupportsKey(provider)) {
    throw new Error(`${provider} does not use an API key`);
  }
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API key is empty");
  const registry = await getRegistry();
  const id = activeAccountId(registry, provider);
  if (id) {
    await updateAccountKey(provider, id, trimmed);
    return;
  }
  await addAccount(provider, "Default", trimmed);
}

/** Clear the provider's active key by removing its account. */
export async function clearKey(provider: ProviderId): Promise<void> {
  if (!providerSupportsKey(provider)) return;
  const registry = await getRegistry();
  const id = activeAccountId(registry, provider);
  if (id) await removeAccount(provider, id);
}
