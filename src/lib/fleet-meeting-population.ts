/**
 * The leg's campaigns a FLEET figure is read on (`lib/meeting-population.ts`, MEETING-POPULATION-1018): every one, or,
 * on a leg landing on a meeting step, those of the brands that report meetings. Every fleet reader of a leg's
 * campaigns (leg fleet evidence, the leg workflow ranking and its return curve) goes through it.
 */
import type { FleetLegCampaign } from "./fleet-leg-campaigns.js";
import { legMeasuresMeetings, splitByMeetingReporting, type MeetingPopulation } from "./meeting-population.js";
import { getMeetingReporting } from "./meeting-reporting-client.js";

export async function fleetPopulationCampaigns(
  featureSlug: string,
  legKey: string,
  campaigns: FleetLegCampaign[],
): Promise<{ counted: FleetLegCampaign[]; population: MeetingPopulation | null }> {
  if (!legMeasuresMeetings(featureSlug, legKey)) return { counted: campaigns, population: null };
  return splitByMeetingReporting(campaigns, await getMeetingReporting());
}
