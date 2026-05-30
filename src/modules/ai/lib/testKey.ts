import { invoke } from "@tauri-apps/api/core";
import { type ProviderId } from "../config";
import { getAccountKey } from "./keyring";

// A cheap, auth-required GET endpoint per provider — almost always the
// `/models` listing. We only care whether the credential is accepted, so we
// read the HTTP status, not the body. Routed through the Rust `ai_http_request`
// command (same transport the chat uses) to bypass the webview's CORS / PNA
// restrictions on the tauri:// origin.

export type KeyTestResult =
  | { kind: "ok" }
  | { kind: "unauthorized"; status: number }
  | { kind: "unreachable"; message: string }
  | { kind: "error"; status: number; message: string };

type Probe = {
  url: string;
  headers: Record<string, string>;
};

/** Build the auth probe for a cloud provider. Local providers don't go here. */
function buildProbe(provider: ProviderId, key: string): Probe | null {
  const bearer = { Authorization: `Bearer ${key}` };
  switch (provider) {
    case "openai":
      return { url: "https://api.openai.com/v1/models", headers: bearer };
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/models",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      };
    case "google":
      return {
        // Google keys ride in a query param, not a header.
        url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
        headers: {},
      };
    case "xai":
      return { url: "https://api.x.ai/v1/models", headers: bearer };
    case "cerebras":
      return { url: "https://api.cerebras.ai/v1/models", headers: bearer };
    case "groq":
      return {
        url: "https://api.groq.com/openai/v1/models",
        headers: bearer,
      };
    case "deepseek":
      return { url: "https://api.deepseek.com/models", headers: bearer };
    case "mistral":
      return { url: "https://api.mistral.ai/v1/models", headers: bearer };
    case "openrouter":
      return {
        url: "https://openrouter.ai/api/v1/models",
        headers: bearer,
      };
    default:
      // openai-compatible / lmstudio / mlx / ollama use the local "Test"
      // button (lm_ping) instead — no fixed cloud endpoint.
      return null;
  }
}

type HttpResponse = { status: number };

/** Test a specific stored account key by hitting the provider's models API. */
export async function testProviderKey(
  provider: ProviderId,
  accountId: string,
): Promise<KeyTestResult> {
  const key = (await getAccountKey(provider, accountId))?.trim();
  if (!key) {
    return { kind: "unauthorized", status: 0 };
  }
  const probe = buildProbe(provider, key);
  if (!probe) {
    return {
      kind: "error",
      status: 0,
      message: "No test endpoint for this provider.",
    };
  }

  let resp: HttpResponse;
  try {
    resp = await invoke<HttpResponse>("ai_http_request", {
      url: probe.url,
      method: "GET",
      headers: probe.headers,
      body: null,
      allowPrivateNetwork: false,
    });
  } catch (e) {
    // A rejected invoke means the request never completed (DNS / TLS /
    // connect failure) — the network is the problem, not the key.
    return { kind: "unreachable", message: String(e) };
  }

  const { status } = resp;
  if (status >= 200 && status < 300) return { kind: "ok" };
  if (status === 401 || status === 403) return { kind: "unauthorized", status };
  return {
    kind: "error",
    status,
    message: `HTTP ${status}`,
  };
}
