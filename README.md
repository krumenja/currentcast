# 🎣 CurrentCast

**A free saltwater surf fishing app for Android.** CurrentCast combines real-time tides, NOAA weather, sea surface temperature, lunar phases, solunar periods, and severe weather alerts into a single fishing forecast score — so you can plan your next session around the conditions that actually matter.

No subscription. No account. No ads. 100% free.

---

## 📲 Just want the app?

**[→ Download the latest APK](../../releases/latest)**

See [INSTALL_ANDROID.md](INSTALL_ANDROID.md) for a plain-English guide to installing it on your phone in under 5 minutes.

---

## What the app does

### Map
- Satellite imagery that switches to road overlay when you zoom in
- Search any address, city, ZIP, or coordinates
- Tap the map to pin any location and get a full forecast
- GPS button to center on your current position
- Save unlimited named fishing spots — star one as your default and it loads automatically when you open the app
- Fish catch log: tap the 🐟 button to record a catch at any map location, with optional weather snapshot

### Forecast tab
- **10-day weather forecast** with hourly breakdown — tap any day
- **Severe weather alerts** from NOAA — red banner for warnings, yellow for watches, with full details on tap
- **Sea surface temperature** — real ocean water temp, not air temp
- **Tide chart** — NOAA hourly line graph + 7-day hi/lo table with exact times
- **Solunar periods** — major and minor feeding windows overlaid on the fishing score
- **Lunar phase** — 7-day moon strip with today's phase and cycle progress
- **Sunrise & Sunset** — with daylight hours for each day
- **Wind speed, cloud cover, and barometric pressure** — hourly graphs

### Fishing Forecast Score (0–100)
Every hour gets a score built from nine factors:

| Factor | Max Bonus | Max Penalty |
|---|---|---|
| Lunar phase (new/full moon peaks) | +12 | — |
| Solunar periods (overhead/underfoot) | +12 | — |
| Barometric pressure — absolute | +10 | −15 |
| Barometric pressure — 3hr trend | +8 | −12 |
| Tide direction (incoming best) | +15 | — |
| Wind speed | +10 | −20 |
| Time of day (dawn/dusk peaks) | +15 | −8 |
| Water temperature | +8 | −15 |
| Cloud cover | +5 | −5 |

🟢 75–99 = Excellent &nbsp; 🟡 55–74 = Good &nbsp; 🟠 40–54 = Fair &nbsp; 🔴 < 40 = Poor

---

## What it covers

CurrentCast is built for **US coastal saltwater fishing** — Atlantic, Gulf, and Pacific coasts. Tide and weather data is sourced from NOAA so coverage is best for the continental United States. The ocean proximity detection and sea surface temperature data also work well for coastal areas worldwide, but tide station coverage outside the US will be limited.

---

## Data sources — all free, no keys required

| Data | Source | Refresh |
|---|---|---|
| Weather, wind, pressure, cloud cover | Open-Meteo | On location change, then every 15 min |
| Sea surface temperature | Open-Meteo Marine (Copernicus) | On location change, then every 15 min |
| Tides (hourly + hi/lo) | NOAA CO-OPS | On location change, then every 15 min |
| Severe weather alerts | NOAA Weather API | Every 5 min while app is open |
| Ocean proximity detection | is-on-water.balbona.me (ASTER 30m) | On location change |
| Geocoding | OpenStreetMap Nominatim | On search |
| Satellite map tiles | ESRI World Imagery | Continuous |
| Road/label overlay | Google Maps Hybrid (zoom ≥ 13) | Continuous |
| Lunar phases | Calculated mathematically | — |

Weather and tide data refreshes every 15 minutes while the app is open and in the foreground. All polling pauses when the app is minimized, so there are no background data calls.

---

## Requirements

- Android phone (Android 5.0 / API 21 or higher)
- Internet connection for weather and tide data
- GPS permission for current location features (optional — you can search any location manually)

---

## 🛠 For developers — building from source

See [BUILDING.md](BUILDING.md) for full build instructions on Windows.

**Quick summary:**
```
npm install
npm run build
npx cap sync android
```
Then open the `android/` folder in Android Studio and build the APK.

The app is built with **React + Capacitor**. No API keys needed for any data source.

---

## Testing weather alerts

Type either phrase into the search box and press Enter:

- `open test weather alert` — shows a sample Severe Thunderstorm Warning banner
- `close test weather alert` — clears it

---

## License

MIT License — free to use, modify, and distribute. See [LICENSE](LICENSE).

---

## Credits

**Concept, design, and product direction:** Jason Krumenaker

**Built with AI assistance:** This app was designed and built through an extended conversation with [Claude](https://claude.ai) (Anthropic), which wrote the React/Capacitor code, debugged the NOAA tide pipeline, implemented the fishing forecast algorithm, and iterated through 36 versions of the app based on feedback and real-world testing on Android hardware. The source code was generated entirely by Claude — Anthropic's AI assistant — with human direction and testing.

If you're curious about building something similar, the entire session was conducted in [Claude.ai](https://claude.ai).

---

## Contributing

Issues and pull requests welcome. If you find a bug or want to suggest a feature, open a GitHub Issue.

If you're a non-technical user and something doesn't work on your phone, open an issue and describe what you see — include your Android version and what you were trying to do.
