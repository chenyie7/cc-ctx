// Public entry point of the pricing subsystem.
//
// The three source tiers are decided by the directory order in cfg:
// user directory > remote cache > bundled snapshot.

import { loadCalendars } from './calendar.js';
import { loadProviders as load, matchRates } from './provider.js';

export function loadProviders(cfg) {
  const calendars = loadCalendars(cfg?.calendarDirs || []);
  return load(cfg?.providerDirs || [], { calendars });
}

/**
 * Model -> rates. An unrecognised model returns null: showing "no price table"
 * is the correct behaviour. Substituting another model's rates is exactly the
 * bug this project set out to fix.
 */
export function resolvePricing(cfg, modelId) {
  const providers = loadProviders(cfg);
  for (const provider of providers) {
    const hit = matchRates(provider, modelId);
    if (!hit) continue;
    return {
      providerId: provider.id,
      currency: provider.currency,
      peak: hit.peak,
      offPeak: hit.offPeak,
      schedule: provider.schedule,
      source: provider.source,
    };
  }
  return null;
}

export { loadCalendars };
export { tierAt, nextTransition, scheduleKey } from './schedule.js';
