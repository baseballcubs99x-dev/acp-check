/**
 * @acp-check/core — validation engine for Agentic Commerce Protocol (ACP)
 * integrations. UI-free and importable as a library; the CLI and the future
 * hosted product both wrap this surface.
 *
 * Every validator traces to the pinned spec snapshot; see `specMeta`.
 */
export * from "./findings.js";
export { specMeta } from "./schemas/validator.js";
export { schemaCheck, getValidator, type SchemaBundle } from "./schemas/validator.js";
export { VERSION, USER_AGENT } from "./version.js";

// Feed
export { validateFeed, FeedInputError, type FeedValidateOptions } from "./feed/validate.js";
export { openFeed, detectFormatFromHead, type FeedFormat, type FeedSource } from "./feed/stream.js";
export { qualityChecks } from "./feed/quality.js";

// Endpoints
export {
  runEndpoints,
  looksLikeTestTarget,
  TEST_PAYMENT_TOKEN,
  type EndpointsOptions,
} from "./endpoints/run.js";
export { AcpClient, type Exchange, type RequestOptions } from "./endpoints/client.js";

// Webhook
export {
  verifySignature,
  parseSignature,
  computeSignature,
  signaturesEqual,
  validateWebhookPayload,
  DEFAULT_TOLERANCE_SECONDS,
  type VerifyResult,
  type VerifyOptions,
  type SignatureParts,
} from "./webhook/verify.js";
export { startReceiver, type WebhookReceiver, type CapturedDelivery, type ReceiverOptions } from "./webhook/receiver.js";

// Report + artifacts
export {
  buildReport,
  scoreRun,
  saveRunArtifact,
  loadRunArtifact,
  ARTIFACT_DIR,
  type ReadinessReport,
  type ReportSection,
} from "./report/aggregate.js";
export { renderMarkdownReport } from "./report/markdown.js";
