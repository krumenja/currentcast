
// ============================================================
// CURRENTCAST — SALTWATER FISHING APP
// Free APIs used:
//   - OpenStreetMap Nominatim        (geocoding / address → lat,lon — no key)
//   - Open-Meteo Forecast API        (weather, wind, barometric pressure — no key)
//   - Open-Meteo Marine API          (sea surface temperature SST — no key)
//   - NOAA CO-OPS                    (tides — no key)
//   - Sunrise/sunset via Open-Meteo  (included in weather — no key)
//   - Lunar phase: calculated mathematically (no API)
//   - Map tiles: ESRI via Leaflet    (no key)
// ============================================================

// ── Sentry: error tracking + API performance monitoring ─────────────────────
// Install: npm install @sentry/react
// Replace YOUR_SENTRY_DSN with the DSN from your Sentry project settings.
// traces_sample_rate: 0.1 = 10% of sessions send performance traces.
//   At hundreds of users this stays comfortably within Sentry's free tier.
//   Raise to 1.0 temporarily when debugging a specific performance issue.
// ─────────────────────────────────────────────────────────────────────────────
import * as Sentry from "@sentry/react";

Sentry.init({
  dsn: "YOUR_SENTRY_DSN", // ← paste your DSN here from sentry.io
  environment: "production",
  release: "currentcast@1.0.0",
  // Performance tracing — wraps API calls with timing spans
  tracesSampleRate: 0.1,
  // Don't send PII — no user IDs, emails, or IP addresses
  sendDefaultPii: false,
  // Extra context sent with every event
  initialScope: {
    tags: { platform: "android-capacitor" },
  },
});

import { useState, useEffect, useRef } from "react";

// ---------- tiny helpers ----------
const fmt = (n, d = 1) => (typeof n === "number" ? n.toFixed(d) : "—");

// Convert "HH:MM" 24-hour string to "H:MM a.m./p.m."
function to12h(t) {
  if (!t || !t.includes(":")) return t || "";
  const [hStr, mStr] = t.split(":");
  let h = parseInt(hStr, 10);
  const period = h < 12 ? "a.m." : "p.m.";
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return h + ":" + mStr + " " + period;
}

// ---------- Lunar phase math ----------
function lunarPhase(date) {
  const knownNew = new Date("2000-01-06T18:14:00Z");
  const synodicMonth = 29.53058867;
  const diff = (date - knownNew) / (1000 * 60 * 60 * 24);
  const phase = ((diff % synodicMonth) + synodicMonth) % synodicMonth;
  const pct = phase / synodicMonth;
  const names = [
    "New Moon","Waxing Crescent","First Quarter","Waxing Gibbous",
    "Full Moon","Waning Gibbous","Last Quarter","Waning Crescent",
  ];
  const icons = ["🌑","🌒","🌓","🌔","🌕","🌖","🌗","🌘"];
  const idx = Math.round(pct * 8) % 8;
  return { phase, pct, name: names[idx], icon: icons[idx] };
}

function lunarPhaseForDay(dateStr) {
  return lunarPhase(new Date(dateStr + "T12:00:00Z"));
}

// ---------- Solunar major/minor period helper ----------
// Returns bonus points based on moon's angular position overhead/underfoot
// Major periods (~2h): moon directly overhead or underfoot — strongest pull
// Minor periods (~1h): moon rising or setting — moderate pull
function solunarBonus(hour, moonPct) {
  // Approximate moon's peak overhead hour from phase
  // New moon overhead at solar noon (~12), full moon overhead at midnight (~0/24)
  const moonNoonHour = (12 - moonPct * 24 + 24) % 24;
  const moonMidHour  = (moonNoonHour + 12) % 24;
  const moonRiseHour = (moonNoonHour - 6 + 24) % 24;
  const moonSetHour  = (moonNoonHour + 6) % 24;

  const angularDist = (a, b) => {
    const d = Math.abs(a - b);
    return d > 12 ? 24 - d : d;
  };

  const majorDist = Math.min(angularDist(hour, moonNoonHour), angularDist(hour, moonMidHour));
  const minorDist = Math.min(angularDist(hour, moonRiseHour), angularDist(hour, moonSetHour));

  if (majorDist <= 1) return 12;      // within 1hr of major period
  if (majorDist <= 2) return 7;       // within 2hr of major period
  if (minorDist <= 0.5) return 6;     // within 30min of minor period
  if (minorDist <= 1) return 3;       // within 1hr of minor period
  return 0;
}

// ---------- Fishing score ----------
// Parameters:
//   moonPct       0.0–1.0 position in lunar cycle (0 = new, 0.5 = full)
//   baroHpa       current barometric pressure in hPa
//   baroTrend     pressure change over last 3hrs in hPa (positive = rising)
//   windMph       wind speed in mph
//   tideDir       "incoming" | "outgoing" | "unknown"
//   hour          0–23 local hour
//   waterTempF    water temperature in °F (optional)
//   cloudCover    0–100 percent cloud cover (optional)
function fishingScore({ moonPct, baroHpa, baroTrend, windMph, tideDir, hour, waterTempF, cloudCover }) {
  let score = 50;

  // --- LUNAR PHASE (±12 pts) ---
  // Fixed: Math.abs(Math.cos()) peaks at BOTH new moon (pct=0) AND full moon (pct=0.5)
  // and scores zero at first/last quarter (pct=0.25 / 0.75)
  const moonFactor = Math.abs(Math.cos(moonPct * Math.PI));
  score += moonFactor * 12;

  // --- SOLUNAR PERIODS (0 to +12 pts) ---
  // Bonus for major (moon overhead/underfoot) and minor (moon rise/set) feeding windows
  if (hour !== undefined) {
    score += solunarBonus(hour, moonPct);
  }

  // --- BAROMETRIC PRESSURE — absolute value (−15 to +10 pts) ---
  if (baroHpa) {
    if (baroHpa >= 1008 && baroHpa <= 1022) score += 10;   // ideal stable high pressure
    else if (baroHpa >= 1000 && baroHpa < 1008) score += 0; // neutral — acceptable
    else if (baroHpa < 1000) score -= 15;                   // storm system — fish go deep
  }

  // --- BAROMETRIC PRESSURE — trend (−12 to +8 pts) ---
  // Rising pressure after a low = excellent; rapidly falling = fish stop feeding
  if (baroTrend !== undefined && baroTrend !== null) {
    if (baroTrend > 2)        score += 8;   // strong rise — fish moving to feed
    else if (baroTrend > 0.5) score += 4;   // gradual rise — good
    else if (baroTrend > -0.5) score += 0;  // stable — neutral
    else if (baroTrend > -2)  score -= 6;   // gradual fall — fish slowing
    else                      score -= 12;  // rapid fall — fish go deep, stop feeding
  }

  // --- WIND SPEED (−20 to +10 pts) ---
  if (windMph < 5)       score += 10;  // calm — ideal presentation
  else if (windMph < 12) score += 5;   // light breeze — good
  else if (windMph <= 20) score += 0;  // moderate — neutral
  else if (windMph <= 30) score -= 12; // strong — harder fishing
  else                    score -= 20; // very strong — dangerous, fish deep

  // --- TIDE DIRECTION (0 to +15 pts) ---
  if (tideDir === "incoming") score += 15;  // flood tide — best: pushes bait onto flats
  else if (tideDir === "outgoing") score += 5; // ebb tide — ok: concentrates fish at edges
  // slack tide: no bonus

  // --- TIME OF DAY (−8 to +15 pts) ---
  if (hour !== undefined) {
    if (hour >= 5 && hour <= 8)        score += 15;  // dawn — prime low-light feeding
    else if (hour >= 17 && hour <= 20) score += 12;  // dusk — second prime window
    else if (hour >= 9 && hour <= 16)  score -= 5;   // midday — bright sun, fish deep
    else                               score -= 8;   // night — least active for most species
  }

  // --- WATER TEMPERATURE (−15 to +8 pts) ---
  // Inshore species (redfish, snook, trout) are most active 65–85°F
  if (waterTempF !== undefined && waterTempF !== null) {
    if (waterTempF >= 68 && waterTempF <= 82)       score += 8;  // ideal range
    else if (waterTempF >= 60 && waterTempF < 68)   score += 3;  // cool but ok
    else if (waterTempF > 82 && waterTempF <= 88)   score += 0;  // warm — neutral
    else if (waterTempF > 88 || waterTempF < 55)    score -= 10; // too hot or cold — fish lethargic
    else if (waterTempF < 60)                        score -= 15; // very cold — fish nearly inactive
  }

  // --- CLOUD COVER (−5 to +5 pts) ---
  // Overcast days extend feeding windows past dawn; bright sun pushes fish deep
  if (cloudCover !== undefined && cloudCover !== null) {
    if (cloudCover >= 50 && cloudCover <= 90)  score += 5;  // overcast — reduced glare, longer feed
    else if (cloudCover > 90)                  score += 2;  // fully overcast — still good
    else if (cloudCover < 20)                  score -= 5;  // bright clear sky — fish go deep midday
  }

  return Math.max(5, Math.min(99, Math.round(score)));
}

function scoreColor(s) {
  if (s >= 75) return "#22c55e";
  if (s >= 55) return "#84cc16";
  if (s >= 40) return "#eab308";
  if (s >= 25) return "#f97316";
  return "#ef4444";
}

function windColor(mph) {
  if (mph < 8) return "#22c55e";
  if (mph < 15) return "#84cc16";
  if (mph < 20) return "#eab308";
  if (mph < 25) return "#f97316";
  return "#ef4444";
}

// ---------- Tide direction helper ----------
function calcTideDirections(tideHeights) {
  return tideHeights.map((h, i) => {
    if (i === 0) return "unknown";
    return h > tideHeights[i - 1] ? "incoming" : "outgoing";
  });
}

// ---------- Sparkline / mini chart components ----------
function LineGraph({ data, color = "#38bdf8", fillColor, label, unit, height = 80, nowIndex }) {
  if (!data || data.length < 2) return <div style={{ height }}>No data</div>;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const w = 100;
  const h = height;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 10) - 5;
    return `${x},${y}`;
  });
  const polyline = pts.join(" ");
  const fillPath = `M ${pts[0]} L ${pts.join(" L ")} L ${(data.length - 1) / (data.length - 1) * w},${h} L 0,${h} Z`;
  // Position of the current-hour marker: fraction 0..1 across the x axis
  const nowX = (nowIndex != null && data.length > 1)
    ? (nowIndex / (data.length - 1)) * w : null;

  return (
    <div style={{ position: "relative", width: "100%", height }}>
      {/* SVG chart — preserveAspectRatio="none" stretches the line correctly */}
      <svg viewBox={`0 0 100 ${h}`} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }} preserveAspectRatio="none">
        {fillColor && <path d={fillPath} fill={fillColor} opacity={0.25} />}
        <polyline points={polyline} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
        {nowX != null && (
          <>
            <line x1={nowX} y1={0} x2={nowX} y2={h} stroke="#ef4444" strokeWidth="1" strokeDasharray="2,2" opacity={0.9} />
            <circle cx={nowX} cy={h / 2} r="1.5" fill="#ef4444" opacity={0.9} />
          </>
        )}
      </svg>
      {/* Min/max labels — outside SVG so they render at true pixel size, no distortion */}
      <span style={{ position: "absolute", top: 0, left: 3, fontSize: 9, color: "#94a3b8", lineHeight: 1, pointerEvents: "none" }}>{fmt(max, 1)}{unit}</span>
      <span style={{ position: "absolute", bottom: 0, left: 3, fontSize: 9, color: "#94a3b8", lineHeight: 1, pointerEvents: "none" }}>{fmt(min, 1)}{unit}</span>
    </div>
  );
}

function BarGraph({ data, colorFn, label, unit, height = 80, nowIndex }) {
  if (!data || data.length === 0) return <div style={{ height }}>No data</div>;
  const max = Math.max(...data, 1);
  const w = 100;
  const h = height;
  const barW = (w / data.length) * 0.7;
  const gap = w / data.length;
  // Centre of the current-hour bar
  const nowX = (nowIndex != null && data.length > 0)
    ? nowIndex * gap + gap * 0.5 : null;

  return (
    <div style={{ position: "relative", width: "100%", height }}>
      <svg viewBox={`0 0 100 ${h}`} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }} preserveAspectRatio="none">
        {data.map((v, i) => {
          const bh = (v / max) * (h - 10);
          const x = i * gap + gap * 0.15;
          const y = h - bh - 2;
          return (
            <rect key={i} x={x} y={y} width={barW} height={bh}
              fill={colorFn ? colorFn(v) : "#38bdf8"} rx="0.5" opacity={0.9} />
          );
        })}
        {nowX != null && (
          <>
            <line x1={nowX} y1={0} x2={nowX} y2={h} stroke="#ef4444" strokeWidth="1" strokeDasharray="2,2" opacity={0.9} />
            <circle cx={nowX} cy={h / 2} r="1.5" fill="#ef4444" opacity={0.9} />
          </>
        )}
      </svg>
      <span style={{ position: "absolute", top: 0, left: 3, fontSize: 9, color: "#94a3b8", lineHeight: 1, pointerEvents: "none" }}>{fmt(max, 0)}{unit}</span>
    </div>
  );
}

// ---------- Tile wrapper ----------
function Tile({ title, icon, children, onClick, hint, accent = "#0ea5e9" }) {
  return (
    <div onClick={onClick} style={{
      background: "linear-gradient(135deg, #0f172a 60%, #1e293b)",
      border: `1px solid ${accent}33`,
      borderRadius: 14,
      padding: "14px 16px",
      marginBottom: 14,
      cursor: onClick ? "pointer" : "default",
      boxShadow: `0 2px 16px ${accent}18`,
      position: "relative",
      overflow: "hidden",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 18 }}>{icon}</span>
        <span style={{ fontFamily: "'Orbitron', monospace", fontSize: 12, color: accent, letterSpacing: 1, textTransform: "uppercase" }}>{title}</span>
        {hint && <span style={{ marginLeft: "auto", fontSize: 10, color: "#475569", fontStyle: "italic" }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

// ---------- Mini hour-detail modal ----------
function HourModal({ data, onClose, nowHour }) {
  if (!data) return null;
  return (
    <div style={{
      position: "fixed", inset: 0, background: "#000b", zIndex: 10000,
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: "0 12px",
    }} onClick={onClose}>
      <div style={{
        background: "#0f172a", border: "1px solid #0ea5e933", borderRadius: 18,
        padding: 20, width: "100%", maxWidth: 560, maxHeight: "80vh", overflowY: "auto",
      }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontFamily: "'Orbitron', monospace", color: "#38bdf8", fontSize: 13, marginBottom: 14 }}>
          HOURLY FORECAST — {data.date}
        </div>
        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", color: "#cbd5e1" }}>
          <thead>
            <tr style={{ color: "#64748b", borderBottom: "1px solid #1e293b" }}>
              <th style={{ textAlign: "left", padding: "4px 6px" }}>Hour</th>
              <th style={{ padding: "4px 6px" }}>Temp</th>
              <th style={{ padding: "4px 6px" }}>Rain%</th>
              <th style={{ padding: "4px 6px" }}>Precip"</th>
              <th style={{ padding: "4px 6px" }}>Baro</th>
              <th style={{ padding: "4px 6px" }}>Trend</th>
              <th style={{ padding: "4px 6px" }}>Wind</th>
              <th style={{ padding: "4px 6px" }}>☁️%</th>
            </tr>
          </thead>
          <tbody>
            {data.hours.map((h, i) => {
              // Highlight current hour with a red outline box
              const isNow = data.isToday && nowHour != null && parseInt(h.time) === nowHour;
              return (
                <tr key={i} style={{
                  borderBottom: "1px solid #1e293b22",
                  outline: isNow ? "1.5px solid #ef4444" : "none",
                  outlineOffset: "-1px",
                  background: isNow ? "#ef444411" : "transparent",
                  borderRadius: isNow ? 4 : 0,
                }}>
                  <td style={{ padding: "4px 6px", color: isNow ? "#ef4444" : "inherit", fontWeight: isNow ? "bold" : "normal" }}>{to12h(h.time)}</td>
                  <td style={{ padding: "4px 6px", textAlign: "center" }}>{fmt(h.temp, 0)}°</td>
                  <td style={{ padding: "4px 6px", textAlign: "center", color: h.rain > 50 ? "#38bdf8" : "#94a3b8" }}>{h.rain}%</td>
                  <td style={{ padding: "4px 6px", textAlign: "center" }}>{fmt(h.precip, 2)}"</td>
                  <td style={{ padding: "4px 6px", textAlign: "center" }}>{fmt(h.baro, 0)}</td>
                  <td style={{ padding: "4px 6px", textAlign: "center", color: h.baroTrend > 0.5 ? "#22c55e" : h.baroTrend < -0.5 ? "#ef4444" : "#94a3b8" }}>
                    {h.baroTrend != null ? (h.baroTrend > 0 ? "▲" : h.baroTrend < 0 ? "▼" : "—") : "—"}{h.baroTrend != null ? fmt(Math.abs(h.baroTrend), 1) : ""}
                  </td>
                  <td style={{ padding: "4px 6px", textAlign: "center", color: windColor(h.wind) }}>{fmt(h.wind, 0)}</td>
                  <td style={{ padding: "4px 6px", textAlign: "center", color: h.cloud > 50 ? "#a78bfa" : "#94a3b8" }}>{h.cloud ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <button onClick={onClose} style={{
          marginTop: 16, width: "100%", padding: "10px 0",
          background: "#0ea5e922", border: "1px solid #0ea5e944",
          borderRadius: 8, color: "#38bdf8", fontFamily: "'Orbitron', monospace",
          fontSize: 12, cursor: "pointer",
        }}>CLOSE</button>
      </div>
    </div>
  );
}


// ── Fish species lists ────────────────────────────────────────────────────────
// Stored in catch records as the string value shown here.
// Saltwater list includes the 6 specifically requested + 9 more popular species.
// Freshwater list includes the 2 specifically requested + 13 more popular species.
const SW_FISH = [
  "Striped Bass","Bluefish","Summer Flounder (Fluke)","Winter Flounder",
  "Sea Robin","Crab","Red Drum (Redfish)","Speckled Trout",
  "Snook","Tarpon","Spanish Mackerel","Pompano",
  "Black Sea Bass","Sheepshead","Mahi-Mahi","Other",
];
const FW_FISH = [
  "Bluegill","Chain Pickerel","Largemouth Bass","Smallmouth Bass",
  "Striped Bass (FW)","Walleye","Northern Pike","Yellow Perch",
  "Crappie (Black)","Crappie (White)","Channel Catfish","Rainbow Trout",
  "Brown Trout","Brook Trout","Carp","Other",
];

// 150 ft in degrees lat (approx) — used for catch cluster radius
const CLUSTER_RADIUS_DEG = 150 / 364000; // 150ft / (ft per degree lat)

// Generate a short unique ID for each catch record
function catchId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Load / save catch log from localStorage
function loadCatches() {
  try { return JSON.parse(localStorage.getItem("fish_catches") || "[]"); } catch { return []; }
}
function saveCatches(arr) {
  localStorage.setItem("fish_catches", JSON.stringify(arr));
}

// Group catches into clusters: any catch within CLUSTER_RADIUS_DEG of an
// existing cluster centroid is merged into that cluster.
// Returns array of { lat, lon, catches: [...] }
function clusterCatches(catches) {
  const clusters = [];
  for (const c of catches) {
    let found = false;
    for (const cl of clusters) {
      const dlat = Math.abs(c.lat - cl.lat);
      const dlon = Math.abs(c.lon - cl.lon);
      if (dlat < CLUSTER_RADIUS_DEG && dlon < CLUSTER_RADIUS_DEG) {
        cl.catches.push(c);
        found = true; break;
      }
    }
    if (!found) clusters.push({ lat: c.lat, lon: c.lon, catches: [c] });
  }
  return clusters;
}

// Zero-pad minutes for time display
function padMin(n) { return String(n).padStart(2, "0"); }

// ============================================================
// MAIN APP
// ============================================================
export default function App() {
  const [tab, setTab] = useState("map");
  const [searchQuery, setSearchQuery] = useState("");
  const [location, setLocation] = useState(null); // { lat, lon, name }
  const [savedLocations, setSavedLocations] = useState(() => {
    try { return JSON.parse(localStorage.getItem("fish_locs") || "[]"); } catch { return []; }
  });
  const [favoriteIdx, setFavoriteIdx] = useState(() => {
    try { const v = localStorage.getItem("fish_fav"); return v !== null ? parseInt(v) : -1; } catch { return -1; }
  });
  const [spotsOpen, setSpotsOpen] = useState(false);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [weather, setWeather] = useState(null);
  const [tides, setTides] = useState(null);
  const [sst, setSst] = useState(null); // { hourly: [...], tooFar: bool } | null
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [hourModal, setHourModal] = useState(null);
  const [selectedDayIdx, setSelectedDayIdx] = useState(0);
  const [mapLoaded, setMapLoaded] = useState(false);
  // ---- Weather alert state ----
  const [weatherAlert, setWeatherAlert] = useState(null);
  const [alertModalOpen, setAlertModalOpen] = useState(false);
  const alertIntervalRef = useRef(null);
  const weatherIntervalRef = useRef(null);  // 15-min foreground weather refresh
  // ---- Fish log state ----
  const [catches, setCatches] = useState(loadCatches);          // all saved catch records
  const [showCatchMarkers, setShowCatchMarkers] = useState(true);// checkbox toggle
  const [logPhase, setLogPhase] = useState("idle");              // idle | placing | form

  const [catchForm, setCatchForm] = useState(null);              // form field state while open
  const [catchListModal, setCatchListModal] = useState(null);    // cluster shown in list modal
  const [catchDetailEntry, setCatchDetailEntry] = useState(null);// single entry shown in detail card
  const catchMarkersRef = useRef([]);                            // Leaflet marker objects on map
  const mapRef = useRef(null);
  const leafletMapRef = useRef(null);
  const markerRef = useRef(null);

  // ---- Auto-load on first mount ────────────────────────────────────────────
  // Priority 1: starred favorite → load it immediately.
  // Priority 2: no favorite (regardless of saved spots) → silently use GPS.
  //   On Capacitor (Android) this uses the same dynamic-import Geolocation path
  //   as useCurrentLocation so the Android permission dialog fires correctly.
  //   On browser it uses navigator.geolocation as a fallback.
  //   Errors are swallowed — the app just opens on the default map view if GPS
  //   is unavailable or denied.
  useEffect(() => {
    if (favoriteIdx >= 0 && savedLocations[favoriteIdx]) {
      // Starred favorite exists — load it
      const fav = savedLocations[favoriteIdx];
      setLocation({ lat: fav.lat, lon: fav.lon, name: fav.label });
      return;
    }
    // No favorite starred — silently locate the user regardless of saved spots
    (async () => {
      try {
        let lat, lon;
        const cap = window.Capacitor;
        if (cap && cap.isNativePlatform && cap.isNativePlatform()) {
          const { Geolocation } = await import("@capacitor/geolocation");
          const perm = await Geolocation.requestPermissions();
          if (perm.location !== "granted" && perm.coarseLocation !== "granted") return;
          const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 });
          lat = pos.coords.latitude; lon = pos.coords.longitude;
        } else {
          if (!navigator.geolocation) return;
          const pos = await new Promise((res, rej) =>
            navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 10000 })
          );
          lat = pos.coords.latitude; lon = pos.coords.longitude;
        }
        let name = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
        try {
          const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`);
          const j = await r.json();
          if (j.display_name) name = j.display_name.split(",").slice(0, 2).join(", ");
        } catch (_) {}
        setLocation({ lat, lon, name });
      } catch (_) {
        // GPS unavailable or denied — open on default map view, no error shown
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally run once on mount only

  // ---- Load Leaflet ----
  useEffect(() => {
    if (window.L) { setMapLoaded(true); return; }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
    document.head.appendChild(link);
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
    script.onload = () => setMapLoaded(true);
    document.head.appendChild(script);
  }, []);

  // ---- Init map (runs once after Leaflet loads) ----
  // BUG FIX: map div is always rendered (just hidden via CSS when on Details tab)
  // so the DOM node is never destroyed and Leaflet stays attached.
  // FIX: if a favorite location was already set before Leaflet finished loading,
  // we pan and place the marker here once the map is ready.
  useEffect(() => {
    if (!mapLoaded || !mapRef.current || leafletMapRef.current) return;
    const L = window.L;
    const map = L.map(mapRef.current, { zoomControl: true }).setView([27.5, -82.5], 9);
    // ── Zoom-aware hybrid map ─────────────────────────────────────────────────
    // Zoomed out (< 13): ESRI satellite — clean imagery, city/border labels only.
    // Zoomed in  (≥ 13): Google Hybrid — satellite imagery WITH roads, street
    //   names, and place labels baked into a single tile layer.
    //   Using a single tile source per zoom range eliminates overlay flickering
    //   entirely, since there is no compositing of two separate tile streams.
    //
    // The swap is done by listening to Leaflet's zoomend event and adding /
    // removing the appropriate layer. Both layers are created upfront so
    // Leaflet can pre-cache and the swap is instant.
    // ─────────────────────────────────────────────────────────────────────────

    const STREET_ZOOM = 13; // zoom level at which roads become useful

    const satelliteLayer = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { attribution: "Esri, USGS, NOAA", maxZoom: 18 }
    );

    // ESRI satellite + city/boundary labels only (no roads) — used when zoomed out
    const labelsLayer = L.tileLayer(
      "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      { attribution: "", maxZoom: 18, opacity: 1 }
    );

    // Google Hybrid = satellite + roads + street names in one tile stream
    const hybridLayer = L.tileLayer(
      "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
      { attribution: "© Google", maxZoom: 20 }
    );

    // Helper: swap layers based on current zoom
    function applyZoomLayers() {
      const z = map.getZoom();
      if (z >= STREET_ZOOM) {
        // Zoomed in — show Google Hybrid (satellite + roads), hide separate layers
        if (!map.hasLayer(hybridLayer))  map.addLayer(hybridLayer);
        if (map.hasLayer(satelliteLayer)) map.removeLayer(satelliteLayer);
        if (map.hasLayer(labelsLayer))    map.removeLayer(labelsLayer);
      } else {
        // Zoomed out — show ESRI satellite + label overlay, hide hybrid
        if (!map.hasLayer(satelliteLayer)) map.addLayer(satelliteLayer);
        if (!map.hasLayer(labelsLayer))    map.addLayer(labelsLayer);
        if (map.hasLayer(hybridLayer))     map.removeLayer(hybridLayer);
      }
    }

    // Apply on load and on every zoom change
    applyZoomLayers();
    map.on("zoomend", applyZoomLayers);
    leafletMapRef.current = map;
    map.on("click", (e) => {
      const { lat, lng } = e.latlng;
      setLocationAndFetch(lat, lng, `${lat.toFixed(4)}, ${lng.toFixed(4)}`);
    });
    // If a favorite was loaded before the map was ready, apply it now
    if (location) {
      const icon = L.divIcon({
        html: `<div style="background:#0ea5e9;width:14px;height:14px;border-radius:50%;border:3px solid white;box-shadow:0 0 8px #0ea5e9"></div>`,
        className: "", iconAnchor: [7, 7],
      });
      if (markerRef.current) markerRef.current.remove();
      markerRef.current = L.marker([location.lat, location.lon], { icon }).addTo(map);
      map.setView([location.lat, location.lon], 12);
    }
  }, [mapLoaded]);

  // ---- Invalidate map size whenever we switch back to map tab ----
  // Leaflet caches the container size; if the div was hidden it needs a nudge.
  useEffect(() => {
    if (tab === "map" && leafletMapRef.current) {
      setTimeout(() => leafletMapRef.current.invalidateSize(), 50);
    }
  }, [tab]);

  // ---- Update marker ----
  useEffect(() => {
    if (!leafletMapRef.current || !location) return;
    const L = window.L;
    if (markerRef.current) markerRef.current.remove();
    const icon = L.divIcon({
      html: `<div style="background:#0ea5e9;width:14px;height:14px;border-radius:50%;border:3px solid white;box-shadow:0 0 8px #0ea5e9"></div>`,
      className: "", iconAnchor: [7, 7],
    });
    markerRef.current = L.marker([location.lat, location.lon], { icon }).addTo(leafletMapRef.current);
    leafletMapRef.current.panTo([location.lat, location.lon], { animate: true });
  }, [location]);

  // ---- Fetch all data when location changes ----
  useEffect(() => {
    if (!location) return;
    fetchAllData(location.lat, location.lon);
  }, [location]);

  // ---- Refresh weather data every 15 minutes — foreground only ────────────
  // Uses the same visibilitychange pattern as the alert poller so no background
  // network calls are made. On return to foreground, fetches immediately then
  // restarts the 15-minute timer.
  useEffect(() => {
    if (!location) return;

    const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

    function startWeatherPolling() {
      if (weatherIntervalRef.current) clearInterval(weatherIntervalRef.current);
      weatherIntervalRef.current = setInterval(() => {
        // Refresh quietly — don't clear existing data or show loading spinner
        // so the UI stays usable during background refresh.
        Promise.all([
          fetchWeather(location.lat, location.lon),
          fetchTides(location.lat, location.lon),
          fetchSST(location.lat, location.lon),
        ]).then(([w, t, s]) => {
          setWeather(w);
          setTides(t);
          setSst(s);
        }).catch(() => {}); // swallow errors on background refresh
      }, INTERVAL_MS);
    }

    function stopWeatherPolling() {
      if (weatherIntervalRef.current) {
        clearInterval(weatherIntervalRef.current);
        weatherIntervalRef.current = null;
      }
    }

    function handleWeatherVisibility() {
      if (document.hidden) {
        stopWeatherPolling();
      } else {
        // Back in foreground — fetch fresh data immediately then restart timer
        Promise.all([
          fetchWeather(location.lat, location.lon),
          fetchTides(location.lat, location.lon),
          fetchSST(location.lat, location.lon),
        ]).then(([w, t, s]) => {
          setWeather(w); setTides(t); setSst(s);
        }).catch(() => {});
        startWeatherPolling();
      }
    }

    startWeatherPolling();
    document.addEventListener("visibilitychange", handleWeatherVisibility);

    return () => {
      stopWeatherPolling();
      document.removeEventListener("visibilitychange", handleWeatherVisibility);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]); // re-register whenever location changes

  async function setLocationAndFetch(lat, lon, name) {
    setLocation({ lat, lon, name });
  }

  async function geocode(query) {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
    const r = await fetch(url, { headers: { "Accept-Language": "en" } });
    if (!r.ok) throw new Error("Location search failed");
    const j = await r.json();
    if (!j.length) throw new Error("Location not found");
    return { lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon), name: j[0].display_name.split(",").slice(0, 2).join(", ") };
  }

  async function handleSearch() {
    if (!searchQuery.trim()) return;

    // ---- Test triggers ----
    const q = searchQuery.trim().toLowerCase();
    if (q === "open test weather alert") {
      setWeatherAlert({
        event:       "Severe Thunderstorm Warning",
        headline:    "Severe Thunderstorm Warning until 5:15 PM EDT",
        description: "At 3:42 PM EDT, a severe thunderstorm was located near Myrtle Beach, moving northeast at 35 mph. HAZARD: 70 mph wind gusts and half-dollar-sized hail. SOURCE: Radar indicated. IMPACT: Hail damage to vehicles is expected. Expect wind damage to roofs, siding, and trees.",
        instruction: "For your protection move to an interior room on the lowest floor of a building. Do not seek shelter under trees or in open areas. If boating or swimming, get out of the water immediately.",
        expires:     new Date(Date.now() + 90 * 60 * 1000).toISOString(), // 90 min from now
        areaDesc:    "Horry County; Georgetown County SC",
      });
      setSearchQuery("");
      return;
    }
    if (q === "close test weather alert") {
      setWeatherAlert(null);
      setAlertModalOpen(false);
      setSearchQuery("");
      return;
    }

    setLoading(true); setError("");
    try {
      const loc = await geocode(searchQuery);
      setLocation(loc);
      setTab("map");
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  // ---- GPS / Current Location ----
  // BUG FIX: navigator.geolocation alone does not trigger the Android permission
  // dialog inside a Capacitor WebView. We use the Capacitor Geolocation plugin when
  // available (installed via: npm install @capacitor/geolocation && npx cap sync android).
  // Falls back to navigator.geolocation for browser/PWA use.
  // AndroidManifest.xml must include:
  //   <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
  //   <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
  async function useCurrentLocation() {
    setLoading(true); setError("");
    try {
      let lat, lon;

      // Try Capacitor Geolocation first (works inside Android WebView)
      const cap = window.Capacitor;
      if (cap && cap.isNativePlatform && cap.isNativePlatform()) {
        const { Geolocation } = await import("@capacitor/geolocation");
        // Request permission explicitly — this triggers the Android dialog
        const perm = await Geolocation.requestPermissions();
        if (perm.location !== "granted" && perm.coarseLocation !== "granted") {
          throw new Error("Location permission denied. Please allow location access in your phone settings.");
        }
        const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 });
        lat = pos.coords.latitude;
        lon = pos.coords.longitude;
      } else {
        // Browser / PWA fallback
        if (!navigator.geolocation) throw new Error("Geolocation not supported on this device.");
        const pos = await new Promise((res, rej) =>
          navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 15000 })
        );
        lat = pos.coords.latitude;
        lon = pos.coords.longitude;
      }

      // Reverse geocode to get a human-readable name
      let name = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`);
        const j = await r.json();
        if (j.display_name) name = j.display_name.split(",").slice(0, 2).join(", ");
      } catch (_) {}

      setLocation({ lat, lon, name });
      setTab("map");
    } catch (e) {
      setError("Location error: " + (e.message || "Unknown error"));
    } finally {
      setLoading(false);
    }
  }

  function saveLocation() {
    if (!location || !saveName.trim()) return;
    const locs = [...savedLocations, { ...location, label: saveName.trim() }];
    setSavedLocations(locs);
    localStorage.setItem("fish_locs", JSON.stringify(locs));
    setSaveModalOpen(false); setSaveName("");
  }

  function deleteLocation(i) {
    const locs = savedLocations.filter((_, idx) => idx !== i);
    setSavedLocations(locs);
    localStorage.setItem("fish_locs", JSON.stringify(locs));
    // Adjust or clear favorite index if needed
    if (favoriteIdx === i) {
      setFavoriteIdx(-1);
      localStorage.removeItem("fish_fav");
    } else if (favoriteIdx > i) {
      const newFav = favoriteIdx - 1;
      setFavoriteIdx(newFav);
      localStorage.setItem("fish_fav", String(newFav));
    }
  }

  function toggleFavorite(i) {
    const newFav = favoriteIdx === i ? -1 : i;
    setFavoriteIdx(newFav);
    if (newFav === -1) localStorage.removeItem("fish_fav");
    else localStorage.setItem("fish_fav", String(newFav));
  }

  // ---- Fetch weather from Open-Meteo (no key needed) ----
  async function fetchWeather(lat, lon) {
    return Sentry.startSpan(
      { op: "http.client", name: "Open-Meteo: weather forecast" },
      async () => {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
          `&hourly=temperature_2m,precipitation_probability,precipitation,surface_pressure,windspeed_10m,weathercode,cloudcover` +
          `&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,sunrise,sunset,windspeed_10m_max,precipitation_probability_max` +
          `&temperature_unit=fahrenheit&windspeed_unit=mph&precipitation_unit=inch&timezone=auto&forecast_days=10`;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`Weather API error ${r.status}`);
        return r.json();
      }
    );
  }

  // ================================================================
  // FETCH TIDES — Complete rewrite v1.11
  //
  // PART 1: Ocean proximity check (is-on-water API, then SST fallback, then static)
  //   - Exact point → 5mi → 10mi → 15mi rings, 4 cardinal + 4 intercardinal dirs
  //   - Returns { oceanConfirmed: true } or { tooFar: true }
  //
  // PART 2: NOAA tide station fetch
  //   - Downloads full station list from NOAA metadata API
  //   - Sorts by distance, tries up to 10 nearest (some lack harmonic data)
  //   - If all 10 fail, expands to 20
  //   - Returns hi/lo extremes per day (for table) + hourly array for today (for graph)
  // ================================================================
  async function fetchTides(lat, lon) {

    // ---- Shared timeout helper (compatible with all Android WebView versions) ----
    function timedFetch(url, ms = 7000) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), ms);
      return fetch(url, { signal: ctrl.signal })
        .then(r  => { clearTimeout(t); return r; })
        .catch(e => { clearTimeout(t); throw e; });
    }

    // ---- PART 1: Ocean proximity check ----
    const LAT_PER_MILE = 1 / 69.0;
    const LON_PER_MILE = 1 / (69.0 * Math.cos(lat * Math.PI / 180));
    const DIRS = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];

    // Probe one point with is-on-water API.
    // Returns "ocean" | "land" | "error"
    // Every call is wrapped in a Sentry span for latency tracking.
    // Errors (network failure, timeout, non-200) are counted; if ALL probes in
    // a full proximity check fail, a dedicated Sentry event fires so you know
    // the service is down without waiting for a user to report it.
    let _isOnWaterErrorCount = 0;
    let _isOnWaterTotalCount = 0;

    async function probeIsOnWater(pLat, pLon) {
      _isOnWaterTotalCount++;
      return Sentry.startSpan(
        { op: "http.client", name: "is-on-water: ocean probe" },
        async (span) => {
          try {
            const r = await timedFetch(
              `https://is-on-water.balbona.me/api/v1/get/${pLat.toFixed(5)}/${pLon.toFixed(5)}`,
              6000
            );
            if (!r.ok) {
              _isOnWaterErrorCount++;
              span?.setStatus({ code: 2, message: `HTTP ${r.status}` });
              return "error";
            }
            const j = await r.json();
            if (j.isWater === true && (j.feature === "OCEAN" || j.feature === "UNKNOWN")) return "ocean";
            if (j.isWater === false) return "land";
            // Unexpected response shape
            _isOnWaterErrorCount++;
            return "error";
          } catch (e) {
            _isOnWaterErrorCount++;
            span?.setStatus({ code: 2, message: e.message });
            return "error";
          }
        }
      );
    }

    // Called after proximityCheck completes to report a full service outage.
    // Fires only when every single probe errored — meaning the service is
    // unreachable, not just that the location is inland.
    function reportIsOnWaterOutageIfNeeded() {
      if (_isOnWaterTotalCount > 0 && _isOnWaterErrorCount === _isOnWaterTotalCount) {
        Sentry.captureMessage("is-on-water service appears down — all probes failed", {
          level: "warning",
          tags: { service: "is-on-water", failure_type: "full_outage" },
          extra: {
            totalProbes:  _isOnWaterTotalCount,
            errorProbes:  _isOnWaterErrorCount,
            errorRate:    "100%",
          },
        });
      } else if (_isOnWaterTotalCount > 0 && _isOnWaterErrorCount / _isOnWaterTotalCount >= 0.5) {
        // More than 50% errors — degraded but not fully down
        Sentry.captureMessage("is-on-water service degraded — high error rate", {
          level: "warning",
          tags: { service: "is-on-water", failure_type: "degraded" },
          extra: {
            totalProbes:  _isOnWaterTotalCount,
            errorProbes:  _isOnWaterErrorCount,
            errorRate:    `${Math.round(_isOnWaterErrorCount / _isOnWaterTotalCount * 100)}%`,
          },
        });
      }
    }

    // Probe one point with SST fallback.
    // Returns true (ocean) or false (not ocean / unavailable)
    async function probeSST(pLat, pLon) {
      try {
        const r = await timedFetch(
          `https://marine-api.open-meteo.com/v1/marine?latitude=${pLat.toFixed(4)}&longitude=${pLon.toFixed(4)}&hourly=sea_surface_temperature&forecast_days=1`,
          6000
        );
        const j = await r.json();
        if (j.error) return false;
        const vals = j.hourly?.sea_surface_temperature;
        return !!(vals && vals.some(v => v !== null));
      } catch (_) { return false; }
    }

    // Test one ring of 8 points at given radius in miles.
    // Returns true as soon as any direction confirms ocean.
    async function ringIsOcean(miles, probeFn) {
      const latDeg = miles * LAT_PER_MILE;
      const lonDeg = miles * LON_PER_MILE;
      const results = await Promise.all(DIRS.map(async ([dlat, dlon]) => {
        const mag = Math.hypot(dlat, dlon);
        return probeFn(lat + (dlat / mag) * latDeg, lon + (dlon / mag) * lonDeg);
      }));
      // For is-on-water: "ocean" means confirmed; for SST: true means confirmed
      return results.some(r => r === "ocean" || r === true);
    }

    // Run the full 4-step proximity check with a given probe function.
    // Steps: exact → 5mi → 10mi → 15mi (or up to maxMiles for SST)
    // Returns the confirmed ocean {lat, lon} point if found, null if unreachable API, false if not found.
    // Using the ocean point (not the original address) as the station search origin
    // prevents inland stations (like ICWW stations) from being selected over
    // open-coast stations that are actually closer to the ocean.
    async function proximityCheck(probeFn, maxMiles = 15) {
      // Step 0: exact point
      const exact = await probeFn(lat, lon);
      if (exact === "ocean" || exact === true) return { lat, lon }; // already on water
      if (exact === "error") return null; // signal API unreachable

      // Steps 1-N: 5-mile rings — return the first confirmed ocean coordinate
      for (let miles = 5; miles <= maxMiles; miles += 5) {
        const latDeg = miles * LAT_PER_MILE;
        const lonDeg = miles * LON_PER_MILE;
        const hits = await Promise.all(DIRS.map(async ([dlat, dlon]) => {
          const mag = Math.hypot(dlat, dlon);
          const pLat = lat + (dlat / mag) * latDeg;
          const pLon = lon + (dlon / mag) * lonDeg;
          const r = await probeFn(pLat, pLon);
          return (r === "ocean" || r === true) ? { lat: pLat, lon: pLon } : null;
        }));
        const hit = hits.find(h => h !== null);
        if (hit) return hit; // return the actual ocean coordinate
      }
      return false;
    }

    // ---- Run PART 1 ----
    // oceanPoint stores the confirmed ocean coordinate — used in Part 2 to find
    // the nearest COASTAL tide station rather than the nearest station to the
    // original address (which may be an inland ICWW or estuary station).
    let oceanPoint = null;

    // Try primary (is-on-water)
    const primaryResult = await proximityCheck(probeIsOnWater, 15);
    // Report to Sentry if is-on-water appeared fully down or degraded
    reportIsOnWaterOutageIfNeeded();

    if (primaryResult && primaryResult.lat !== undefined) {
      oceanPoint = primaryResult; // confirmed ocean coordinate
    } else if (primaryResult === false) {
      // Primary said not ocean within 15 miles — try SST fallback up to 50 miles
      const sstResult = await proximityCheck(probeSST, 50);
      if (sstResult && sstResult.lat !== undefined) oceanPoint = sstResult;
    } else {
      // Primary API unreachable (null) — go straight to SST fallback
      const sstResult = await proximityCheck(probeSST, 50);
      if (sstResult && sstResult.lat !== undefined) {
        oceanPoint = sstResult;
      } else {
        // Both APIs failed — use static fallback list as last resort
        // Static list: if user is near any of these known coastal stations,
        // assume ocean proximity and proceed to Part 2.
        /* STATIC FALLBACK STATION LIST — used only when both APIs are unreachable
        const STATIC_STATIONS = [
          { id: "8726520", lat: 27.76, lng: -82.63, name: "Tampa Bay" },
          { id: "8723970", lat: 25.73, lng: -80.16, name: "Miami" },
          { id: "8720218", lat: 30.40, lng: -81.63, name: "Jacksonville" },
          { id: "8771341", lat: 29.73, lng: -95.27, name: "Galveston" },
          { id: "8737048", lat: 30.25, lng: -88.07, name: "Mobile Bay" },
          { id: "8652587", lat: 35.75, lng: -75.55, name: "Oregon Inlet" },
          { id: "8665530", lat: 32.78, lng: -79.93, name: "Charleston" },
          { id: "8670870", lat: 31.95, lng: -80.87, name: "Savannah" },
          { id: "8661070", lat: 33.66, lng: -78.92, name: "Springmaid Pier SC" },
          { id: "8516945", lat: 40.70, lng: -74.01, name: "New York" },
          { id: "8519483", lat: 40.64, lng: -73.75, name: "Norton Point NY" },
          { id: "8512354", lat: 40.84, lng: -72.32, name: "Shinnecock" },
          { id: "8510560", lat: 41.17, lng: -72.30, name: "Montauk" },
          { id: "8534720", lat: 39.35, lng: -74.42, name: "Atlantic City" },
          { id: "8557380", lat: 38.78, lng: -75.12, name: "Lewes DE" },
          { id: "8638610", lat: 36.95, lng: -76.33, name: "Sewells Point" },
          { id: "8410140", lat: 43.66, lng: -70.25, name: "Portland ME" },
          { id: "8443970", lat: 42.36, lng: -71.05, name: "Boston" },
          { id: "8461490", lat: 41.36, lng: -72.09, name: "New London" },
          { id: "8454000", lat: 41.50, lng: -71.33, name: "Providence" },
          { id: "8721604", lat: 30.40, lng: -87.21, name: "Pensacola" },
          { id: "8729840", lat: 29.86, lng: -85.03, name: "Apalachicola" },
          { id: "8760922", lat: 29.11, lng: -90.20, name: "Grand Isle" },
          { id: "9414290", lat: 37.81, lng: -122.47, name: "San Francisco" },
          { id: "9410660", lat: 32.71, lng: -117.17, name: "San Diego" },
          { id: "9447130", lat: 47.60, lng: -122.34, name: "Seattle" },
          { id: "8574680", lat: 39.27, lng: -76.58, name: "Baltimore" },
        ];
        */
        const STATIC_STATIONS = [
          { id: "8726520", lat: 27.76, lng: -82.63, name: "Tampa Bay" },
          { id: "8723970", lat: 25.73, lng: -80.16, name: "Miami" },
          { id: "8720218", lat: 30.40, lng: -81.63, name: "Jacksonville" },
          { id: "8771341", lat: 29.73, lng: -95.27, name: "Galveston" },
          { id: "8737048", lat: 30.25, lng: -88.07, name: "Mobile Bay" },
          { id: "8652587", lat: 35.75, lng: -75.55, name: "Oregon Inlet" },
          { id: "8665530", lat: 32.78, lng: -79.93, name: "Charleston" },
          { id: "8670870", lat: 31.95, lng: -80.87, name: "Savannah" },
          { id: "8661070", lat: 33.66, lng: -78.92, name: "Springmaid Pier SC" },
          { id: "8516945", lat: 40.70, lng: -74.01, name: "New York" },
          { id: "8519483", lat: 40.64, lng: -73.75, name: "Norton Point NY" },
          { id: "8512354", lat: 40.84, lng: -72.32, name: "Shinnecock" },
          { id: "8510560", lat: 41.17, lng: -72.30, name: "Montauk" },
          { id: "8534720", lat: 39.35, lng: -74.42, name: "Atlantic City" },
          { id: "8557380", lat: 38.78, lng: -75.12, name: "Lewes DE" },
          { id: "8638610", lat: 36.95, lng: -76.33, name: "Sewells Point" },
          { id: "8410140", lat: 43.66, lng: -70.25, name: "Portland ME" },
          { id: "8443970", lat: 42.36, lng: -71.05, name: "Boston" },
          { id: "8461490", lat: 41.36, lng: -72.09, name: "New London" },
          { id: "8454000", lat: 41.50, lng: -71.33, name: "Providence" },
          { id: "8721604", lat: 30.40, lng: -87.21, name: "Pensacola" },
          { id: "8729840", lat: 29.86, lng: -85.03, name: "Apalachicola" },
          { id: "8760922", lat: 29.11, lng: -90.20, name: "Grand Isle" },
          { id: "9414290", lat: 37.81, lng: -122.47, name: "San Francisco" },
          { id: "9410660", lat: 32.71, lng: -117.17, name: "San Diego" },
          { id: "9447130", lat: 47.60, lng: -122.34, name: "Seattle" },
          { id: "8574680", lat: 39.27, lng: -76.58, name: "Baltimore" },
        ];
        const DEG = 69.0;
        const nearest = STATIC_STATIONS
          .map(s => ({ ...s, dist: Math.hypot((s.lat - lat) * DEG, (s.lng - lon) * DEG * Math.cos(lat * Math.PI / 180)) }))
          .sort((a, b) => a.dist - b.dist)[0];
        // If nearest static station is within 50 miles, treat as coastal
        oceanPoint = nearest && nearest.dist <= 50 ? { lat: nearest.lat, lon: nearest.lng } : null;
      }
    }

    if (!oceanPoint) return { tooFar: true };

    // ================================================================
    // PART 2: Find nearest coastal NOAA tide station using the confirmed
    // ocean point as the search origin (not the original address).
    //
    // Using the ocean point prevents inland stations (ICWW, estuaries, rivers)
    // from being selected when the user's address is near but not on the coast.
    //
    // Station filter: type=waterlevels with tidal=true AND greatlakes=false
    // This is the equivalent of the ~294 coastal tidal NWLON stations.
    // The waterlevels endpoint returns 420 total; filtering to tidal+non-greatlakes
    // gives the ocean/coastal stations only.
    // ================================================================
    const today = new Date();
    const beginDate = today.toISOString().slice(0, 10).replace(/-/g, "");
    const endDate   = new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
    const DEG_TO_MILES = 69.0;
    // Use ocean point coordinates for all distance calculations
    const refLat = oceanPoint.lat;
    const refLon = oceanPoint.lon;

    // --- Get NOAA water level station list, filter to coastal tidal stations ---
    let allStations = [];
    try {
      const metaR = await Sentry.startSpan(
        { op: "http.client", name: "NOAA: tide station metadata" },
        () => timedFetch(
          "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels&units=english",
          12000
        )
      );
      const metaJ = await metaR.json();
      allStations = (metaJ.stations || metaJ.stationList || [])
        // Filter: tidal ocean stations only — exclude Great Lakes and non-tidal inland
        .filter(s => s.tidal === true && s.greatlakes === false)
        .map(s => {
          const sLat = parseFloat(s.lat);
          const sLon = parseFloat(s.lng);
          if (isNaN(sLat) || isNaN(sLon)) return null;
          // Distance from the confirmed OCEAN POINT — not the original address
          const dist = Math.hypot(
            (sLat - refLat) * DEG_TO_MILES,
            (sLon - refLon) * DEG_TO_MILES * Math.cos(refLat * Math.PI / 180)
          );
          return { id: s.id || s.stationId, name: s.name || s.etidesStnName, lat: sLat, lon: sLon, dist };
        })
        .filter(Boolean)
        .sort((a, b) => a.dist - b.dist);
    } catch (_) {
      // Metadata fetch failed — use static list sorted by distance
      const STATIC = [
        { id: "8726520", lat: 27.76, lng: -82.63, name: "Tampa Bay" },
        { id: "8723970", lat: 25.73, lng: -80.16, name: "Miami" },
        { id: "8720218", lat: 30.40, lng: -81.63, name: "Jacksonville" },
        { id: "8771341", lat: 29.73, lng: -95.27, name: "Galveston" },
        { id: "8737048", lat: 30.25, lng: -88.07, name: "Mobile Bay" },
        { id: "8652587", lat: 35.75, lng: -75.55, name: "Oregon Inlet" },
        { id: "8665530", lat: 32.78, lng: -79.93, name: "Charleston" },
        { id: "8670870", lat: 31.95, lng: -80.87, name: "Savannah" },
        { id: "8661070", lat: 33.66, lng: -78.92, name: "Springmaid Pier SC" },
        { id: "8516945", lat: 40.70, lng: -74.01, name: "New York" },
        { id: "8519483", lat: 40.64, lng: -73.75, name: "Norton Point NY" },
        { id: "8512354", lat: 40.84, lng: -72.32, name: "Shinnecock" },
        { id: "8510560", lat: 41.17, lng: -72.30, name: "Montauk" },
        { id: "8534720", lat: 39.35, lng: -74.42, name: "Atlantic City" },
        { id: "8557380", lat: 38.78, lng: -75.12, name: "Lewes DE" },
        { id: "8638610", lat: 36.95, lng: -76.33, name: "Sewells Point" },
        { id: "8410140", lat: 43.66, lng: -70.25, name: "Portland ME" },
        { id: "8443970", lat: 42.36, lng: -71.05, name: "Boston" },
        { id: "8461490", lat: 41.36, lng: -72.09, name: "New London" },
        { id: "8454000", lat: 41.50, lng: -71.33, name: "Providence" },
        { id: "8721604", lat: 30.40, lng: -87.21, name: "Pensacola" },
        { id: "8729840", lat: 29.86, lng: -85.03, name: "Apalachicola" },
        { id: "8760922", lat: 29.11, lng: -90.20, name: "Grand Isle" },
        { id: "9414290", lat: 37.81, lng: -122.47, name: "San Francisco" },
        { id: "9410660", lat: 32.71, lng: -117.17, name: "San Diego" },
        { id: "9447130", lat: 47.60, lng: -122.34, name: "Seattle" },
        { id: "8574680", lat: 39.27, lng: -76.58, name: "Baltimore" },
      ];
      allStations = STATIC
        .map(s => ({
          id: s.id, name: s.name, lat: s.lat, lon: s.lng,
          dist: Math.hypot((s.lat - refLat) * DEG_TO_MILES, (s.lng - refLon) * DEG_TO_MILES * Math.cos(refLat * Math.PI / 180))
        }))
        .sort((a, b) => a.dist - b.dist);
    }

    if (allStations.length === 0) return { tooFar: true };

    // --- Try nearest stations until predictions come back successfully ---
    // Fetches TWO products in parallel for each station:
    //   interval=h    → hourly heights for the line graph
    //   interval=hilo → exact high/low events with precise times for the table
    // Some subordinate stations lack harmonic constituents and return errors on both.
    // We try up to 10 nearest; if all fail, expand to 20.
    async function tryStation(station) {
      return Sentry.startSpan(
        { op: "http.client", name: `NOAA: tide predictions (${station.id})` },
        async () => {
      try {
        const baseParams = `begin_date=${beginDate}&end_date=${endDate}&station=${station.id}` +
          `&product=predictions&datum=MLLW&time_zone=lst_ldt&units=english&application=fishing_app&format=json`;
        const baseUrl = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?";

        const [rHourly, rHiLo] = await Promise.all([
          timedFetch(baseUrl + baseParams + "&interval=h",    10000),
          timedFetch(baseUrl + baseParams + "&interval=hilo", 10000),
        ]);

        const jHourly = await rHourly.json();
        const jHiLo   = await rHiLo.json();

        // Both must succeed for the station to be usable
        if (jHourly.error || !jHourly.predictions || jHourly.predictions.length === 0) return null;
        if (jHiLo.error   || !jHiLo.predictions   || jHiLo.predictions.length === 0)  return null;

        return { hourly: jHourly.predictions, hilo: jHiLo.predictions };
      } catch (_) { return null; }
        }); // end Sentry.startSpan
    }

    let predictions = null;
    let usedStation = null;

    // Try top 10 first, then expand to 20 if all fail
    for (const maxTry of [10, 20]) {
      const candidates = allStations.slice(0, maxTry);
      for (const station of candidates) {
        const preds = await tryStation(station);
        if (preds) {
          predictions = preds;
          usedStation = station;
          break;
        }
      }
      if (predictions) break;
    }

    if (!predictions || !usedStation) return { tooFar: true };

    // --- Process predictions into the shape the app needs ---
    // predictions.hourly: [{ t: "2025/04/11 00:00", v: "0.45" }, ...]
    // predictions.hilo:   [{ t: "2025/04/11 03:24", v: "2.10", type: "H" }, ...]
    const rawHourly = predictions.hourly;
    const rawHiLo   = predictions.hilo;

    // Build today's hourly heights array for the line graph (index = hour 0-23)
    const byDay = {};
    rawHourly.forEach(entry => {
      const day = entry.t.slice(0, 10);
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push(parseFloat(entry.v));
    });
    const dayKeys = Object.keys(byDay).sort();
    const todayKey = dayKeys[0];
    const todayHeights = byDay[todayKey] || [];

    // Build 7-day table using the hilo data — exact times and all H/L events per day.
    // NOAA hilo entries have: { t: "YYYY/MM/DD HH:MM", v: "2.10", type: "H" or "L" }
    // Semidiurnal coasts typically have 4 events per day (H L H L).
    // Diurnal coasts may have fewer. We show all events in chronological order.
    const dailyEvents = dayKeys.slice(0, 7).map(day => {
      const events = rawHiLo
        .filter(e => e.t.startsWith(day))
        .map(e => ({
          time:  e.t.slice(11, 16), // exact "HH:MM" — NOT snapped to hour
          val:   parseFloat(e.v),
          type:  e.type === "H" ? "H" : "L",
        }))
        .sort((a, b) => a.time.localeCompare(b.time)); // chronological order
      return { day, events };
    });

    return {
      tooFar: false,
      stationName: usedStation.name,
      stationId:   usedStation.id,
      distMiles:   Math.round(usedStation.dist),
      todayHeights,
      byDay,
      dailyEvents,   // replaces dailyHiLo
    };
  }

  // ── Fish log: save a new catch record ──────────────────────────────────────
  function saveCatch(entry) {
    const next = [...catches, entry];
    setCatches(next);
    saveCatches(next);
    refreshCatchMarkers(next);
  }

  // ── Fish log: delete one record by id ───────────────────────────────────────
  function deleteCatch(id) {
    const next = catches.filter(c => c.id !== id);
    setCatches(next);
    saveCatches(next);
    refreshCatchMarkers(next);
    // If the list modal is open, refresh it too
    if (catchListModal) {
      const updatedCluster = next.filter(c =>
        Math.abs(c.lat - catchListModal[0]?.lat) < CLUSTER_RADIUS_DEG &&
        Math.abs(c.lon - catchListModal[0]?.lon) < CLUSTER_RADIUS_DEG
      );
      setCatchListModal(updatedCluster.length > 0 ? updatedCluster : null);
    }
  }

  // ── Fish log: rebuild all Leaflet catch markers from catches array ───────────
  // Called after any add/delete, and whenever showCatchMarkers toggles.
  function refreshCatchMarkers(catchArr) {
    if (!leafletMapRef.current) return;
    const L = window.L;
    // Remove old markers
    catchMarkersRef.current.forEach(m => m.remove());
    catchMarkersRef.current = [];
    if (!showCatchMarkers) return;
    // Group into clusters and add one marker per cluster
    const clusters = clusterCatches(catchArr);
    clusters.forEach(cl => {
      const count = cl.catches.length;
      const label = count === 1 ? "🐟" : count <= 10 ? String(count) : "10+";
      const isSingle = count === 1;
      const iconHtml = `<div style="
        background:#0f766e;color:#fff;border:2px solid #5eead4;
        border-radius:50%;width:30px;height:30px;
        display:flex;align-items:center;justify-content:center;
        font-size:${isSingle ? 16 : 13}px;font-weight:bold;
        box-shadow:0 0 6px #0f766e88;cursor:pointer;
      ">${label}</div>`;
      const icon = L.divIcon({ html: iconHtml, className: "", iconAnchor: [15, 15] });
      const marker = L.marker([cl.lat, cl.lon], { icon }).addTo(leafletMapRef.current);
      marker.on("click", () => setCatchListModal(cl.catches));
      catchMarkersRef.current.push(marker);
    });
  }

  // ── Fish log: re-render markers whenever showCatchMarkers or catches changes ─
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { refreshCatchMarkers(catches); }, [showCatchMarkers, mapLoaded]);

  // ── Fish log: get center lat/lon of current Leaflet map view ─────────────────
  function getMapCenter() {
    if (!leafletMapRef.current) return { lat: 0, lon: 0 };
    const c = leafletMapRef.current.getCenter();
    return { lat: c.lat, lon: c.lng };
  }

  async function fetchAllData(lat, lon) {
    setLoading(true); setError(""); setWeather(null); setTides(null); setSst(null); setSelectedDayIdx(0);
    try {
      const [w, t, s] = await Promise.all([
        fetchWeather(lat, lon),
        fetchTides(lat, lon),
        fetchSST(lat, lon),
      ]);
      setWeather(w);
      setTides(t);
      setSst(s);
    } catch (e) { setError("Data fetch error: " + e.message); }
    finally { setLoading(false); }
  }

  // ---- Fetch NOAA active severe weather alerts ----
  // Uses api.weather.gov/alerts/active?point={lat},{lon} — no key required.
  // Returns the highest-severity active alert for the location, or null if none.
  // Polling interval: 5 minutes (300000ms) — NWS updates alerts at most every
  // few minutes; 5min is responsive without over-querying the free API.
  async function fetchWeatherAlerts(lat, lon) {
    try {
      const r = await Sentry.startSpan(
        { op: "http.client", name: "NOAA: weather alerts" },
        () => fetch(
          `https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`,
          { headers: { "User-Agent": "CurrentCast/1.0" } }
        )
      );
      if (!r.ok) { setWeatherAlert(null); return; }
      const j = await r.json();
      const features = j.features || [];
      if (features.length === 0) { setWeatherAlert(null); return; }

      // ── Allowed alert events ─────────────────────────────────────────────────
      // All advisories excluded.
      // Watches: only thunderstorm, tornado, flood, river flood, and coastal flood.
      // Warnings: all except the excluded winter/fire list below.
      // Marine warnings included (Special Marine Warning, etc.).
      const ALLOWED_WATCHES = new Set([
        "Severe Thunderstorm Watch",
        "Tornado Watch",
        "Flash Flood Watch",
        "Flood Watch",
        "River Flood Watch",
        "Coastal Flood Watch",
      ]);

      const EXCLUDED_WARNINGS = new Set([
        "Blizzard Warning",
        "Winter Storm Warning",
        "Ice Storm Warning",
        "Snow Squall Warning",
        "Freeze Warning",
        "Extreme Cold Warning",
        "Red Flag Warning",
      ]);

      // Filter: keep event if it is an allowed watch OR a non-excluded warning
      const filtered = features.filter(f => {
        const ev = (f.properties.event || "").trim();
        if (ALLOWED_WATCHES.has(ev)) return true;           // explicitly allowed watch
        if (ev.endsWith("Watch"))    return false;          // all other watches excluded
        if (ev.endsWith("Advisory")) return false;          // all advisories excluded
        if (ev.endsWith("Statement")) return false;         // statements excluded
        if (EXCLUDED_WARNINGS.has(ev)) return false;       // excluded warning types
        return true;                                        // all remaining warnings kept
      });

      if (filtered.length === 0) { setWeatherAlert(null); return; }

      // Priority: warnings before watches, then by event type for fishing safety
      const PRIORITY = [
        "Tornado Warning",
        "Hurricane Warning","Hurricane Watch",
        "Tropical Storm Warning","Tropical Storm Watch",
        "Storm Surge Warning","Storm Surge Watch",
        "Severe Thunderstorm Warning",
        "Flash Flood Warning",
        "Flood Warning","River Flood Warning",
        "Coastal Flood Warning",
        "Special Marine Warning",
        "High Wind Warning",
        "Tornado Watch",
        "Severe Thunderstorm Watch",
        "Flash Flood Watch",
        "Flood Watch","River Flood Watch",
        "Coastal Flood Watch",
      ];

      const sorted = filtered.slice().sort((a, b) => {
        const ai = PRIORITY.indexOf(a.properties.event);
        const bi = PRIORITY.indexOf(b.properties.event);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      });

      const best = sorted[0].properties;
      // Determine if this is a watch (yellow) or warning (red)
      const isWatch = (best.event || "").endsWith("Watch");

      setWeatherAlert({
        event:       best.event || "Weather Alert",
        headline:    best.headline || best.event || "Active weather alert",
        description: best.description || "",
        instruction: best.instruction || "",
        expires:     best.ends || best.expires || null,
        areaDesc:    best.areaDesc || "",
        isWatch,
      });
    } catch (_) {
      // Network error — leave existing alert state unchanged so banner persists
    }
  }

  // ---- Poll for weather alerts — foreground only ----
  // Uses the standard browser visibilitychange event which fires in Capacitor's
  // WebView when the user backgrounds or restores the app — no extra packages needed.
  // Polling pauses when the page/app is hidden and resumes (with an immediate fetch)
  // when it becomes visible again. This prevents background network calls entirely.
  useEffect(() => {
    if (!location) return;

    const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

    function startPolling() {
      if (alertIntervalRef.current) clearInterval(alertIntervalRef.current);
      alertIntervalRef.current = setInterval(() => {
        fetchWeatherAlerts(location.lat, location.lon);
      }, INTERVAL_MS);
    }

    function stopPolling() {
      if (alertIntervalRef.current) {
        clearInterval(alertIntervalRef.current);
        alertIntervalRef.current = null;
      }
    }

    function handleVisibility() {
      if (document.hidden) {
        stopPolling();
      } else {
        // Returned to foreground — fetch fresh data immediately then restart timer
        fetchWeatherAlerts(location.lat, location.lon);
        startPolling();
      }
    }

    // Fetch immediately on location change, then start polling
    fetchWeatherAlerts(location.lat, location.lon);
    startPolling();

    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [location]);

  // ---- Fetch Sea Surface Temperature from Open-Meteo Marine API (no key needed) ----
  // Strategy:
  //   1. Try the exact lat/lon first. The marine API only has data over ocean — if the
  //      location is on land it returns an error or all-null values.
  //   2. If that fails or returns nulls, search outward in ~1-mile steps up to 5 miles
  //      in the 8 cardinal/intercardinal directions for the nearest ocean point.
  //   3. If nothing valid is found within 5 miles, return { tooFar: true }.
  //   4. Convert °C → °F before returning.
  async function fetchSST(lat, lon) {
    const MILES_TO_DEG = 1 / 69.0; // ~1 degree lat ≈ 69 miles
    const MAX_MILES = 5;
    const STEP_MILES = 1;

    // Directions to search: N, NE, E, SE, S, SW, W, NW
    const dirs = [
      [1, 0], [1, 1], [0, 1], [-1, 1],
      [-1, 0], [-1, -1], [0, -1], [1, -1],
    ];

    async function tryPoint(tlat, tlon) {
      return Sentry.startSpan(
        { op: "http.client", name: "Open-Meteo: sea surface temperature" },
        async () => {
          try {
            const url = `https://marine-api.open-meteo.com/v1/marine` +
              `?latitude=${tlat.toFixed(4)}&longitude=${tlon.toFixed(4)}` +
              `&hourly=sea_surface_temperature&temperature_unit=fahrenheit&timezone=auto&forecast_days=7`;
            const r = await fetch(url);
            if (!r.ok) return null;
            const j = await r.json();
            if (j.error) return null;
            const vals = j.hourly?.sea_surface_temperature;
            if (!vals || vals.every(v => v === null)) return null;
            // Return today's 24 hourly values (first 24 entries)
            return vals.slice(0, 24);
          } catch (_) { return null; }
        }
      );
    }

    // Step 1: try exact location
    const exact = await tryPoint(lat, lon);
    if (exact) return { hourly: exact, tooFar: false, offsetMiles: 0 };

    // Step 2: search outward up to MAX_MILES in all 8 directions
    for (let miles = STEP_MILES; miles <= MAX_MILES; miles += STEP_MILES) {
      const deg = miles * MILES_TO_DEG;
      // Try all 8 directions at this distance simultaneously
      const attempts = await Promise.all(
        dirs.map(([dlat, dlon]) => {
          const mag = Math.hypot(dlat, dlon);
          return tryPoint(lat + (dlat / mag) * deg, lon + (dlon / mag) * deg);
        })
      );
      const found = attempts.find(a => a !== null);
      if (found) return { hourly: found, tooFar: false, offsetMiles: miles };
    }

    // Step 3: nothing within 5 miles — location is too far inland
    return { tooFar: true };
  }

  // ---- Process weather data for display ----
  const processedWeather = weather ? (() => {
    const d = weather.daily;
    const h = weather.hourly;
    const days = d.time.map((date, i) => {
      const dayStart = h.time.findIndex(t => t.startsWith(date));
      const hourSlice    = dayStart >= 0 ? h.time.slice(dayStart, dayStart + 24) : [];
      const tempSlice    = dayStart >= 0 ? h.temperature_2m.slice(dayStart, dayStart + 24) : [];
      const rainProbSlice= dayStart >= 0 ? h.precipitation_probability.slice(dayStart, dayStart + 24) : [];
      const precipSlice  = dayStart >= 0 ? h.precipitation.slice(dayStart, dayStart + 24) : [];
      const baroSlice    = dayStart >= 0 ? h.surface_pressure.slice(dayStart, dayStart + 24) : [];
      const windSlice    = dayStart >= 0 ? h.windspeed_10m.slice(dayStart, dayStart + 24) : [];
      const cloudSlice   = dayStart >= 0 ? (h.cloudcover || []).slice(dayStart, dayStart + 24) : [];

      // Pressure trend: difference from 3 hours ago (positive = rising, negative = falling)
      const baroTrendSlice = baroSlice.map((baro, j) => {
        const lookback = 3;
        const prevIdx = dayStart + j - lookback;
        if (prevIdx < 0 || !h.surface_pressure[prevIdx]) return null;
        return baro - h.surface_pressure[prevIdx];
      });

      return {
        date, wcode: d.weathercode[i],
        high: d.temperature_2m_max[i], low: d.temperature_2m_min[i],
        precip: d.precipitation_sum[i], rainProb: d.precipitation_probability_max[i],
        sunrise: d.sunrise[i]?.slice(11, 16), sunset: d.sunset[i]?.slice(11, 16),
        windMax: d.windspeed_10m_max[i],
        cloudAvg: cloudSlice.length ? Math.round(cloudSlice.reduce((a, b) => a + (b || 0), 0) / cloudSlice.length) : null,
        hours: hourSlice.map((t, j) => ({
          time: t.slice(11, 16),
          temp: tempSlice[j], rain: rainProbSlice[j],
          precip: precipSlice[j], baro: baroSlice[j], wind: windSlice[j],
          cloud: cloudSlice[j],
          baroTrend: baroTrendSlice[j],
        })),
        tempHours: tempSlice,
        windHours: windSlice,
        baroHours: baroSlice,
        cloudHours: cloudSlice,
      };
    });
    return days;
  })() : null;

  // ---- Process tide data ----
  // fetchTides now returns the processed shape directly.
  // processedTides simply passes it through, maintaining null when not yet loaded.
  const processedTides = tides || null;

  // ---- Fishing scores for ALL days ----
  // allDayFishScores[dayIdx] = array of 24 hourly scores for that day.
  // Tide direction only available for today (index 0) — other days use "unknown".
  const allDayFishScores = processedWeather ? processedWeather.map((dayData, dayIdx) => {
    const tideHeights = (dayIdx === 0 && processedTides && !processedTides.tooFar)
      ? processedTides.todayHeights : [];
    const tideDirs = calcTideDirections(tideHeights);
    const moonPct = lunarPhaseForDay(dayData.date).pct;
    const sstHourly = (dayIdx === 0 && sst && !sst.tooFar && sst.hourly) ? sst.hourly : null;
    const sstAvg = sstHourly
      ? sstHourly.filter(v => v != null).reduce((a, b, _, arr) => a + b / arr.length, 0)
      : null;
    return dayData.hours.map((h, i) => fishingScore({
      moonPct,
      baroHpa: h.baro,
      baroTrend: h.baroTrend,
      windMph: h.wind,
      tideDir: tideDirs[i] || "unknown",
      hour: parseInt(h.time),
      waterTempF: sstHourly ? (sstHourly[i] ?? sstAvg) : null,
      cloudCover: h.cloud,
    }));
  }) : null;
  // Convenience alias — scores for the currently selected day
  const fishScores = allDayFishScores ? allDayFishScores[selectedDayIdx] : null;

  const wCodes = {
    0:"Clear",1:"Mostly Clear",2:"Partly Cloudy",3:"Overcast",
    45:"Foggy",48:"Icy Fog",51:"Light Drizzle",53:"Drizzle",55:"Heavy Drizzle",
    61:"Light Rain",63:"Rain",65:"Heavy Rain",71:"Light Snow",73:"Snow",75:"Heavy Snow",
    80:"Showers",81:"Heavy Showers",82:"Violent Showers",
    95:"Thunderstorm",96:"Thunderstorm+Hail",99:"Severe Thunderstorm",
  };
  const wIcon = (c) => {
    if (c === 0) return "☀️"; if (c <= 2) return "🌤️"; if (c <= 3) return "☁️";
    if (c <= 48) return "🌫️"; if (c <= 67) return "🌧️"; if (c <= 77) return "❄️";
    if (c <= 82) return "🌦️"; return "⛈️";
  };

  const moonToday = lunarPhase(new Date());
  // Current local hour (0-23) — used to mark the current time on all graphs and the hourly modal
  const nowHour = new Date().getHours();

  // ============================================================
  // RENDER
  // ============================================================
  return (
    <div style={{
      fontFamily: "'Share Tech Mono', monospace",
      background: "#020a14",
      color: "#cbd5e1",
      minHeight: "100vh",
      width: "100%",
      position: "relative",
      display: "flex",
      flexDirection: "column",
    }}>
      {/* Google Fonts */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=Share+Tech+Mono&display=swap');
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: #0f172a; }
        ::-webkit-scrollbar-thumb { background: #0ea5e944; border-radius: 4px; }
        * { box-sizing: border-box; }
        input { outline: none; }
        button { cursor: pointer; }

        /* ── Responsive tile grid ── */
        .tile-grid {
          padding: 10px 14px 80px;
          display: grid;
          grid-template-columns: 1fr;
          gap: 12px;
        }
        /* Landscape: two-column tile layout when wide enough */
        @media (min-width: 600px) {
          .tile-grid { grid-template-columns: 1fr 1fr; padding: 10px 20px 80px; }
        }
        @media (min-width: 900px) {
          .tile-grid { grid-template-columns: 1fr 1fr 1fr; padding: 10px 24px 80px; }
        }

        /* ── Responsive horizontal padding ── */
        .app-hpad { padding-left: 14px; padding-right: 14px; }
        @media (min-width: 600px) { .app-hpad { padding-left: 20px; padding-right: 20px; } }
        @media (min-width: 900px) { .app-hpad { padding-left: 24px; padding-right: 24px; } }

        /* ── Date strip: single scrollable row; cards grow to fill available width ── */
        .day-strip-scroll {
          display: flex;
          flex-wrap: nowrap;
          overflow-x: auto;
          justify-content: flex-start;
          -webkit-overflow-scrolling: touch;
          scrollbar-width: none;
        }
        .day-strip-scroll::-webkit-scrollbar { display: none; }
        /* Cards grow evenly to fill container; minWidth prevents them collapsing too small */
        .day-strip-scroll > button { flex: 1 0 58px; }

        /* ── Compact header in landscape on short screens ── */
        @media (max-height: 500px) and (orientation: landscape) {
          .header-search { display: none; }
          .header-title-row { margin-bottom: 4px; }
        }

        /* ── Fill OS letterbox / safe-area with app background ── */
        html, body {
          background: #020a14;
          margin: 0; padding: 0;
        }
        /* Cover safe-area insets on notched/punch-hole screens */
        #root, body > div:first-child {
          background: #020a14;
        }
        /* ── Fish log: force light text on dark background for ALL native inputs ── */
        /* Android WebView overrides color on <select> options and time spinners.   */
        /* We replace both with custom components, but this is a belt+suspenders    */
        /* fallback in case the system still renders native chrome.                 */
        select, select option {
          color: #e2e8f0 !important;
          background: #1e293b !important;
        }
        input[type="time"], input[type="date"] {
          color-scheme: dark;
          color: #e2e8f0 !important;
        }
        input[type="number"]::-webkit-inner-spin-button,
        input[type="number"]::-webkit-outer-spin-button {
          opacity: 0.4;
        }
      `}</style>
      {/* Theme colour — tints Android status bar and nav bar in WebView */}
      <meta name="theme-color" content="#020a14" />

      {/* Header */}
      <div style={{
        background: "linear-gradient(90deg, #020a14, #0c1a2e)",
        borderBottom: "1px solid #0ea5e933",
        padding: "10px 16px 0",
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div className="header-title-row" style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <span style={{ fontSize: 22 }}>🎣</span>
          <div>
            <div style={{ fontFamily: "'Orbitron', monospace", fontSize: 13, color: "#38bdf8", letterSpacing: 2 }}>CURRENTCAST</div>
            {location && <div style={{ fontSize: 10, color: "#475569", marginTop: 1 }}>📍 {location.name}</div>}
          </div>
        </div>

        {/* Search bar */}
        <div className="header-search" style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSearch()}
            placeholder="City, ZIP, address…"
            style={{
              flex: 1, background: "#0f172a", border: "1px solid #0ea5e933",
              borderRadius: 8, padding: "7px 10px", color: "#e2e8f0",
              fontFamily: "'Share Tech Mono', monospace", fontSize: 12,
            }}
          />
          <button onClick={handleSearch} style={{
            background: "#0ea5e9", border: "none", borderRadius: 8,
            padding: "7px 12px", color: "#fff", fontSize: 13,
          }}>🔍</button>
          <button onClick={useCurrentLocation} style={{
            background: "#0f172a", border: "1px solid #0ea5e933",
            borderRadius: 8, padding: "7px 10px", fontSize: 14,
          }} title="Use current location">📍</button>
          {location && <button onClick={() => setSaveModalOpen(true)} style={{
            background: "#0f172a", border: "1px solid #0ea5e933",
            borderRadius: 8, padding: "7px 10px", fontSize: 14,
          }} title="Save location">⭐</button>}
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 2 }}>
          {["map", "details"].map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              flex: 1, padding: "7px 0",
              background: tab === t ? "#0ea5e9" : "transparent",
              border: "none", borderRadius: "8px 8px 0 0",
              color: tab === t ? "#fff" : "#475569",
              fontFamily: "'Orbitron', monospace", fontSize: 11, letterSpacing: 1,
              textTransform: "uppercase",
            }}>{t === "map" ? "🗺 Map" : "📊 Forecast"}</button>
          ))}
        </div>
      </div>

      {/* Status bar */}
      {(loading || error) && (
        <div style={{ padding: "6px 16px", background: loading ? "#0c1a2e" : "#1c0a0a", fontSize: 11, color: loading ? "#38bdf8" : "#f87171" }}>
          {loading ? "⏳ Loading data…" : `⚠️ ${error}`}
        </div>
      )}

      {/* ===================== SEVERE WEATHER ALERT BANNER ===================== */}
      {weatherAlert && (() => {
        // Format expiry time as 12h
        let expiryStr = "";
        if (weatherAlert.expires) {
          try {
            const exp = new Date(weatherAlert.expires);
            const h = exp.getHours(), m = exp.getMinutes();
            const period = h < 12 ? "a.m." : "p.m.";
            const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
            expiryStr = ` UNTIL ${h12}:${String(m).padStart(2, "0")} ${period}`;
          } catch (_) {}
        }
        return (
          <>
            {/* Colour palette: red for warnings, amber/yellow for watches */}
            {(() => {
              const isWatch = weatherAlert.isWatch;
              const bannerBg   = isWatch ? "linear-gradient(90deg, #78350f, #92400e)" : "linear-gradient(90deg, #7f1d1d, #991b1b)";
              const borderClr  = isWatch ? "#f59e0b" : "#ef4444";
              const textClr    = isWatch ? "#fde68a" : "#fca5a5";
              const subtleClr  = isWatch ? "#fde68a66" : "#fca5a566";
              const modalBg    = isWatch ? "#1c1204"  : "#1c0a0a";
              const hdClr      = isWatch ? "#f59e0b"  : "#ef4444";
              const bodyClr    = isWatch ? "#fde68acc": "#fca5a5cc";
              const btnBg      = isWatch ? "#f59e0b22": "#ef444422";
              const btnBorder  = isWatch ? "#f59e0b44": "#ef444444";
              const icon       = isWatch ? "🟡" : "⚠️";
              return (
                <>
                  {/* Banner */}
                  <div onClick={() => setAlertModalOpen(true)} style={{
                    background: bannerBg, borderBottom: `2px solid ${borderClr}`,
                    padding: "0 16px", cursor: "pointer", userSelect: "none", flexShrink: 0,
                  }}>
                    <div style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      paddingTop: 8, paddingBottom: 4,
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 18, flexShrink: 0 }}>{icon}</span>
                        <span style={{
                          fontFamily: "'Orbitron', monospace", fontSize: 11,
                          color: textClr, fontWeight: 700, letterSpacing: 0.8,
                          textTransform: "uppercase",
                        }}>
                          {weatherAlert.event.toUpperCase()}{expiryStr}
                        </span>
                      </div>
                      <span style={{ fontSize: 10, color: subtleClr, whiteSpace: "nowrap", paddingLeft: 8 }}>
                        Tap for details ›
                      </span>
                    </div>
                    {weatherAlert.areaDesc && (
                      <div style={{ fontSize: 10, color: subtleClr, paddingBottom: 8 }}>
                        📍 {weatherAlert.areaDesc}
                      </div>
                    )}
                  </div>

                  {/* Alert detail modal */}
                  {alertModalOpen && (
                    <div style={{
                      position: "fixed", inset: 0, background: "#000c", zIndex: 10500,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      padding: "0 16px",
                    }} onClick={() => setAlertModalOpen(false)}>
                      <div style={{
                        background: modalBg, border: `1.5px solid ${borderClr}`,
                        borderRadius: 16, padding: 20, width: "100%", maxWidth: 560,
                        maxHeight: "80vh", overflowY: "auto",
                      }} onClick={e => e.stopPropagation()}>

                        {/* Header */}
                        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 14 }}>
                          <span style={{ fontSize: 26, flexShrink: 0 }}>{icon}</span>
                          <div>
                            <div style={{
                              fontFamily: "'Orbitron', monospace", fontSize: 13,
                              color: hdClr, fontWeight: 700, letterSpacing: 0.5,
                              textTransform: "uppercase", lineHeight: 1.3,
                            }}>{weatherAlert.event}</div>
                            {weatherAlert.areaDesc && (
                              <div style={{ fontSize: 11, color: textClr, marginTop: 4 }}>
                                📍 {weatherAlert.areaDesc}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Headline */}
                        <div style={{
                          background: `${hdClr}22`, border: `1px solid ${hdClr}33`,
                          borderRadius: 8, padding: "10px 12px", marginBottom: 14,
                          fontSize: 13, color: textClr, lineHeight: 1.5, fontWeight: "bold",
                        }}>{weatherAlert.headline}</div>

                        {/* Expiry */}
                        {weatherAlert.expires && (
                          <div style={{ fontSize: 11, color: subtleClr, marginBottom: 12 }}>
                            ⏱ Expires: {new Date(weatherAlert.expires).toLocaleString("en", {
                              weekday: "short", month: "short", day: "numeric",
                              hour: "numeric", minute: "2-digit", hour12: true,
                            })}
                          </div>
                        )}

                        {/* Description */}
                        {weatherAlert.description && (
                          <div style={{ marginBottom: 14 }}>
                            <div style={{
                              fontSize: 10, color: hdClr, fontFamily: "'Orbitron', monospace",
                              letterSpacing: 1, marginBottom: 6,
                            }}>WHAT</div>
                            <div style={{ fontSize: 12, color: bodyClr, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                              {weatherAlert.description}
                            </div>
                          </div>
                        )}

                        {/* Instructions */}
                        {weatherAlert.instruction && (
                          <div style={{ marginBottom: 14 }}>
                            <div style={{
                              fontSize: 10, color: hdClr, fontFamily: "'Orbitron', monospace",
                              letterSpacing: 1, marginBottom: 6,
                            }}>WHAT TO DO</div>
                            <div style={{ fontSize: 12, color: bodyClr, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                              {weatherAlert.instruction}
                            </div>
                          </div>
                        )}

                        {/* Close */}
                        <button onClick={() => setAlertModalOpen(false)} style={{
                          marginTop: 4, width: "100%", padding: "10px 0",
                          background: btnBg, border: `1px solid ${btnBorder}`,
                          borderRadius: 8, color: hdClr,
                          fontFamily: "'Orbitron', monospace", fontSize: 12, cursor: "pointer",
                        }}>CLOSE</button>
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
          </>
        );
      })()}

      {/* ===================== MAP — always rendered, hidden when on Details tab ===================== */}
      {/* BUG FIX: never unmount this div — Leaflet must keep its DOM node alive */}
      <div style={{ flex: 1, position: "relative", display: tab === "map" ? "block" : "none", minHeight: 0 }}>
        <div ref={mapRef} style={{ position: "absolute", inset: 0, minHeight: 300 }} />

        {!mapLoaded && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "#020a14" }}>
            <div style={{ color: "#38bdf8", fontFamily: "'Orbitron', monospace", fontSize: 13 }}>LOADING MAP…</div>
          </div>
        )}

        {/* ── Fish log FAB — lower-right corner of map ── */}
        {logPhase === "idle" && (
          <div style={{
            position: "absolute", bottom: 54, right: 12, zIndex: 1100,
            background: "#0f172af0", border: "1px solid #0f766e66",
            borderRadius: 12, padding: "8px 10px",
            display: "flex", alignItems: "center", gap: 10,
            boxShadow: "0 2px 12px #0f766e44",
          }}>
            {/* Marker visibility toggle */}
            <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", fontSize: 11, color: "#5eead4" }}>
              <input
                type="checkbox"
                checked={showCatchMarkers}
                onChange={e => setShowCatchMarkers(e.target.checked)}
                style={{ accentColor: "#0f766e", width: 14, height: 14 }}
              />
              <span>Show</span>
            </label>
            {/* Log a catch button */}
            <button
              onClick={() => setLogPhase("placing")}
              title="Log a caught fish"
              style={{
                background: "#0f766e", border: "none", borderRadius: 8,
                padding: "7px 10px", fontSize: 20, cursor: "pointer",
                lineHeight: 1, boxShadow: "0 0 8px #0f766e88",
              }}
            >🐟</button>
          </div>
        )}

        {/* ── Crosshair overlay — shown while user is positioning the catch ── */}
        {logPhase === "placing" && (
          <div style={{
            position: "absolute", inset: 0, zIndex: 1200,
            pointerEvents: "none", // map still scrollable underneath
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            {/* Crosshair lines */}
            <div style={{ position: "relative", width: 60, height: 60 }}>
              <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 2, background: "#5eead4", opacity: 0.9, transform: "translateX(-50%)" }} />
              <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 2, background: "#5eead4", opacity: 0.9, transform: "translateY(-50%)" }} />
              <div style={{
                position: "absolute", top: "50%", left: "50%",
                transform: "translate(-50%,-50%)",
                width: 14, height: 14, borderRadius: "50%",
                border: "2px solid #5eead4", background: "#0f766ecc",
              }} />
            </div>
          </div>
        )}

        {/* ── Confirm Location prompt — shown while placing ── */}
        {logPhase === "placing" && (
          <div style={{
            position: "absolute", bottom: 54, left: "50%", transform: "translateX(-50%)",
            zIndex: 1300, background: "#0f172af5",
            border: "1px solid #0f766e88", borderRadius: 12,
            padding: "10px 16px", display: "flex", flexDirection: "column",
            alignItems: "center", gap: 8, minWidth: 220,
            boxShadow: "0 4px 20px #00000088",
          }}>
            <div style={{ fontFamily: "'Orbitron', monospace", fontSize: 13, color: "#5eead4", letterSpacing: 1 }}>
              LOG A CATCH 🐟
            </div>
            <div style={{ fontFamily: "'Orbitron', monospace", fontSize: 10, color: "#94a3b8", letterSpacing: 1 }}>
              CONFIRM LOCATION?
            </div>
            <div style={{ fontSize: 10, color: "#64748b" }}>Pan map to adjust pin position</div>
            <div style={{ display: "flex", gap: 8, width: "100%" }}>
              <button
                onClick={() => setLogPhase("idle")}
                style={{ flex: 1, padding: "8px 0", background: "transparent", border: "1px solid #334155", borderRadius: 8, color: "#64748b", fontFamily: "'Orbitron', monospace", fontSize: 11, cursor: "pointer" }}
              >CANCEL</button>
              <button
                onClick={() => {
                  const center = getMapCenter();
                  const now = new Date();
                  const nowH24 = now.getHours();
                  const nowMin = now.getMinutes();
                  const initIsPm = nowH24 >= 12;
                  const initH12 = nowH24 === 0 ? 12 : nowH24 > 12 ? nowH24 - 12 : nowH24;
                  const dateStr = now.toLocaleDateString("en-CA"); // YYYY-MM-DD
                  const [dY, dM, dD] = dateStr.split("-");
                  setCatchForm({
                    lat: center.lat, lon: center.lon,
                    date: dateStr,
                    time: `${padMin(nowH24)}:${padMin(nowMin)}`,
                    // Raw display strings — date
                    _dYYYY: dY, _dMM: String(parseInt(dM)), _dDD: String(parseInt(dD)),
                    // Raw display strings — time
                    _hRaw: String(initH12),
                    _mRaw: padMin(nowMin),
                    _isPm: initIsPm,
                    saltwater: true,
                    fish: "",
                    other: "",
                    length: "",
                    weight: "",
                    logWeather: !!(processedWeather),
                  });
                  setLogPhase("form");
                }}
                style={{ flex: 1, padding: "8px 0", background: "#0f766e", border: "none", borderRadius: 8, color: "#fff", fontFamily: "'Orbitron', monospace", fontSize: 11, cursor: "pointer" }}
              >OK</button>
            </div>
          </div>
        )}

        {/* ── Log Form Modal ── */}
        {logPhase === "form" && catchForm && (
          <div style={{
            position: "fixed", inset: 0, background: "#000b", zIndex: 10600,
            display: "flex", alignItems: "flex-end", justifyContent: "center",
          }} onClick={() => { setLogPhase("idle"); setCatchForm(null); }}>
            <div style={{
              background: "#0f172a", border: "1px solid #0f766e44",
              borderRadius: "18px 18px 0 0", padding: 20,
              width: "100%", maxWidth: 560, maxHeight: "88vh", overflowY: "auto",
            }} onClick={e => e.stopPropagation()}>

              <div style={{ fontFamily: "'Orbitron', monospace", color: "#5eead4", fontSize: 13, marginBottom: 16 }}>
                LOG A CATCH 🐟
              </div>

              {/* Location */}
              <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 12 }}>
                📍 {catchForm.lat.toFixed(5)}, {catchForm.lon.toFixed(5)}
              </div>

              {/* ── Date and Time — compact fixed-width fields, side-by-side ─────────── */}
              <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "flex-start" }}>

                {/* DATE column */}
                <div style={{ flex: "0 0 auto" }}>
                  <div style={{ fontSize: 10, color: "#64748b", marginBottom: 6 }}>DATE</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                    {/* MM */}
                    <div>
                      <div style={{ fontSize: 8, color: "#475569", textAlign: "center", marginBottom: 2 }}>MM</div>
                      <input type="text" inputMode="numeric" maxLength={2}
                        value={catchForm._dMM !== undefined ? catchForm._dMM : (catchForm.date || "").split("-")[1] || ""}
                        onChange={e => {
                          const v = e.target.value.replace(/[^0-9]/g, "").slice(0, 2);
                          const [y,,d] = (catchForm.date || "--").split("-");
                          const mo = v ? String(Math.min(12, Math.max(1, parseInt(v)))).padStart(2,"0") : "01";
                          setCatchForm(f => ({ ...f, _dMM: v, date: `${y||f._dYYYY||"2025"}-${mo}-${d||f._dDD||"01"}` }));
                        }}
                        placeholder="MM"
                        style={{ width: 42, background: "#1e293b", border: "1px solid #334155", borderRadius: 6, padding: "5px 2px", color: "#e2e8f0", fontFamily: "'Share Tech Mono', monospace", fontSize: 12, textAlign: "center" }}
                      />
                    </div>
                    <span style={{ color: "#334155", fontSize: 13, marginTop: 10, flexShrink: 0 }}>/</span>
                    {/* DD */}
                    <div>
                      <div style={{ fontSize: 8, color: "#475569", textAlign: "center", marginBottom: 2 }}>DD</div>
                      <input type="text" inputMode="numeric" maxLength={2}
                        value={catchForm._dDD !== undefined ? catchForm._dDD : (catchForm.date || "").split("-")[2] || ""}
                        onChange={e => {
                          const v = e.target.value.replace(/[^0-9]/g, "").slice(0, 2);
                          const [y,mo] = (catchForm.date || "--").split("-");
                          const dd = v ? String(Math.min(31, Math.max(1, parseInt(v)))).padStart(2,"0") : "01";
                          setCatchForm(f => ({ ...f, _dDD: v, date: `${y||f._dYYYY||"2025"}-${mo||f._dMM||"01"}-${dd}` }));
                        }}
                        placeholder="DD"
                        style={{ width: 42, background: "#1e293b", border: "1px solid #334155", borderRadius: 6, padding: "5px 2px", color: "#e2e8f0", fontFamily: "'Share Tech Mono', monospace", fontSize: 12, textAlign: "center" }}
                      />
                    </div>
                    <span style={{ color: "#334155", fontSize: 13, marginTop: 10, flexShrink: 0 }}>/</span>
                    {/* YYYY */}
                    <div>
                      <div style={{ fontSize: 8, color: "#475569", textAlign: "center", marginBottom: 2 }}>YYYY</div>
                      <input type="text" inputMode="numeric" maxLength={4}
                        value={catchForm._dYYYY !== undefined ? catchForm._dYYYY : (catchForm.date || "").split("-")[0] || ""}
                        onChange={e => {
                          const v = e.target.value.replace(/[^0-9]/g, "").slice(0, 4);
                          const [,mo,d] = (catchForm.date || "--").split("-");
                          const yr = v.length === 4 ? v : (catchForm._dYYYY || "2025");
                          setCatchForm(f => ({ ...f, _dYYYY: v, date: `${yr}-${mo||f._dMM||"01"}-${d||f._dDD||"01"}` }));
                        }}
                        placeholder="YYYY"
                        style={{ width: 58, background: "#1e293b", border: "1px solid #334155", borderRadius: 6, padding: "5px 2px", color: "#e2e8f0", fontFamily: "'Share Tech Mono', monospace", fontSize: 12, textAlign: "center" }}
                      />
                    </div>
                  </div>
                </div>

                {/* TIME column */}
                <div style={{ flex: "0 0 auto" }}>
                  <div style={{ fontSize: 10, color: "#64748b", marginBottom: 6 }}>TIME</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                    {/* Hour */}
                    <div>
                      <div style={{ fontSize: 8, color: "#475569", textAlign: "center", marginBottom: 2 }}>HR</div>
                      <input type="text" inputMode="numeric" maxLength={2}
                        value={catchForm._hRaw !== undefined ? catchForm._hRaw : "12"}
                        onChange={e => {
                          const v = e.target.value.replace(/[^0-9]/g, "").slice(0, 2);
                          const hv = v === "" ? 12 : Math.min(12, Math.max(1, parseInt(v) || 1));
                          const pm = catchForm._isPm || false;
                          let h24 = hv % 12; if (pm) h24 += 12;
                          const mv = parseInt(catchForm._mRaw) || 0;
                          setCatchForm(f => ({ ...f, _hRaw: v, time: `${padMin(h24)}:${padMin(mv)}` }));
                        }}
                        placeholder="12"
                        style={{ width: 42, background: "#1e293b", border: "1px solid #334155", borderRadius: 6, padding: "5px 2px", color: "#e2e8f0", fontFamily: "'Share Tech Mono', monospace", fontSize: 13, textAlign: "center" }}
                      />
                    </div>
                    <span style={{ color: "#5eead4", fontSize: 14, marginTop: 10, fontWeight: "bold", flexShrink: 0 }}>:</span>
                    {/* Minute */}
                    <div>
                      <div style={{ fontSize: 8, color: "#475569", textAlign: "center", marginBottom: 2 }}>MIN</div>
                      <input type="text" inputMode="numeric" maxLength={2}
                        value={catchForm._mRaw !== undefined ? catchForm._mRaw : "00"}
                        onChange={e => {
                          const v = e.target.value.replace(/[^0-9]/g, "").slice(0, 2);
                          const mv = v === "" ? 0 : Math.min(59, parseInt(v) || 0);
                          const pm = catchForm._isPm || false;
                          const hv = parseInt(catchForm._hRaw) || 12;
                          let h24 = hv % 12; if (pm) h24 += 12;
                          setCatchForm(f => ({ ...f, _mRaw: v, time: `${padMin(h24)}:${padMin(mv)}` }));
                        }}
                        placeholder="00"
                        style={{ width: 42, background: "#1e293b", border: "1px solid #334155", borderRadius: 6, padding: "5px 2px", color: "#e2e8f0", fontFamily: "'Share Tech Mono', monospace", fontSize: 13, textAlign: "center" }}
                      />
                    </div>
                    {/* AM / PM toggle */}
                    <div>
                      <div style={{ fontSize: 8, color: "#475569", textAlign: "center", marginBottom: 2 }}>&nbsp;</div>
                      <button
                        onClick={() => {
                          const pm = !(catchForm._isPm || false);
                          const hv = parseInt(catchForm._hRaw) || 12;
                          let h24 = hv % 12; if (pm) h24 += 12;
                          const mv = parseInt(catchForm._mRaw) || 0;
                          setCatchForm(f => ({ ...f, _isPm: pm, time: `${padMin(h24)}:${padMin(mv)}` }));
                        }}
                        style={{ width: 46, background: (catchForm._isPm || false) ? "#0e7490" : "#1e293b", border: "1px solid #334155", borderRadius: 6, padding: "5px 2px", color: "#e2e8f0", fontFamily: "'Share Tech Mono', monospace", fontSize: 12, cursor: "pointer", fontWeight: "bold" }}
                      >{(catchForm._isPm || false) ? "PM" : "AM"}</button>
                    </div>
                  </div>
                </div>

              </div>

              {/* Saltwater / Freshwater toggle */}
              <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                {[true, false].map(sw => (
                  <button key={sw} onClick={() => setCatchForm(f => ({ ...f, saltwater: sw, fish: "" }))}
                    style={{
                      flex: 1, padding: "8px 0",
                      background: catchForm.saltwater === sw ? (sw ? "#0e7490" : "#166534") : "#1e293b",
                      border: `1px solid ${catchForm.saltwater === sw ? (sw ? "#0ea5e9" : "#22c55e") : "#334155"}`,
                      borderRadius: 8, color: "#e2e8f0", fontSize: 12, cursor: "pointer",
                    }}>{sw ? "🌊 Saltwater" : "🌿 Freshwater"}</button>
                ))}
              </div>

              {/* Fish dropdown — custom component; <select> options render black-on-dark on Android WebView */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: "#64748b", marginBottom: 4 }}>FISH SPECIES <span style={{ color: "#334155" }}>(optional)</span></div>
                <div style={{ position: "relative" }}>
                  {/* Trigger button */}
                  <button
                    onClick={() => setCatchForm(f => ({ ...f, _fishOpen: !f._fishOpen }))}
                    style={{ width: "100%", background: "#1e293b", border: "1px solid #334155", borderRadius: 8, padding: "8px 12px", color: catchForm.fish ? "#e2e8f0" : "#475569", fontFamily: "'Share Tech Mono', monospace", fontSize: 12, textAlign: "left", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>{catchForm.fish || "Select species…"}</span>
                    <span style={{ color: "#475569", fontSize: 10 }}>{catchForm._fishOpen ? "▲" : "▼"}</span>
                  </button>
                  {/* Options list */}
                  {catchForm._fishOpen && (
                    <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 200, background: "#1e293b", border: "1px solid #334155", borderRadius: 8, maxHeight: 180, overflowY: "auto", marginTop: 2, boxShadow: "0 4px 16px #000a" }}>
                      {(catchForm.saltwater ? SW_FISH : FW_FISH).map(f => (
                        <div key={f}
                          onClick={() => setCatchForm(fv => ({ ...fv, fish: f, _fishOpen: false }))}
                          style={{ padding: "10px 12px", color: catchForm.fish === f ? "#5eead4" : "#e2e8f0", background: catchForm.fish === f ? "#0f766e33" : "transparent", cursor: "pointer", fontSize: 12, fontFamily: "'Share Tech Mono', monospace", borderBottom: "1px solid #334155" }}>
                          {f}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Other textbox — only when "Other" selected */}
              {catchForm.fish === "Other" && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 10, color: "#64748b", marginBottom: 4 }}>SPECIFY SPECIES</div>
                  <input value={catchForm.other}
                    onChange={e => setCatchForm(f => ({ ...f, other: e.target.value }))}
                    placeholder="Enter species name…"
                    style={{ width: "100%", background: "#1e293b", border: "1px solid #334155", borderRadius: 8, padding: "7px 10px", color: "#e2e8f0", fontFamily: "'Share Tech Mono', monospace", fontSize: 12 }} />
                </div>
              )}

              {/* Length / Weight row — type="text" decimal keyboard to avoid Android number-input bugs */}
              <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: "#64748b", marginBottom: 4 }}>LENGTH (in)</div>
                  <input type="text" inputMode="decimal" value={catchForm.length}
                    onChange={e => setCatchForm(f => ({ ...f, length: e.target.value.replace(/[^0-9.]/g, "") }))}
                    placeholder="0.0"
                    style={{ width: "100%", background: "#1e293b", border: "1px solid #334155", borderRadius: 8, padding: "7px 10px", color: "#e2e8f0", fontFamily: "'Share Tech Mono', monospace", fontSize: 12 }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: "#64748b", marginBottom: 4 }}>WEIGHT (lbs)</div>
                  <input type="text" inputMode="decimal" value={catchForm.weight}
                    onChange={e => setCatchForm(f => ({ ...f, weight: e.target.value.replace(/[^0-9.]/g, "") }))}
                    placeholder="0.00"
                    style={{ width: "100%", background: "#1e293b", border: "1px solid #334155", borderRadius: 8, padding: "7px 10px", color: "#e2e8f0", fontFamily: "'Share Tech Mono', monospace", fontSize: 12 }} />
                </div>
              </div>

              {/* Log Weather toggle */}
              <label style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, cursor: "pointer" }}>
                <input type="checkbox" checked={catchForm.logWeather}
                  onChange={e => setCatchForm(f => ({ ...f, logWeather: e.target.checked }))}
                  style={{ accentColor: "#0f766e", width: 16, height: 16 }} />
                <div>
                  <div style={{ fontSize: 12, color: "#e2e8f0" }}>Log Weather Conditions</div>
                  <div style={{ fontSize: 10, color: "#475569" }}>
                    {processedWeather ? "Saves current weather snapshot from selected location" : "No weather data loaded — select a location first"}
                  </div>
                </div>
              </label>

              {/* Save / Cancel */}
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => { setLogPhase("idle"); setCatchForm(null); }}
                  style={{ flex: 1, padding: 10, background: "transparent", border: "1px solid #334155", borderRadius: 8, color: "#64748b", fontFamily: "'Orbitron', monospace", fontSize: 11, cursor: "pointer" }}>
                  CANCEL
                </button>
                <button
                  onClick={() => {
                    // All fields optional except location (always set) and date
                    // Snapshot weather if requested and available
                    let wx = null;
                    if (catchForm.logWeather && processedWeather) {
                      const today = processedWeather[0];
                      const h = today.hours[nowHour] || today.hours[0] || {};
                      wx = {
                        temp:   h.temp != null ? Math.round(h.temp) : null,
                        wind:   h.wind != null ? Math.round(h.wind) : null,
                        baro:   h.baro != null ? Math.round(h.baro) : null,
                        cloud:  h.cloud ?? null,
                        wcode:  today.wcode,
                        sst:    (sst && !sst.tooFar && sst.hourly)
                                  ? Math.round(sst.hourly[nowHour] ?? sst.hourly[0]) : null,
                        moon:   moonToday.name,
                        moonIcon: moonToday.icon,
                      };
                    }
                    const entry = {
                      id:        catchId(),
                      lat:       catchForm.lat,
                      lon:       catchForm.lon,
                      date:      catchForm.date,
                      time:      catchForm.time,
                      sw:        catchForm.saltwater,
                      fish:      catchForm.fish === "Other"
                                   ? (catchForm.other.trim() || "Other")
                                   : (catchForm.fish || null),
                      len:       catchForm.length ? parseFloat(catchForm.length) : null,
                      wt:        catchForm.weight ? parseFloat(catchForm.weight) : null,
                      wx,
                    };
                    saveCatch(entry);
                    setLogPhase("idle");
                    setCatchForm(null);
                  }}
                  style={{ flex: 2, padding: 10, background: "#0f766e", border: "none", borderRadius: 8, color: "#fff", fontFamily: "'Orbitron', monospace", fontSize: 11, cursor: "pointer" }}>
                  SAVE CATCH 🐟
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Catch List Modal (cluster tap) ── */}
        {catchListModal && (
          <div style={{
            position: "fixed", inset: 0, background: "#000b", zIndex: 10600,
            display: "flex", alignItems: "flex-end", justifyContent: "center",
          }} onClick={() => { setCatchListModal(null); setCatchDetailEntry(null); }}>
            <div style={{
              background: "#0f172a", border: "1px solid #0f766e44",
              borderRadius: "18px 18px 0 0", padding: 20,
              width: "100%", maxWidth: 560, maxHeight: "75vh", overflowY: "auto",
            }} onClick={e => e.stopPropagation()}>

              {catchDetailEntry ? (
                /* ── Detail card ── */
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                    <button onClick={() => setCatchDetailEntry(null)}
                      style={{ background: "none", border: "none", color: "#5eead4", fontSize: 20, cursor: "pointer", padding: 0 }}>‹</button>
                    <div style={{ fontFamily: "'Orbitron', monospace", color: "#5eead4", fontSize: 12 }}>
                      CATCH DETAILS
                    </div>
                  </div>
                  {/* Core fields */}
                  {[
                    ["Species",  catchDetailEntry.fish || "—"],
                    ["Type",     catchDetailEntry.sw ? "Saltwater 🌊" : "Freshwater 🌿"],
                    ["Date",     catchDetailEntry.date],
                    ["Time",     to12h(catchDetailEntry.time)],
                    ["Location", `${catchDetailEntry.lat.toFixed(5)}, ${catchDetailEntry.lon.toFixed(5)}`],
                    ["Length",   catchDetailEntry.len != null ? `${catchDetailEntry.len} in` : "—"],
                    ["Weight",   catchDetailEntry.wt  != null ? `${catchDetailEntry.wt} lbs` : "—"],
                  ].map(([label, val]) => (
                    <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #1e293b55", fontSize: 12 }}>
                      <span style={{ color: "#64748b" }}>{label}</span>
                      <span style={{ color: "#e2e8f0" }}>{val}</span>
                    </div>
                  ))}
                  {/* Weather snapshot */}
                  {catchDetailEntry.wx && (
                    <div style={{ marginTop: 14 }}>
                      <div style={{ fontFamily: "'Orbitron', monospace", fontSize: 10, color: "#5eead4", letterSpacing: 1, marginBottom: 8 }}>WEATHER AT TIME OF CATCH</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        {catchDetailEntry.wx.temp  != null && <span style={{ fontSize: 11, background: "#1e293b", borderRadius: 6, padding: "4px 8px", color: "#f97316" }}>🌡 {catchDetailEntry.wx.temp}°F</span>}
                        {catchDetailEntry.wx.wind  != null && <span style={{ fontSize: 11, background: "#1e293b", borderRadius: 6, padding: "4px 8px", color: "#22c55e" }}>💨 {catchDetailEntry.wx.wind} mph</span>}
                        {catchDetailEntry.wx.baro  != null && <span style={{ fontSize: 11, background: "#1e293b", borderRadius: 6, padding: "4px 8px", color: "#818cf8" }}>🔵 {catchDetailEntry.wx.baro} hPa</span>}
                        {catchDetailEntry.wx.cloud != null && <span style={{ fontSize: 11, background: "#1e293b", borderRadius: 6, padding: "4px 8px", color: "#a78bfa" }}>☁️ {catchDetailEntry.wx.cloud}%</span>}
                        {catchDetailEntry.wx.sst   != null && <span style={{ fontSize: 11, background: "#1e293b", borderRadius: 6, padding: "4px 8px", color: "#06b6d4" }}>🌊 {catchDetailEntry.wx.sst}°F water</span>}
                        {catchDetailEntry.wx.moon  && <span style={{ fontSize: 11, background: "#1e293b", borderRadius: 6, padding: "4px 8px", color: "#a78bfa" }}>{catchDetailEntry.wx.moonIcon} {catchDetailEntry.wx.moon}</span>}
                      </div>
                    </div>
                  )}
                  <button onClick={() => setCatchDetailEntry(null)}
                    style={{ marginTop: 16, width: "100%", padding: "10px 0", background: "#0f766e22", border: "1px solid #0f766e44", borderRadius: 8, color: "#5eead4", fontFamily: "'Orbitron', monospace", fontSize: 12, cursor: "pointer" }}>
                    BACK TO LIST
                  </button>
                </>
              ) : (
                /* ── List view ── */
                <>
                  <div style={{ fontFamily: "'Orbitron', monospace", color: "#5eead4", fontSize: 12, marginBottom: 14 }}>
                    CATCHES AT THIS SPOT ({catchListModal.length})
                  </div>
                  <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse", color: "#cbd5e1" }}>
                    <thead>
                      <tr style={{ color: "#64748b", borderBottom: "1px solid #1e293b", fontSize: 10 }}>
                        <th style={{ textAlign: "left",  padding: "4px 4px" }}>Date</th>
                        <th style={{ textAlign: "left",  padding: "4px 4px" }}>Time</th>
                        <th style={{ textAlign: "left",  padding: "4px 4px" }}>Fish</th>
                        <th style={{ textAlign: "center",padding: "4px 4px" }}>Len</th>
                        <th style={{ textAlign: "center",padding: "4px 4px" }}>Wt</th>
                        <th style={{ textAlign: "center",padding: "4px 4px" }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...catchListModal].sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)).map(c => (
                        <tr key={c.id} style={{ borderBottom: "1px solid #1e293b22" }}>
                          <td style={{ padding: "6px 4px" }}>{c.date}</td>
                          <td style={{ padding: "6px 4px" }}>{to12h(c.time)}</td>
                          <td style={{ padding: "6px 4px", maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.fish || "—"}</td>
                          <td style={{ padding: "6px 4px", textAlign: "center" }}>{c.len != null ? `${c.len}"` : "—"}</td>
                          <td style={{ padding: "6px 4px", textAlign: "center" }}>{c.wt  != null ? `${c.wt}lb` : "—"}</td>
                          <td style={{ padding: "6px 4px", textAlign: "center", whiteSpace: "nowrap" }}>
                            <button onClick={() => setCatchDetailEntry(c)}
                              style={{ background: "#0f766e33", border: "1px solid #0f766e55", borderRadius: 4, color: "#5eead4", fontSize: 10, padding: "2px 6px", cursor: "pointer", marginRight: 4 }}>
                              Details
                            </button>
                            <button onClick={() => deleteCatch(c.id)}
                              style={{ background: "none", border: "none", color: "#ef444466", fontSize: 14, cursor: "pointer", padding: "0 2px" }}>
                              ✕
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <button onClick={() => setCatchListModal(null)}
                    style={{ marginTop: 16, width: "100%", padding: "10px 0", background: "#0f766e22", border: "1px solid #0f766e44", borderRadius: 8, color: "#5eead4", fontFamily: "'Orbitron', monospace", fontSize: 12, cursor: "pointer" }}>
                    CLOSE
                  </button>
                </>
              )}
            </div>
          </div>
        )}

      </div>

      {/* ===================== DETAILS TAB ===================== */}
      {tab === "details" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflowY: "auto" }}>

          {/* ── No location selected ── */}
          {!location && (
            <div style={{ textAlign: "center", marginTop: 60, color: "#94a3b8", padding: 20 }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>🗺️</div>
              <div style={{ fontFamily: "'Orbitron', monospace", fontSize: 12, color: "#38bdf8" }}>SELECT A LOCATION</div>
              <div style={{ fontSize: 11, marginTop: 6 }}>Search or tap the map to get started</div>
            </div>
          )}

          {location && !weather && !loading && (
            <div style={{ textAlign: "center", marginTop: 40, color: "#94a3b8", fontSize: 12, padding: 20 }}>
              Tap <b style={{ color: "#38bdf8" }}>Reload</b> or re-select location to fetch data.
            </div>
          )}

          {/* ── DATE SELECTOR STRIP ── */}
          {processedWeather && (() => {
            const dayNames = processedWeather.map((day, i) => {
              if (i === 0) return { short: "Today", num: new Date(day.date + "T12:00:00").getDate() };
              const d = new Date(day.date + "T12:00:00");
              return {
                short: d.toLocaleDateString("en", { weekday: "short" }),
                num: d.getDate(),
              };
            });
            return (
              <div className="app-hpad day-strip-scroll" style={{
                gap: 8, paddingTop: 12, paddingBottom: 4,
              }}>
                {processedWeather.map((day, i) => {
                  const active = i === selectedDayIdx;
                  const scores = allDayFishScores ? allDayFishScores[i] : null;
                  const dayBest = scores ? Math.max(...scores) : null;
                  const dotColor = dayBest ? scoreColor(dayBest) : "#475569";
                  return (
                    <button key={i} onClick={() => setSelectedDayIdx(i)} style={{
                      minWidth: 58,
                      background: active
                        ? "linear-gradient(135deg, #0ea5e9, #0284c7)"
                        : "linear-gradient(135deg, #0f172a, #1e293b)",
                      border: active ? "1px solid #38bdf8" : "1px solid #1e293b44",
                      borderRadius: 12,
                      padding: "10px 6px 8px",
                      cursor: "pointer",
                      textAlign: "center",
                      boxShadow: active ? "0 0 14px #0ea5e944" : "none",
                      transition: "all 0.15s",
                    }}>
                      {/* Day name */}
                      <div style={{
                        fontSize: 10, fontFamily: "'Orbitron', monospace",
                        color: active ? "#fff" : "#64748b",
                        letterSpacing: 0.5, marginBottom: 4,
                        textTransform: "uppercase",
                      }}>
                        {dayNames[i].short}
                      </div>
                      {/* Date number — largest element */}
                      <div style={{
                        fontSize: 22, fontWeight: 700,
                        fontFamily: "'Orbitron', monospace",
                        color: active ? "#fff" : "#94a3b8",
                        lineHeight: 1,
                        marginBottom: 6,
                      }}>
                        {dayNames[i].num}
                      </div>
                      {/* Weather icon */}
                      <div style={{ fontSize: 16, marginBottom: 4 }}>{wIcon(day.wcode)}</div>
                      {/* Fishing score dot */}
                      {dayBest !== null && (
                        <div style={{
                          width: 6, height: 6, borderRadius: "50%",
                          background: dotColor, margin: "0 auto",
                        }} />
                      )}
                      {/* High / Low temps */}
                      <div style={{ marginTop: 6, lineHeight: 1.3 }}>
                        <div style={{ fontSize: 11, fontWeight: "bold", color: active ? "#fed7aa" : "#f97316" }}>
                          {fmt(day.high, 0)}°
                        </div>
                        <div style={{ fontSize: 10, color: active ? "#bae6fd" : "#64748b" }}>
                          {fmt(day.low, 0)}°
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            );
          })()}

          {/* ── ALL TILES — keyed to selectedDayIdx ── */}
          {processedWeather && (() => {
            const day = processedWeather[selectedDayIdx];
            const isToday = selectedDayIdx === 0;
            const graphNowIndex = isToday ? nowHour : undefined;
            const moonDay = lunarPhaseForDay(day.date);
            const scores = allDayFishScores ? allDayFishScores[selectedDayIdx] : null;

            // Tide events for selected day
            const tideEventsForDay = processedTides && !processedTides.tooFar && processedTides.dailyEvents
              ? (processedTides.dailyEvents[selectedDayIdx] || processedTides.dailyEvents[0] || null)
              : null;

            // Tide hourly heights: only today's are fetched from NOAA
            const tideHeights = (isToday && processedTides && !processedTides.tooFar)
              ? processedTides.todayHeights : null;

            return (
              <div className="tile-grid">

                {/* ── WEATHER FORECAST TILE ── */}
                <Tile title="Weather Forecast" icon={wIcon(day.wcode)} accent="#38bdf8">
                  {/* Hoist nowH so it's available in both the header and stats grid */}
                  {(() => { const nowH = day.hours[isToday ? nowHour : 12] || day.hours[0] || {};
                    const baroTrendVal = nowH.baroTrend;
                    const trendArrow = baroTrendVal == null ? "—"
                      : baroTrendVal > 0.5 ? "▲ Rising"
                      : baroTrendVal < -0.5 ? "▼ Falling"
                      : "→ Stable";
                    const trendColor = baroTrendVal == null ? "#64748b"
                      : baroTrendVal > 0.5 ? "#22c55e"
                      : baroTrendVal < -0.5 ? "#ef4444"
                      : "#94a3b8";
                  return (<>
                  {/* Condition + current temp */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                    <div>
                      <div style={{ fontSize: 15, color: "#e2e8f0", fontWeight: "bold" }}>
                        {wCodes[day.wcode] || "—"}
                      </div>
                      {day.wcode >= 95 && (
                        <div style={{ fontSize: 11, color: "#ef4444", marginTop: 2 }}>⚡ SEVERE WEATHER</div>
                      )}
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 36, fontWeight: 700, color: "#38bdf8", fontFamily: "'Orbitron', monospace", lineHeight: 1 }}>
                        {fmt(nowH.temp, 0)}°
                      </div>
                      <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 2 }}>
                        {isToday ? "Current temp" : "Midday temp"}
                      </div>
                    </div>
                  </div>

                  {/* Stats grid — uses hoisted nowH, baroTrendVal, trendArrow, trendColor */}
                  {(() => {
                    const stats = [
                      { icon: "🌡️", label: "Hi / Lo", val: `${fmt(day.high, 0)}° / ${fmt(day.low, 0)}°` },
                      { icon: "💧", label: "Rain", val: `${day.rainProb ?? "—"}%` },
                      { icon: "☔", label: "Precip", val: `${fmt(day.precip, 2)}"` },
                      { icon: "🔵", label: "Baro", val: `${fmt(nowH.baro, 0)} hPa` },
                      { icon: "📈", label: "Trend", val: trendArrow, color: trendColor },
                      { icon: "💨", label: "Wind", val: `${fmt(day.windMax, 0)} mph` },
                      { icon: "☁️", label: "Cloud", val: `${day.cloudAvg ?? "—"}%` },
                    ];
                    return (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
                        {stats.map(({ icon, label, val, color }) => (
                          <div key={label} style={{
                            background: "#020a14",
                            border: "1px solid #1e293b",
                            borderRadius: 10,
                            padding: "8px 4px",
                            textAlign: "center",
                          }}>
                            <div style={{ fontSize: 14, marginBottom: 3 }}>{icon}</div>
                            <div style={{ fontSize: 9, color: "#94a3b8", marginBottom: 2, fontFamily: "'Orbitron', monospace", letterSpacing: 0.5 }}>{label}</div>
                            <div style={{ fontSize: 11, color: color || "#e2e8f0", fontWeight: "bold" }}>{val}</div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}

                  {/* Hourly modal link */}
                  <button
                    onClick={() => setHourModal({ date: day.date, hours: day.hours, isToday })}
                    style={{
                      marginTop: 12, width: "100%",
                      background: "#0ea5e911", border: "1px solid #0ea5e933",
                      borderRadius: 8, padding: "8px 0",
                      color: "#38bdf8", fontSize: 12,
                      fontFamily: "'Share Tech Mono', monospace",
                      cursor: "pointer", letterSpacing: 0.5,
                    }}
                  >
                    📋 Tap for hourly detail
                  </button>
                  </>); })()}
                </Tile>

                {/* ── TEMPERATURE HOURLY ── */}
                <Tile title="Temperature (Hourly)" icon="🌡️" accent="#f97316">
                  <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 4 }}>
                    {isToday ? "Today" : new Date(day.date + "T12:00:00").toLocaleDateString("en", { weekday: "long", month: "short", day: "numeric" })} — 24hr °F
                  </div>
                  <LineGraph data={day.tempHours} color="#f97316" fillColor="#f97316" unit="°F" height={70} nowIndex={graphNowIndex} />
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#94a3b8", marginTop: 2 }}>
                    <span>12 a.m.</span><span>6 a.m.</span><span>12 p.m.</span><span>6 p.m.</span><span>11 p.m.</span>
                  </div>
                </Tile>

                {/* ── WATER TEMPERATURE (SST) ── always today's data */}
                {sst && (
                  <Tile title="Water Temperature (SST)" icon="🌊" accent="#06b6d4">
                    {sst.tooFar ? (
                      <div style={{ textAlign: "center", padding: "14px 0" }}>
                        <div style={{ fontSize: 26, marginBottom: 6 }}>🏙️</div>
                        <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.6 }}>
                          Location is more than 5 miles from the ocean.<br />Sea surface temperature data is not available.
                        </div>
                      </div>
                    ) : (
                      <>
                        <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 4 }}>
                          Today °F · Sea surface · Ideal inshore: 68–82°F
                          {!isToday && <span style={{ color: "#eab308", marginLeft: 6 }}>⚠ Always shows today</span>}
                          {sst.offsetMiles > 0 && (
                            <span style={{ color: "#0ea5e9", marginLeft: 6 }}>📍 ~{sst.offsetMiles}mi offshore</span>
                          )}
                        </div>
                        <LineGraph data={sst.hourly} color="#06b6d4" fillColor="#06b6d4" unit="°F" height={70} nowIndex={graphNowIndex} />
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#94a3b8", marginTop: 2 }}>
                          <span>12 a.m.</span><span>6 a.m.</span><span>12 p.m.</span><span>6 p.m.</span><span>11 p.m.</span>
                        </div>
                        {(() => {
                          const vals = sst.hourly.filter(v => v != null);
                          if (!vals.length) return null;
                          const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
                          const rating = avg >= 68 && avg <= 82 ? { label: "IDEAL", color: "#22c55e" }
                            : avg >= 60 && avg < 68  ? { label: "COOL — OK", color: "#84cc16" }
                            : avg > 82 && avg <= 88  ? { label: "WARM — OK", color: "#eab308" }
                            : { label: "OUT OF RANGE", color: "#ef4444" };
                          return (
                            <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 10 }}>
                              <span style={{ fontSize: 11, color: "#94a3b8" }}>
                                Avg: <b style={{ color: "#06b6d4" }}>{fmt(avg, 1)}°F</b>
                              </span>
                              <span style={{ fontSize: 10, color: rating.color, border: `1px solid ${rating.color}44`, borderRadius: 6, padding: "2px 8px" }}>
                                {rating.label}
                              </span>
                            </div>
                          );
                        })()}
                      </>
                    )}
                  </Tile>
                )}

                {/* ── CLOUD COVER ── */}
                {day.cloudHours?.some(v => v != null) && (
                  <Tile title="Cloud Cover (Hourly)" icon="☁️" accent="#a78bfa">
                    <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 4 }}>% · Overcast (50–90%) extends feeding windows</div>
                    <BarGraph data={day.cloudHours} colorFn={(v) => {
                      if (v >= 50 && v <= 90) return "#a78bfa";
                      if (v > 90) return "#818cf8";
                      if (v < 20) return "#fbbf24";
                      return "#64748b";
                    }} unit="%" height={70} nowIndex={graphNowIndex} />
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#94a3b8", marginTop: 2 }}>
                      <span>12 a.m.</span><span>6 a.m.</span><span>12 p.m.</span><span>6 p.m.</span><span>11 p.m.</span>
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                      {[["🟣","50-90% Best"],["🔵",">90% Overcast"],["⬛","20-50% Neutral"],["🟡","<20% Bright"]].map(([dot,lbl]) => (
                        <span key={lbl} style={{ fontSize: 10, color: "#94a3b8" }}>{dot} {lbl}</span>
                      ))}
                    </div>
                  </Tile>
                )}

                {/* ── LUNAR PHASE ── shows selected day + 7-day strip */}
                <Tile title="Lunar Phase" icon="🌙" accent="#a78bfa">
                  {/* Selected day's phase */}
                  <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
                    <span style={{ fontSize: 48 }}>{moonDay.icon}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: "'Orbitron', monospace", fontSize: 14, color: "#a78bfa" }}>{moonDay.name}</div>
                      <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 3 }}>Day {Math.round(moonDay.phase)} of 29.5</div>
                      <div style={{ marginTop: 8, background: "#1e293b", borderRadius: 6, height: 6 }}>
                        <div style={{ background: "#a78bfa", width: `${moonDay.pct * 100}%`, height: "100%", borderRadius: 6 }} />
                      </div>
                      <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 4 }}>
                        {Math.round(moonDay.pct * 100)}% through cycle
                      </div>
                    </div>
                  </div>
                  {/* 7-day lunar strip — always 7 days, computed from selected date */}
                  <div style={{ borderTop: "1px solid #1e293b", paddingTop: 12 }}>
                    <div style={{ fontSize: 9, color: "#64748b", fontFamily: "'Orbitron', monospace", letterSpacing: 1, marginBottom: 8 }}>
                      NEXT 7 DAYS
                    </div>
                    <div style={{ display: "flex", gap: 4, overflowX: "auto", paddingBottom: 2 }}>
                      {Array.from({ length: 7 }, (_, j) => {
                        // Compute target date purely from selected day + offset — no weather array needed
                        const baseDate = new Date(day.date + "T12:00:00");
                        baseDate.setDate(baseDate.getDate() + j);
                        const dateStr = baseDate.toISOString().slice(0, 10);
                        const lp = lunarPhaseForDay(dateStr);
                        const isSelected = j === 0;
                        const dayLabel = j === 0
                          ? (selectedDayIdx === 0 ? "Today" : new Date(day.date + "T12:00:00").toLocaleDateString("en", { weekday: "short" }))
                          : baseDate.toLocaleDateString("en", { weekday: "short" });
                        return (
                          <div key={j} style={{
                            flex: "0 0 auto", minWidth: 44,
                            textAlign: "center",
                            background: isSelected ? "#a78bfa22" : "transparent",
                            border: isSelected ? "1px solid #a78bfa44" : "1px solid transparent",
                            borderRadius: 8, padding: "6px 4px",
                          }}>
                            <div style={{ fontSize: 20 }}>{lp.icon}</div>
                            <div style={{ fontSize: 9, color: isSelected ? "#a78bfa" : "#94a3b8", marginTop: 3 }}>
                              {dayLabel}
                            </div>
                            <div style={{ fontSize: 8, color: "#94a3b8", marginTop: 1 }}>
                              {lp.name.split(" ")[0]}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </Tile>

                {/* ── SUNRISE & SUNSET ── selected day only, redesigned */}
                <Tile title="Sunrise & Sunset" icon="🌅" accent="#fbbf24">
                  <div style={{ display: "flex", gap: 10 }}>
                    {/* Sunrise */}
                    <div style={{
                      flex: 1, background: "#020a14", border: "1px solid #fbbf2433",
                      borderRadius: 12, padding: "14px 10px", textAlign: "center",
                    }}>
                      <div style={{ fontSize: 28, marginBottom: 6 }}>🌅</div>
                      <div style={{ fontSize: 9, color: "#64748b", fontFamily: "'Orbitron', monospace", letterSpacing: 1, marginBottom: 4 }}>SUNRISE</div>
                      <div style={{ fontSize: 18, fontWeight: "bold", color: "#fbbf24", fontFamily: "'Orbitron', monospace" }}>
                        {to12h(day.sunrise)}
                      </div>
                    </div>
                    {/* Daylight centre */}
                    {day.sunrise && day.sunset && (() => {
                      const [rh, rm] = day.sunrise.split(":").map(Number);
                      const [sh, sm] = day.sunset.split(":").map(Number);
                      const hrs = (sh * 60 + sm - rh * 60 - rm) / 60;
                      return (
                        <div style={{ textAlign: "center", display: "flex", flexDirection: "column", justifyContent: "center", minWidth: 52 }}>
                          <div style={{ fontSize: 9, color: "#94a3b8", marginBottom: 4 }}>DAYLIGHT</div>
                          <div style={{ fontSize: 20, fontWeight: "bold", color: "#94a3b8", fontFamily: "'Orbitron', monospace" }}>
                            {fmt(hrs, 1)}h
                          </div>
                        </div>
                      );
                    })()}
                    {/* Sunset */}
                    <div style={{
                      flex: 1, background: "#020a14", border: "1px solid #f9731633",
                      borderRadius: 12, padding: "14px 10px", textAlign: "center",
                    }}>
                      <div style={{ fontSize: 28, marginBottom: 6 }}>🌇</div>
                      <div style={{ fontSize: 9, color: "#64748b", fontFamily: "'Orbitron', monospace", letterSpacing: 1, marginBottom: 4 }}>SUNSET</div>
                      <div style={{ fontSize: 18, fontWeight: "bold", color: "#f97316", fontFamily: "'Orbitron', monospace" }}>
                        {to12h(day.sunset)}
                      </div>
                    </div>
                  </div>
                </Tile>

                {/* ── TIDE TILE ── */}
                {processedTides && (
                  <Tile
                    title={processedTides.tooFar ? "Tides" : `Tides · ${processedTides.stationName}`}
                    icon="🌊" accent="#06b6d4"
                  >
                    {processedTides.tooFar ? (
                      <div style={{ textAlign: "center", padding: "18px 0" }}>
                        <div style={{ fontSize: 28, marginBottom: 8 }}>🏙️</div>
                        <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.6 }}>
                          Location is more than 15 miles from the ocean.<br />Tide data is not available.
                        </div>
                      </div>
                    ) : (
                      <>
                        {/* Station header */}
                        <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 8 }}>
                          NOAA MLLW · Station {processedTides.stationId}
                          {processedTides.distMiles > 0 && (
                            <span style={{ color: "#0ea5e9", marginLeft: 6 }}>
                              📍 {processedTides.distMiles} mile{processedTides.distMiles !== 1 ? "s" : ""} away
                            </span>
                          )}
                        </div>

                        {/* Line graph — today only */}
                        {isToday && tideHeights && tideHeights.length > 0 ? (
                          <>
                            <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 4 }}>Today · hourly height (ft)</div>
                            <LineGraph
                              data={tideHeights}
                              color="#06b6d4" fillColor="#06b6d4" unit="ft" height={80}
                              nowIndex={graphNowIndex}
                            />
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#94a3b8", marginTop: 2, marginBottom: 12 }}>
                              <span>12 a.m.</span><span>6 a.m.</span><span>12 p.m.</span><span>6 p.m.</span><span>11 p.m.</span>
                            </div>
                          </>
                        ) : !isToday ? (
                          <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 12 }}>
                            ℹ Hourly graph available for today only
                          </div>
                        ) : null}

                        {/* Hi/Lo events for selected day */}
                        {tideEventsForDay && tideEventsForDay.events && tideEventsForDay.events.length > 0 ? (
                          <>
                            <div style={{ fontSize: 10, color: "#64748b", marginBottom: 8, fontFamily: "'Orbitron', monospace", letterSpacing: 1 }}>
                              HIGH &amp; LOW TIDES
                            </div>
                            {/* Column headers */}
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", fontSize: 9, color: "#94a3b8", paddingBottom: 4, borderBottom: "1px solid #1e293b", gap: 4 }}>
                              <span style={{ textAlign: "center", color: "#06b6d4" }}>⬆ High</span>
                              <span style={{ textAlign: "center", color: "#94a3b8" }}>⬇ Low</span>
                              <span style={{ textAlign: "center", color: "#06b6d4" }}>⬆ High</span>
                              <span style={{ textAlign: "center", color: "#94a3b8" }}>⬇ Low</span>
                            </div>
                            {(() => {
                              const highs = tideEventsForDay.events.filter(e => e.type === "H");
                              const lows  = tideEventsForDay.events.filter(e => e.type === "L");
                              const slots = [highs[0]||null, lows[0]||null, highs[1]||null, lows[1]||null];
                              return (
                                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 4, paddingTop: 8 }}>
                                  {slots.map((ev, si) => {
                                    const isHigh = si % 2 === 0;
                                    return (
                                      <div key={si} style={{
                                        background: "#020a14",
                                        border: `1px solid ${isHigh ? "#06b6d433" : "#1e293b"}`,
                                        borderRadius: 8, padding: "8px 4px",
                                        textAlign: "center",
                                      }}>
                                        {ev ? (
                                          <>
                                            <div style={{ color: isHigh ? "#06b6d4" : "#94a3b8", fontWeight: "bold", fontSize: 12 }}>
                                              {to12h(ev.time)}
                                            </div>
                                            <div style={{ color: "#94a3b8", fontSize: 10, marginTop: 2 }}>
                                              {fmt(ev.val, 2)} ft
                                            </div>
                                          </>
                                        ) : (
                                          <span style={{ color: "#1e293b", fontSize: 10 }}>—</span>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              );
                            })()}
                          </>
                        ) : null}
                      </>
                    )}
                  </Tile>
                )}

                {/* ── WIND SPEED ── */}
                <Tile title="Wind Speed (Hourly)" icon="💨" accent="#22c55e">
                  <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 4 }}>mph · 🟢&lt;8 🟡8-15 🔴&gt;20</div>
                  <BarGraph data={day.windHours} colorFn={windColor} unit=" mph" height={80} nowIndex={graphNowIndex} />
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#94a3b8", marginTop: 2 }}>
                    <span>12 a.m.</span><span>6 a.m.</span><span>12 p.m.</span><span>6 p.m.</span><span>11 p.m.</span>
                  </div>
                </Tile>

                {/* ── BAROMETRIC PRESSURE ── */}
                <Tile title="Barometric Pressure" icon="🔵" accent="#818cf8">
                  <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 4 }}>hPa · Ideal: 1008–1022</div>
                  <LineGraph data={day.baroHours} color="#818cf8" fillColor="#818cf8" unit=" hPa" height={60} nowIndex={graphNowIndex} />
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#94a3b8", marginTop: 2 }}>
                    <span>12 a.m.</span><span>6 a.m.</span><span>12 p.m.</span><span>6 p.m.</span><span>11 p.m.</span>
                  </div>
                </Tile>

                {/* ── FISHING FORECAST ── */}
                {scores && (
                  <Tile title="Fishing Forecast" icon="🐟" accent="#22c55e">
                    {/* Current score hero */}
                    {(() => {
                      const currentScore = isToday ? scores[nowHour] ?? scores[0] : scores[12] ?? scores[0];
                      const label = currentScore >= 75 ? "EXCELLENT" : currentScore >= 55 ? "GOOD" : currentScore >= 40 ? "FAIR" : "POOR";
                      return (
                        <div style={{
                          display: "flex", alignItems: "center", gap: 16,
                          background: "#020a14", border: `1px solid ${scoreColor(currentScore)}33`,
                          borderRadius: 14, padding: "14px 18px", marginBottom: 14,
                        }}>
                          <div style={{
                            fontFamily: "'Orbitron', monospace", fontSize: 42,
                            color: scoreColor(currentScore), fontWeight: 700, lineHeight: 1,
                          }}>
                            {currentScore}
                          </div>
                          <div>
                            <div style={{ fontSize: 16, fontWeight: "bold", color: scoreColor(currentScore), fontFamily: "'Orbitron', monospace" }}>
                              {label}
                            </div>
                            <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>
                              {isToday ? "Current hour score" : "Midday forecast score"}
                            </div>
                            <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 2 }}>
                              0–100 · Higher = better fishing
                            </div>
                          </div>
                        </div>
                      );
                    })()}

                    {/* Sunrise / noon / sunset key times */}
                    <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                      {(() => {
                        const riseH = day.sunrise ? parseInt(day.sunrise.split(":")[0]) : 6;
                        const setH  = day.sunset  ? parseInt(day.sunset.split(":")[0])  : 19;
                        return [
                          { label: "🌅 " + to12h(day.sunrise || (riseH + ":00")), h: riseH },
                          { label: "☀️ Noon", h: 12 },
                          { label: "🌇 " + to12h(day.sunset  || (setH  + ":00")), h: setH  },
                        ].map(({ label, h }) => {
                          const s = scores[Math.min(h, scores.length - 1)] || 50;
                          return (
                            <div key={label} style={{
                              flex: 1, background: "#0f172a", borderRadius: 10,
                              padding: "8px 4px", textAlign: "center",
                              border: `1px solid ${scoreColor(s)}33`,
                            }}>
                              <div style={{ fontSize: 9, color: "#64748b", marginBottom: 3 }}>{label}</div>
                              <div style={{ fontFamily: "'Orbitron', monospace", fontSize: 18, color: scoreColor(s), fontWeight: 700 }}>{s}</div>
                              <div style={{ fontSize: 9, color: "#94a3b8", marginTop: 1 }}>
                                {s >= 75 ? "EXCELLENT" : s >= 55 ? "GOOD" : s >= 40 ? "FAIR" : "POOR"}
                              </div>
                            </div>
                          );
                        });
                      })()}
                    </div>

                    {/* Hourly bar */}
                    <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 4 }}>Hourly Score (0–100)</div>
                    <BarGraph data={scores} colorFn={scoreColor} unit="" height={70} nowIndex={graphNowIndex} />
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#94a3b8", marginTop: 2 }}>
                      <span>12 a.m.</span><span>6 a.m.</span><span>12 p.m.</span><span>6 p.m.</span><span>11 p.m.</span>
                    </div>

                    {/* Legend */}
                    <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                      {[["🟢","≥75 Excellent"],["🟡","55-74 Good"],["🟠","40-54 Fair"],["🔴","<40 Poor"]].map(([dot,lbl]) => (
                        <span key={lbl} style={{ fontSize: 10, color: "#94a3b8" }}>{dot} {lbl}</span>
                      ))}
                    </div>

                    {/* Factors */}
                    <div style={{ marginTop: 12, fontSize: 10, color: "#94a3b8", borderTop: "1px solid #1e293b", paddingTop: 8 }}>
                      <div style={{ color: "#64748b", marginBottom: 4 }}>SCORE FACTORS</div>
                      {[
                        "🌙 Moon phase — new/full moons peak (+12pts)",
                        "🔭 Solunar — major overhead/underfoot (+12pts), minor rise/set (+6pts)",
                        "🔵 Baro 1008–1022 hPa (+10pts); below 1000 (−15pts)",
                        "📈 Baro rising strongly (+8pts); falling rapidly (−12pts)",
                        "🌊 Incoming tide (+15pts) / Outgoing (+5pts)",
                        "💨 Calm wind <5 mph (+10pts); strong >30 mph (−20pts)",
                        "🌅 Dawn/dusk hours (+12–15pts); midday (−5pts)",
                        "🌡️ Water 68–82°F (+8pts); very cold/hot (−10–15pts)",
                        "☁️ Overcast 50–90% (+5pts); bright clear sky (−5pts)",
                      ].map(f => <div key={f}>{f}</div>)}
                    </div>
                  </Tile>
                )}

                {location && !processedWeather && !loading && (
                  <button onClick={() => fetchAllData(location.lat, location.lon)} style={{
                    width: "100%", padding: "12px 0", background: "#0ea5e922",
                    border: "1px solid #0ea5e944", borderRadius: 10, color: "#38bdf8",
                    fontFamily: "'Orbitron', monospace", fontSize: 12, marginTop: 4,
                  }}>🔄 LOAD FORECAST DATA</button>
                )}

              </div>
            );
          })()}

        </div>
      )}

      {/* ---- Saved Spots Drawer — fixed bottom, visible on both Map and Details tabs ---- */}
      <div style={{
        position: "fixed", bottom: 0, left: 0, right: 0,
        zIndex: 9000,
        pointerEvents: "auto",
      }}>
        {/* Drawer handle / toggle bar */}
        <button
          onClick={() => setSpotsOpen(o => !o)}
          style={{
            width: "100%", padding: "8px 16px",
            background: spotsOpen ? "#0c1f36" : "#020a14cc",
            backdropFilter: "blur(8px)",
            border: "none", borderTop: "1px solid #0ea5e944",
            color: "#38bdf8", display: "flex", alignItems: "center",
            justifyContent: "space-between", cursor: "pointer",
          }}
        >
          <span style={{ fontFamily: "'Orbitron', monospace", fontSize: 11, letterSpacing: 1 }}>
            ⭐ SAVED SPOTS {savedLocations.length > 0 && `(${savedLocations.length})`}
          </span>
          <span style={{ fontSize: 14, transition: "transform 0.2s", display: "inline-block", transform: spotsOpen ? "rotate(180deg)" : "rotate(0deg)" }}>▲</span>
        </button>

        {/* Drawer body */}
        {spotsOpen && (
          <div style={{
            background: "#020a14f0",
            backdropFilter: "blur(10px)",
            borderTop: "1px solid #0ea5e922",
            maxHeight: 220, overflowY: "auto",
            padding: savedLocations.length === 0 ? "14px 16px" : "8px 12px",
          }}>
            {savedLocations.length === 0 ? (
              <div style={{ fontSize: 11, color: "#94a3b8", textAlign: "center" }}>
                No saved spots yet. Tap ⭐ in the search bar to save a location.
              </div>
            ) : savedLocations.map((l, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "6px 4px", borderBottom: "1px solid #1e293b44",
              }}>
                <button
                  onClick={() => toggleFavorite(i)}
                  title={favoriteIdx === i ? "Remove as default" : "Set as default (auto-loads on open)"}
                  style={{
                    background: "none", border: "none", padding: "2px 4px",
                    fontSize: 16, cursor: "pointer",
                    filter: favoriteIdx === i ? "none" : "grayscale(1) opacity(0.4)",
                  }}
                >⭐</button>
                <button
                  onClick={() => { setLocationAndFetch(l.lat, l.lon, l.label); setSpotsOpen(false); }}
                  style={{
                    flex: 1, background: favoriteIdx === i ? "#0ea5e911" : "#0f172a",
                    border: `1px solid ${favoriteIdx === i ? "#0ea5e944" : "#1e293b"}`,
                    borderRadius: 6, padding: "5px 10px", color: "#e2e8f0",
                    textAlign: "left", fontSize: 11,
                    fontFamily: "'Share Tech Mono', monospace",
                  }}
                >
                  {l.label}
                  {favoriteIdx === i && <span style={{ color: "#0ea5e9", fontSize: 9, marginLeft: 6 }}>DEFAULT</span>}
                </button>
                <button
                  onClick={() => deleteLocation(i)}
                  style={{ background: "none", border: "none", color: "#ef444477", fontSize: 16, padding: "2px 4px", cursor: "pointer" }}
                >✕</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Save modal — BUG FIX: z-index raised to 10000 to clear Leaflet's internal stacking context */}
      {saveModalOpen && (
        <div style={{ position: "fixed", inset: 0, background: "#000b", zIndex: 10000, display: "flex", alignItems: "flex-end" }}
          onClick={() => setSaveModalOpen(false)}>
          <div style={{ background: "#0f172a", border: "1px solid #0ea5e933", borderRadius: "18px 18px 0 0", padding: 20, width: "100%" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontFamily: "'Orbitron', monospace", color: "#38bdf8", fontSize: 13, marginBottom: 12 }}>SAVE LOCATION</div>
            <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 10 }}>
              📍 {location?.name}
            </div>
            <input value={saveName} onChange={e => setSaveName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && saveLocation()}
              placeholder="Give this spot a name…"
              autoFocus
              style={{ width: "100%", background: "#1e293b", border: "1px solid #0ea5e933", borderRadius: 8, padding: "9px 12px", color: "#e2e8f0", fontFamily: "'Share Tech Mono', monospace", fontSize: 13, marginBottom: 12 }} />
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setSaveModalOpen(false)} style={{ flex: 1, padding: 10, background: "transparent", border: "1px solid #334155", borderRadius: 8, color: "#64748b", fontFamily: "'Orbitron', monospace", fontSize: 11 }}>CANCEL</button>
              <button onClick={saveLocation} style={{ flex: 1, padding: 10, background: "#0ea5e9", border: "none", borderRadius: 8, color: "#fff", fontFamily: "'Orbitron', monospace", fontSize: 11 }}>SAVE ⭐</button>
            </div>
          </div>
        </div>
      )}

      {/* Hourly detail modal */}
      <HourModal data={hourModal} onClose={() => setHourModal(null)} nowHour={nowHour} />
    </div>
  );
}
