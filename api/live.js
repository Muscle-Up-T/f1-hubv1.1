// api/live.js
// Proxies OpenF1 API for live race positions
// Called by the app as: fetch('/api/live')
// Returns: { isLive, session, positions, intervals }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store'); // never cache live data
  res.setHeader('Access-Control-Allow-Origin', '*');

  const BASE = 'https://api.openf1.org/v1';

  async function openf1(path) {
    const r = await fetch(`${BASE}${path}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(7000),
    });
    if (!r.ok) throw new Error(`OpenF1 ${path} failed: ${r.status}`);
    return r.json();
  }

  try {
    // 1. Get all sessions for this year
    const sessions = await openf1('/sessions?year=2026');
    const now      = Date.now();

    // 2. Find a currently live session
    let liveSession = null;
    for (const s of sessions) {
      const start = new Date(s.date_start).getTime();
      // A session is "live" if it started and hasn't been more than 4h ago
      if (start <= now && now - start < 4 * 3600 * 1000) {
        liveSession = s;
        break;
      }
    }

    if (!liveSession) {
      return res.status(200).json({ isLive: false });
    }

    const key = liveSession.session_key;

    // 3. Fetch positions + drivers + intervals in parallel
    const [rawPositions, drivers, rawIntervals] = await Promise.allSettled([
      openf1(`/position?session_key=${key}`),
      openf1(`/drivers?session_key=${key}`),
      openf1(`/intervals?session_key=${key}`),
    ]);

    const positions  = rawPositions.status  === 'fulfilled' ? rawPositions.value  : [];
    const driverList = drivers.status       === 'fulfilled' ? drivers.value        : [];
    const intervals  = rawIntervals.status  === 'fulfilled' ? rawIntervals.value   : [];

    // 4. Get latest position per driver
    const latestPos = {};
    for (const p of positions) {
      const dn = p.driver_number;
      if (!latestPos[dn] || new Date(p.date) > new Date(latestPos[dn].date)) {
        latestPos[dn] = p;
      }
    }

    // 5. Get latest interval (gap to leader) per driver
    const latestInterval = {};
    for (const iv of intervals) {
      const dn = iv.driver_number;
      if (!latestInterval[dn] || new Date(iv.date) > new Date(latestInterval[dn].date)) {
        latestInterval[dn] = iv;
      }
    }

    // 6. Build driver map
    const driverMap = {};
    for (const d of driverList) {
      driverMap[d.driver_number] = d;
    }

    // 7. Assemble final standings
    const standings = Object.values(latestPos)
      .sort((a, b) => a.position - b.position)
      .map(p => {
        const d   = driverMap[p.driver_number] || {};
        const iv  = latestInterval[p.driver_number];
        let gap   = null;
        if (iv) {
          gap = p.position === 1
            ? 'LEADER'
            : iv.gap_to_leader != null
              ? `+${Number(iv.gap_to_leader).toFixed(3)}s`
              : iv.interval != null
                ? `+${Number(iv.interval).toFixed(3)}s`
                : null;
        }
        return {
          position:     p.position,
          driverNumber: p.driver_number,
          name:         d.full_name        || d.name_acronym || `#${p.driver_number}`,
          short:        d.name_acronym     || `D${p.driver_number}`,
          team:         d.team_name        || 'Unknown',
          countryCode:  d.country_code     || '',
          gap,
        };
      });

    // 8. Get current lap number from latest lap data
    let lapNumber = 0;
    try {
      const laps = await openf1(`/laps?session_key=${key}&driver_number=${standings[0]?.driverNumber || 1}`);
      if (laps?.length) lapNumber = laps[laps.length - 1].lap_number || 0;
    } catch {}

    res.status(200).json({
      isLive:      true,
      sessionKey:  key,
      sessionName: liveSession.session_name,
      location:    liveSession.location,
      lapNumber,
      standings,
      fetchedAt:   now,
    });

  } catch (err) {
    res.status(500).json({ isLive: false, error: err.message });
  }
}
