export const REQUIRED_ENV = [
  "FEATURES_SERVICE_API_KEY",
  "RUNS_SERVICE_URL",
  "RUNS_SERVICE_API_KEY",
  "EMAIL_GATEWAY_SERVICE_URL",
  "EMAIL_GATEWAY_SERVICE_API_KEY",
  "OUTLETS_SERVICE_URL",
  "OUTLETS_SERVICE_API_KEY",
  "WORKFLOW_SERVICE_URL",
  "WORKFLOW_SERVICE_API_KEY",
  "JOURNALISTS_SERVICE_URL",
  "JOURNALISTS_SERVICE_API_KEY",
] as const;

export function validateRequiredEnv(): void {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}
