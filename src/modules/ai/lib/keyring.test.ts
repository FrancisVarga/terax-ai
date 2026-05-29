import { describe, expect, it } from "vitest";
import type { AccountRegistry } from "@/modules/settings/store";
import { accountsForProvider, activeAccountId } from "./keyring";

function reg(
  accounts: AccountRegistry["accounts"],
  activeByProvider: AccountRegistry["activeByProvider"] = {},
): AccountRegistry {
  return { accounts, activeByProvider };
}

const mk = (id: string, provider: string, label = id) => ({
  id,
  provider,
  label,
  kind: "api-key" as const,
  createdAt: 0,
});

describe("accountsForProvider", () => {
  it("filters by provider", () => {
    const r = reg([mk("a", "anthropic"), mk("b", "openai"), mk("c", "anthropic")]);
    expect(accountsForProvider(r, "anthropic").map((a) => a.id)).toEqual([
      "a",
      "c",
    ]);
    expect(accountsForProvider(r, "openai").map((a) => a.id)).toEqual(["b"]);
    expect(accountsForProvider(r, "google")).toEqual([]);
  });
});

describe("activeAccountId", () => {
  it("returns the explicit active id when valid", () => {
    const r = reg([mk("a", "anthropic"), mk("b", "anthropic")], {
      anthropic: "b",
    });
    expect(activeAccountId(r, "anthropic")).toBe("b");
  });

  it("falls back to the first account when active is stale", () => {
    const r = reg([mk("a", "anthropic"), mk("b", "anthropic")], {
      anthropic: "ghost",
    });
    expect(activeAccountId(r, "anthropic")).toBe("a");
  });

  it("falls back to the first account when active is unset", () => {
    const r = reg([mk("a", "anthropic")]);
    expect(activeAccountId(r, "anthropic")).toBe("a");
  });

  it("returns null when the provider has no accounts", () => {
    const r = reg([mk("a", "openai")], { anthropic: "a" });
    expect(activeAccountId(r, "anthropic")).toBeNull();
  });
});
