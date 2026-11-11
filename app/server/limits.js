// A runtime at its usage limit is not a failure: the work waits until the limit lifts and carries on by itself.
// Claude Code says it as "5-hour limit · resets 7:10am PT" or "usage limit reached … resets 3pm (Europe/Berlin)";
// other runtimes as rate limits, quotas or HTTP 429/529.

export const LIMIT_RE = /usage limit|rate[ _-]?limit|limit reached|hit your limit|\b\d+[- ]hour limit|weekly limit|session limit|out of (extra )?usage|quota|overloaded|too many requests|\b(429|529)\b/i;

const ZONES = { PT: 'America/Los_Angeles', PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles', MT: 'America/Denver', CT: 'America/Chicago', ET: 'America/New_York', EST: 'America/New_York', EDT: 'America/New_York', UTC: 'UTC', GMT: 'UTC', CET: 'Europe/Berlin', CST: 'Asia/Shanghai', JST: 'Asia/Tokyo' };

/** How far `zone`'s wall clock is ahead of UTC at instant `ms`. */
function offset(zone, ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second) - Math.floor(ms / 1000) * 1000;
}

/** Whether the message says the runtime is at a usage limit. */
export function isLimit(message) {
  return LIMIT_RE.test(String(message || ''));
}

/**
 * When the limit lifts, read from "resets 7:10am PT", "resets at 15:00 (Europe/Berlin)" and the like:
 * the next such moment after `at`, in ms. 0 when the message does not say.
 */
export function limitReset(message, at = Date.now()) {
  // The older form carries the moment itself: "Claude AI usage limit reached|1762920000".
  const epoch = /limit reached\|(\d{10})\b/i.exec(String(message || ''));
  if (epoch && Number(epoch[1]) * 1000 > at) return Number(epoch[1]) * 1000;
  const m = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\s*(?:\(\s*([A-Za-z_]+\/[A-Za-z_\/+-]+|[A-Z]{2,4})\s*\)|([A-Z]{2,4})\b|([A-Za-z_]+\/[A-Za-z_\/+-]+))?/i.exec(String(message || ''));
  if (!m) return 0;
  let hour = Number(m[1]);
  const minute = Number(m[2] || 0);
  const ampm = (m[3] || '').toLowerCase().replace(/\./g, '');
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return 0;
  const name = m[4] || m[5] || m[6] || '';
  let zone = ZONES[name.toUpperCase()] || (name.includes('/') ? name : '');
  try {
    if (zone) new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    zone = '';
  }
  zone ||= Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  // Today's date over there, then the first of today / tomorrow / the day after at that wall time that is still ahead.
  const here = new Date(at + offset(zone, at));
  for (let day = 0; day < 3; day++) {
    const wall = Date.UTC(here.getUTCFullYear(), here.getUTCMonth(), here.getUTCDate() + day, hour, minute);
    let ms = wall - offset(zone, wall);
    ms = wall - offset(zone, ms); // once more, for a wall time just across a daylight-saving change
    if (ms > at) return ms;
  }
  return 0;
}
