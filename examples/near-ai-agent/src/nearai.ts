/**
 * Minimal NEAR AI Cloud client (OpenAI-compatible): models, chat completions with tool calling,
 * per-response signatures and TEE attestation reports. fetch only; the API key is never logged.
 * Docs: https://docs.near.ai/cloud/quickstart.md
 */
export const DEFAULT_BASE_URL = "https://cloud-api.near.ai/v1";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface ChatResponse {
  id: string;
  model: string;
  choices: Array<{ message: ChatMessage; finish_reason: string }>;
}

export class NearAiClient {
  constructor(
    private readonly apiKey: string,
    readonly baseUrl = DEFAULT_BASE_URL,
    private readonly timeoutMs = 90_000,
  ) {}

  private async call<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: ctrl.signal,
        headers: { "content-type": "application/json", accept: "application/json", ...(auth ? { authorization: `Bearer ${this.apiKey}` } : {}), ...(init.headers ?? {}) },
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`NEAR AI ${path.split("?")[0]} → HTTP ${res.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(t);
    }
  }

  /** Public model list. */
  models(): Promise<{ data: Array<{ id: string; owned_by?: string; is_ready?: boolean; supported_features?: string[] }> }> {
    return this.call("/models", {}, false);
  }

  /** First ready model with tool calling, preferring models NEAR AI hosts itself (TEE-hosted, open weights). */
  async pickModel(preferred?: string): Promise<string> {
    if (preferred) return preferred;
    const { data } = await this.models();
    const tools = data.filter((m) => m.is_ready === true && (m.supported_features ?? []).includes("tools"));
    const own = tools.find((m) => m.owned_by === "nearai");
    const pick = own ?? tools[0];
    if (!pick) throw new Error("No ready NEAR AI model with tool calling was found");
    return pick.id;
  }

  chat(model: string, messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatResponse> {
    // max_tokens caps each answer so a verbose (reasoning) model can't run up cost; decisions are one short JSON line.
    // Qwen3 models think out loud by default; the decision is a short JSON line, so thinking is switched off.
    const extra = /qwen/i.test(model) ? { chat_template_kwargs: { enable_thinking: false } } : {};
    return this.call("/chat/completions", { method: "POST", body: JSON.stringify({ model, messages, tools, tool_choice: "auto", temperature: 0, max_tokens: 1200, ...extra }) });
  }

  /** Signature over a chat completion, produced inside the TEE. */
  signature(chatId: string, model: string): Promise<{ text?: string; signature?: string; signing_address?: string; signing_algo?: string }> {
    return this.call(`/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`);
  }

  /** TEE attestation report for a model; `nonce` binds the report to this request. */
  attestation(model: string, nonceHex: string): Promise<Record<string, unknown>> {
    const q = new URLSearchParams({ model, signing_algo: "ecdsa", nonce: nonceHex });
    return this.call(`/attestation/report?${q}`, { headers: { "x-no-aliasing": "true" } });
  }
}
