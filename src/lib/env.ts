export const REQUIRED_ENV = [
  "FEATURES_SERVICE_API_KEY",
  "RUNS_SERVICE_URL",
  "RUNS_SERVICE_API_KEY",
  "BILLING_SERVICE_URL",
  "BILLING_SERVICE_API_KEY",
  "EMAIL_GATEWAY_SERVICE_URL",
  "EMAIL_GATEWAY_SERVICE_API_KEY",
  "OUTLETS_SERVICE_URL",
  "OUTLETS_SERVICE_API_KEY",
  "WORKFLOW_SERVICE_URL",
  "WORKFLOW_SERVICE_API_KEY",
  "JOURNALISTS_SERVICE_URL",
  "JOURNALISTS_SERVICE_API_KEY",
  // chat-service owns the model alias → capability tier catalogue a leg-keyed projection reads to say
  // whether the model writing a workflow's emails is right for the leg. Required rather than optional:
  // an absent var would degrade every verdict to "unknowable" silently forever, which is the shape of
  // a feature that looks live and decides nothing.
  "CHAT_SERVICE_URL",
  "CHAT_SERVICE_API_KEY",
] as const;

export function validateRequiredEnv(): void {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}
