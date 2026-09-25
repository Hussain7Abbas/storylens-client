export type ProviderName = "claude" | "codex";
export type ResponseLanguage = "en" | "ar";
export type ModelOption = {
  id: string;
  provider: ProviderName;
  providerModel: string;
  label: string;
  efforts: string[];
  defaultEffort: string;
  aliases: string[];
};
export type CapabilityStatus = { provider: ProviderName; available: boolean; error?: string };
export type Capabilities = {
  protocolVersion: 2;
  models: ModelOption[];
  providers: CapabilityStatus[];
  limits: { promptBytes: number; outputBytes: number; timeoutMs: number; concurrent: number };
};
export type ExecuteInput = { prompt: string; model: string; effort: string; responseLanguage: ResponseLanguage };
export type ExecuteOutput = {
  requestId: string;
  output: string;
  model: string;
  provider: ProviderName;
  effort: string;
  responseLanguage: ResponseLanguage;
  durationMs: number;
};
export class ClientError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 502) {
    super(message);
  }
}
