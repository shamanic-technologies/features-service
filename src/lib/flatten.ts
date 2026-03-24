/**
 * Convert a camelCase or snake_case key to a human-readable label.
 * e.g. "userCount" → "User Count", "total_revenue" → "Total Revenue"
 */
export function humanizeKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Recursively flatten any value to a plain string.
 * Handles brand-service response shapes:
 *   - strings → pass through
 *   - arrays → recursively flatten each element, join with ". "
 *   - { elements: [...] } → flatten the elements array
 *   - { text: "..." } or { value: "..." } → extract the string
 *   - objects with mixed keys → "Key: value. Key: value" for context
 */
export function flattenValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(flattenValue).filter((v): v is string => v !== null);
    return parts.length > 0 ? parts.join(". ") : null;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Common wrapper: { elements: [...] }
    if (Array.isArray(obj.elements)) return flattenValue(obj.elements);
    // Direct string fields
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.value === "string") return obj.value;
    // Single-key object → don't prefix, just return the value
    const entries = Object.entries(obj);
    if (entries.length === 1) {
      return flattenValue(entries[0][1]);
    }
    // Multi-key object → prefix each value with its humanized key for context
    const parts: string[] = [];
    for (const [key, val] of entries) {
      const flat = flattenValue(val);
      if (flat !== null) {
        parts.push(`${humanizeKey(key)}: ${flat}`);
      }
    }
    return parts.length > 0 ? parts.join(". ") : null;
  }
  return String(value);
}
