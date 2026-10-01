import { type HealthRow, NET_CARBS_SWITCHOVER_MS, roundFor, rowInstant, rowTime } from './health.ts';

// Net carbs for one local day, from Apple Health carbs and fiber rows (active rows only).
//
// - Carbs samples before the switchover were entered as net carbs: counted as-is. Fiber samples
//   before it are ignored.
// - From the switchover on, carbs samples are total carbs, and a fiber sample is subtracted only
//   when it has a matching carbs sample: same UTC second and same source app. Cal AI writes all of
//   one food entry's nutrients with the same timestamp. Unmatched fiber is reported and ignored,
//   so an entry with fiber but no carbs can never pull the total down.
// - A day's net carbs never go below 0; if clamped, the day gets a warning.

export interface NetCarbsDay {
  /** Net carbs, when the day has any carbs samples. */
  carbs_g?: number;
  /** Only samples from the switchover on; omitted for days entirely before it. */
  total_carbs_g?: number;
  fiber_g?: number;
  warnings: string[];
  unmatchedFiber: HealthRow[];
}

export function netCarbsForDay(
  carbs: HealthRow[],
  fiber: HealthRow[],
  opts: { dayEntirelyBeforeSwitchover: boolean; describe: (r: HealthRow) => string; switchoverMs?: number },
): NetCarbsDay {
  const switchover = opts.switchoverMs ?? NET_CARBS_SWITCHOVER_MS;
  const sum = (rows: HealthRow[]) => rows.reduce((s, r) => s + (r.value ?? 0), 0);
  const pairKey = (r: HealthRow) => `${rowInstant(r)}|${r.source}`;

  const preCarbs = carbs.filter((r) => rowTime(r) < switchover);
  const postCarbs = carbs.filter((r) => rowTime(r) >= switchover);
  const postFiber = fiber.filter((r) => rowTime(r) >= switchover);
  const carbKeys = new Set(postCarbs.map(pairKey));
  const matched = postFiber.filter((f) => carbKeys.has(pairKey(f)));
  const unmatchedFiber = postFiber.filter((f) => !carbKeys.has(pairKey(f)));

  const out: NetCarbsDay = { warnings: [], unmatchedFiber };
  if (carbs.length) {
    const net = roundFor('carbs', sum(preCarbs) + sum(postCarbs) - sum(matched));
    if (net < 0) {
      out.warnings.push(`Net carbs came out at ${net} g (fiber exceeds carbs); shown as 0.`);
      out.carbs_g = 0;
    } else {
      out.carbs_g = net;
    }
  }
  if (!opts.dayEntirelyBeforeSwitchover && (carbs.length || fiber.length)) {
    out.total_carbs_g = roundFor('carbs', sum(postCarbs));
    out.fiber_g = roundFor('fiber', sum(postFiber));
  }
  if (unmatchedFiber.length) {
    out.warnings.push(
      `Fiber without a matching carbs entry was not subtracted: ${unmatchedFiber.map(opts.describe).join('; ')}.`,
    );
  }
  return out;
}
