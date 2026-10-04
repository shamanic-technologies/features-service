/**
 * HOW AN OFFER SELLS, AS THE CUSTOMER TICKED IT — brand-service `GET /internal/offers/:offerId/sales-path`
 * (service auth, keyed on the offer alone). Conforms to what brand-service deploys: `{offerId, stated,
 * steps, legKeys, statedAt}`, with `stated: false` (both lists null) = never stated. Keys are our own
 * step and leg keys, stored as given. Fails loud: an unreadable selection is never read as "nothing ticked".
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { SalesFunnelsUnavailableError } from "./sales-funnels-client.js";

export interface OfferSalesPathSelection {
  offerId: string;
  stated: boolean;
  steps: string[] | null;
  legKeys: string[] | null;
  statedAt: string | null;
}

export class OfferSalesPathNotFoundError extends Error {
  constructor(public readonly offerId: string) {
    super(`offer ${offerId} not found`);
    this.name = "OfferSalesPathNotFoundError";
  }
}

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : null;

export async function fetchOfferSalesPath(offerId: string): Promise<OfferSalesPathSelection> {
  const url = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !apiKey) throw new SalesFunnelsUnavailableError("BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not configured");
  let response: Response;
  try {
    response = await fetchWithRetry(`${url}/internal/offers/${encodeURIComponent(offerId)}/sales-path`, {
      headers: { "x-api-key": apiKey },
    });
  } catch (error) {
    throw new SalesFunnelsUnavailableError(`brand-service offer sales-path read failed: ${(error as Error).message}`);
  }
  if (response.status === 404 || response.status === 400) throw new OfferSalesPathNotFoundError(offerId);
  if (!response.ok) {
    throw new SalesFunnelsUnavailableError(`brand-service offer sales-path read failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as Record<string, unknown>;
  if (typeof data.stated !== "boolean") {
    throw new SalesFunnelsUnavailableError("brand-service offer sales-path response carried no `stated` flag");
  }
  return {
    offerId,
    stated: data.stated,
    steps: strings(data.steps),
    legKeys: strings(data.legKeys),
    statedAt: typeof data.statedAt === "string" ? data.statedAt : null,
  };
}

/** The channels an offer accepts, as the customer stated them (brand-service `GET /internal/offers/:offerId/channels`). */
export interface OfferChannelsSelection {
  offerId: string;
  /** False = never stated (`channelSlugs` null), distinct from an empty stated list. */
  stated: boolean;
  channelSlugs: string[] | null;
}

/** Fails loud like the sales-path read: an unreadable channel list is never read as "never stated". */
export async function fetchOfferChannels(offerId: string): Promise<OfferChannelsSelection> {
  const url = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !apiKey) throw new SalesFunnelsUnavailableError("BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not configured");
  let response: Response;
  try {
    response = await fetchWithRetry(`${url}/internal/offers/${encodeURIComponent(offerId)}/channels`, {
      headers: { "x-api-key": apiKey },
    });
  } catch (error) {
    throw new SalesFunnelsUnavailableError(`brand-service offer channels read failed: ${(error as Error).message}`);
  }
  if (response.status === 404 || response.status === 400) throw new OfferSalesPathNotFoundError(offerId);
  if (!response.ok) {
    throw new SalesFunnelsUnavailableError(`brand-service offer channels read failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as Record<string, unknown>;
  if (typeof data.stated !== "boolean") {
    throw new SalesFunnelsUnavailableError("brand-service offer channels response carried no `stated` flag");
  }
  return { offerId, stated: data.stated, channelSlugs: strings(data.channelSlugs) };
}
