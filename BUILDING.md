# Building CurrentCast from Source

This document covers building the Android APK on Windows. The app is built with React and Capacitor.

---

## Prerequisites (one-time setup)

### 1. Node.js
Download and install the LTS version from https://nodejs.org. During installation check "Tools for Native Modules" if prompted. Restart your computer after installing.

Verify: open Command Prompt and run `node --version` — should print a version number.

### 2. Android Studio
Download from https://developer.android.com/studio. Run the installer keeping all defaults. On first launch, let the setup wizard download the Android SDK (5–15 minutes).

In Android Studio go to **More Actions → SDK Manager**:
- SDK Platforms tab: check **Android 14 (API 34)**
- SDK Tools tab: verify **Android SDK Build-Tools** and **Platform-Tools** are installed

### 3. ANDROID_HOME environment variable
1. Search Windows for "Edit the system environment variables" and open it
2. Click **Environment Variables**
3. Under User Variables, click **New**:
   - Variable name: `ANDROID_HOME`
   - Variable value: `C:\Users\YourName\AppData\Local\Android\Sdk`
4. Find **Path** in User Variables, click **Edit → New**, add:
   - `C:\Users\YourName\AppData\Local\Android\Sdk\platform-tools`
5. Click OK on all windows, then close and reopen Command Prompt

Verify: run `adb --version` — should print a version number.

---

## Build steps

### First time only

```
git clone https://github.com/YOUR-USERNAME/currentcast.git
cd currentcast
npm install
npx cap init "CurrentCast" "com.yourname.currentcast" --web-dir=build
npm run build
npx cap add android
npx cap sync android
```

### Subsequent builds (after code changes)

```
npm run build
npx cap sync android
```

Use `npx cap sync` (not `npx cap copy`) whenever you've changed `capacitor.config.json`. For code-only changes, `npx cap copy android` is faster.

### Open in Android Studio

```
npx cap open android
```

In Android Studio, wait for the Gradle sync to complete (progress bar at the bottom). Then:

**Debug APK:** Build → Build Bundle(s) / APK(s) → Build APK(s)

**Release APK (for distribution):** Build → Generate Signed Bundle / APK → APK → create or select your keystore → choose `release` build variant → Finish

The release APK lands in `android/app/release/`. Rename it to `CurrentCast.apk` before sharing.

---

## Naming the APK

To automatically name the output file, add this inside the `android {}` block in `android/app/build.gradle`:

```groovy
applicationVariants.all { variant ->
    variant.outputs.all {
        outputFileName = "CurrentCast-${variant.versionName}-${variant.buildType.name}.apk"
    }
}
```

---

## Common errors

| Error | Fix |
|---|---|
| `'node' is not recognized` | Reinstall Node.js and restart computer |
| `ANDROID_HOME is not set` | Redo the environment variable step above, restart CMD |
| `SDK location not found` | In Android Studio: File → Project Structure → SDK Location, verify path |
| `JAVA_HOME is not set` | Add JAVA_HOME pointing to `C:\Program Files\Android\Android Studio\jbr` |
| Gradle sync fails | In Android Studio: File → Invalidate Caches → Invalidate and Restart |
| `npm run build` fails | Verify `src/App.js` was saved correctly with no extra characters at the top |

---

## Android Network Security Configuration

Android 9+ blocks certain network requests from WebViews by default. Create this file:

**`android/app/src/main/res/xml/network_security_config.xml`**

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="true">api.open-meteo.com</domain>
        <domain includeSubdomains="true">marine-api.open-meteo.com</domain>
        <domain includeSubdomains="true">api.tidesandcurrents.noaa.gov</domain>
        <domain includeSubdomains="true">tidesandcurrents.noaa.gov</domain>
        <domain includeSubdomains="true">nominatim.openstreetmap.org</domain>
        <domain includeSubdomains="true">server.arcgisonline.com</domain>
        <domain includeSubdomains="true">services.arcgisonline.com</domain>
        <domain includeSubdomains="true">is-on-water.balbona.me</domain>
        <domain includeSubdomains="true">api.weather.gov</domain>
        <domain includeSubdomains="true">mt1.google.com</domain>
    </domain-config>
</network-security-config>
```

Add this attribute to the `<application>` tag in `AndroidManifest.xml`:

```xml
android:networkSecurityConfig="@xml/network_security_config"
```

---

## Status bar (white icons on dark background)

In `android/app/src/main/res/values/styles.xml`, update `AppTheme.NoActionBar`:

```xml
<style name="AppTheme.NoActionBar" parent="Theme.AppCompat.DayNight.NoActionBar">
    <item name="android:windowLightStatusBar">false</item>
    <item name="android:windowLightNavigationBar">false</item>
    <item name="android:statusBarColor">@android:color/transparent</item>
    <item name="android:navigationBarColor">#020a14</item>
</style>
```

---

## App name

The display name shown under the icon comes from two places:

1. `capacitor.config.json` → `"appName": "CurrentCast"` (applied by `npx cap sync`)
2. `android/app/src/main/res/values/strings.xml` → `<string name="app_name">CurrentCast</string>`

Both need to match.
