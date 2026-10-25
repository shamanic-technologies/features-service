/** How the Research page prints a figure (LIVE-RESEARCH-1018): every string is written here, the page divides nothing. */

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const n = (v: number): string => Number(v).toLocaleString("en-US");
/** "a" or "an" before a noun: "an interested lead", "a booked meeting". */
export const aOrAn = (noun: string): string => `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
export const usd = (v: number): string => (Math.abs(v) < 10 ? `$${v.toFixed(2)}` : `$${Math.round(v).toLocaleString("en-US")}`);
/** `YYYY-MM` → "Sep". */
export const monthLabel = (ym: string): string => MONTHS[Number(ym.slice(5, 7)) - 1] ?? ym;
/** `YYYY-MM-DD` → "Sep 27". */
export const dayText = (ymd: string): string => `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${Number(ymd.slice(8, 10))}`;
/** A percent, two decimals: 0.0018 as a fraction is "0.18%". */
export const pctText = (pct: number): string => `${pct.toFixed(2)}%`;

/**
 * A template id in words, the version kept since two versions of one template are different prompts:
 * `cold-email-v35` → "Cold email v35", `blind-discovery-email-v26` → "Blind discovery v26".
 */
export function templateLabel(id: string): string {
  const m = /^(.*?)(?:-v(\d+))?(-landing)?$/.exec(id);
  const raw = m?.[1] || id;
  const base = raw.replace(/^blind-discovery-email$/, "blind-discovery").replace(/-/g, " ");
  const words = base.charAt(0).toUpperCase() + base.slice(1);
  return `${words}${m?.[2] ? ` v${m[2]}` : ""}${m?.[3] ? " (landing)" : ""}`;
}

const VENDOR_WORDS: Record<string, string> = { gemini: "Gemini", glm: "GLM", deepseek: "DeepSeek", claude: "Claude", gpt: "GPT", qwen: "Qwen", kimi: "Kimi", grok: "Grok" };

/**
 * A model id as the generation record stores it, in words, by one rule (never a per-model table):
 * `gemini-3.5-flash-lite` → "Gemini 3.5 Flash-Lite", `gemini-3.1-pro-preview` → "Gemini 3.1 Pro",
 * `claude-sonnet-5-5` → "Claude Sonnet 5.5", `gpt-6-astra` → "GPT-6 Astra". The vendor's channel words
 * (`preview`, `latest`) are dropped; a tier word stays as written.
 */
export function modelLabel(id: string): string {
  const parts = id.toLowerCase().split("-").filter((p) => p && p !== "preview" && p !== "latest" && p !== "exp");
  if (!parts.length) return id;
  const [vendor, ...rest] = parts;
  const head = VENDOR_WORDS[vendor!] ?? vendor!.charAt(0).toUpperCase() + vendor!.slice(1);
  const words: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const p = rest[i]!;
    // "5-5" (Claude's version spelling) reads 5.5
    if (/^\d+$/.test(p) && words.length > 0 && /^\d+(\.\d+)?$/.test(words[words.length - 1]!) && !words[words.length - 1]!.includes(".")) {
      words[words.length - 1] = `${words[words.length - 1]}.${p}`;
      continue;
    }
    if (p === "lite" && words.length > 0) {
      words[words.length - 1] = `${words[words.length - 1]}-Lite`;
      continue;
    }
    words.push(/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1));
  }
  // "GPT-6": a vendor whose number is glued with a dash
  if (head === "GPT" && words.length && /^\d/.test(words[0]!)) return [`GPT-${words[0]}`, ...words.slice(1)].join(" ");
  return [head, ...words].join(" ");
}

/** A model bar's key: its label as a slug ("gemini-3.5-flash-lite"). */
export const modelKey = (label: string): string => label.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
