/**
 * Flatten a brand-service extracted value to a plain string.
 * Brand-service may return strings, arrays, or objects like { text: "...", confidence: 0.8 }.
 * The dashboard expects flat strings for form inputs.
 */
export function flattenValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string").join(", ");
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Extract .text or .value if present (common brand-service response shapes)
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.value === "string") return obj.value;
    // Last resort: join all string values
    const strings = Object.values(obj).filter((v) => typeof v === "string");
    if (strings.length > 0) return strings.join(", ");
  }
  return String(value);
}
