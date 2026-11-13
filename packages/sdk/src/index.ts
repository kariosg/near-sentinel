export { NearSentinel, SDK_VERSION } from "./sentinel.js";
export type { NearSentinelOptions, CallOptions, CompareResult } from "./sentinel.js";
export * from "./types.js";
export { SentinelError, SentinelInputError, SentinelUrlRejectedError } from "./errors.js";
export { MetricsCollector, MIN_SAMPLE, type ProviderMetrics } from "./metrics.js";
export { DEFAULT_PROVIDERS, DEFAULT_TX_VALIDITY_PERIOD } from "./networks.js";
export { decideRetry, type RetryEvidence, type PerProviderRetryEvidence } from "./retry.js";
export { diagnoseSubmissionError } from "./diagnostics.js";
export { buildReceiptTree, classifyFound, flattenFailure, outcomeDigest, type RawTxStatusResult } from "./outcome.js";
export { decodeSignedTx, type DecodedSignedTx } from "./signedtx.js";
export { isValidAccountId, isValidCryptoHash, inspectInputSchema, type InspectInput } from "./validation.js";
export { rpcCall, type FetchLike } from "./rpc.js";
export { createGuardedFetch, assertPublicRpcUrl, type GuardOptions } from "./ssrf.js";
export { decideIntent, decodeViewResult, intentInputSchema, INTENT_ID_RE, privateIntentId, intentIdPrivacyWarning, type IntentInput, type IntentCheck, type IntentStatus, type GuardIntent, type IntentProviderAnswer } from "./intent.js";
export {
  assessAllowanceSafety,
  decideSpendAction,
  decideSpendPreflight,
  preflightInputSchema,
  PREFLIGHT_ADVISORY,
  VAULT_RECORD_FEE_YOCTO,
  type AllowanceSafety,
  type PreflightCode,
  type PreflightInput,
  type PreflightSpend,
  type SpendAction,
  type SpendPreflight,
} from "./vault.js";
export { guardedSpend, type GuardedSpendOptions, type GuardedSpendResult, type GuardedSpendLog } from "./spend-guard.js";
export {
  addSpendKeyCommand,
  decideKeyAudit,
  deleteFullAccessKeyCommand,
  gradeKey,
  keyAuditInputSchema,
  keyListAnswer,
  type KeyAudit,
  type KeyAuditInput,
  type KeyAuditStatus,
  type KeyFinding,
  type KeyProviderAnswer,
  type KeyProviderObservation,
  type RawAccessKey,
} from "./keys.js";
export { decideAllowance, isVaultPolicy, vaultInputSchema, type AllowanceCheck, type AllowanceStatus, type VaultInput, type VaultPolicy, type VaultProviderAnswer } from "./vault.js";
export {
  accountKind,
  decideReceiver,
  lookalikeOf,
  MAX_KNOWN_RECEIVERS,
  NO_CONTRACT_CODE_HASH,
  PROVIDERS_DISAGREE_TITLE,
  receiverAnswer,
  receiverCheckInputSchema,
  type LookalikeTechnique,
  type ReceiverCheck,
  type ReceiverCheckInput,
  type ReceiverFinding,
  type ReceiverKind,
  type ReceiverProviderAnswer,
  type ReceiverProviderObservation,
  type ReceiverStatus,
} from "./receiver.js";
