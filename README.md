# MMM-GooglePhotos

A [MagicMirror²](https://magicmirror.builders/) module to display photos from Google Photos on your smart mirror.

Supports two modes:

- **Picker mode** — Select specific photos via the Google Photos Picker UI
- **Drive mode** — Automatically display all photos from a Google Drive folder

> **Note:** The original Google Photos Library API was deprecated (scopes removed March 31, 2025). This module uses the [Google Photos Picker API](https://developers.google.com/photos/picker/guides/get-started-picker) and/or the [Google Drive API v3](https://developers.google.com/drive/api/guides/about-sdk) as replacements.

---

## Features

- Two modes: interactive photo picker or automatic Google Drive folder
- Random, newest-first, or oldest-first photo sorting
- Automatic token and URL refresh (no manual intervention needed)
- Smooth crossfade transitions between photos
- Configurable photo info overlay with auto-positioning (prevents OLED burn-in)
- Session persistence — restarts resume without re-picking photos
- OAuth 2.0 authentication with automatic token refresh

## Screenshots

| Slideshow | Picker prompt |
|-----------|---------------|
| ![screenshot](images/screenshot.png) | ![screenshot2](images/screenshot2.png) |

---

## Installation

### 1. Clone the module

```bash
cd ~/MagicMirror/modules
git clone https://github.com/ruudsl/MMM-GooglePhotos.git
cd MMM-GooglePhotos
```

### 2. Install dependencies

```bash
npm run install-prod
```

### 3. Set up Google Cloud credentials

See [Google Cloud Setup](#google-cloud-setup) below.

### 4. Generate an OAuth token

```bash
cd ~/MagicMirror/modules/MMM-GooglePhotos
node generate_token_v2.js
```

A browser window will open. Sign in with your Google account and grant access. The token is saved to `token.json`.

### 5. Add the module to your MagicMirror config

See [Configuration](#configuration) below.

### 6. Start MagicMirror

```bash
cd ~/MagicMirror
npm start
```

---

## Google Cloud Setup

### Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (e.g., "MagicMirror Photos")

### Step 2: Enable the required API

Enable the API that matches the mode you want to use:

| Mode | API to enable |
|------|---------------|
| **Picker mode** (default) | **Google Photos Picker API** |
| **Drive mode** | **Google Drive API** |

> **Important:** For Picker mode, enable **"Google Photos Picker API"** — not the similarly named "Google Picker API" (which is for Drive files).

To enable: Go to **APIs & Services** > **Library**, search for the API name, and click **Enable**.

### Step 3: Configure the OAuth consent screen

1. Go to **APIs & Services** > **OAuth consent screen**
2. Choose **External** user type
3. Fill in the required fields (app name, support email, developer email)
4. Add your Google email as a **test user**
5. Save and continue

> **Tip:** To prevent your token from expiring every 7 days, click **Publish App** on the OAuth consent screen page. This moves your app out of "testing" mode.

### Step 4: Create OAuth 2.0 credentials

1. Go to **APIs & Services** > **Credentials**
2. Click **Create Credentials** > **OAuth client ID**
3. Choose **Desktop app** as the application type
4. Click **Create**
5. Download the JSON file and save it as `credentials.json` in the module directory:

```bash
mv ~/Downloads/client_secret_*.json ~/MagicMirror/modules/MMM-GooglePhotos/credentials.json
```

### Step 5: Set the correct API scope

Edit `google_auth.json` in the module directory to match your chosen mode:

**For Picker mode** (default):
```json
{
  "keyFilePath": "./credentials.json",
  "savedTokensPath": "./token.json",
  "scope": "https://www.googleapis.com/auth/photospicker.mediaitems.readonly"
}
```

**For Drive mode:**
```json
{
  "keyFilePath": "./credentials.json",
  "savedTokensPath": "./token.json",
  "scope": "https://www.googleapis.com/auth/drive.readonly"
}
```

### Step 6: Generate the token

```bash
cd ~/MagicMirror/modules/MMM-GooglePhotos
node generate_token_v2.js
```

> **Switching modes?** If you switch between Picker and Drive mode, update the scope in `google_auth.json`, delete the old `token.json`, and re-run `node generate_token_v2.js`.

---

## Configuration

Add the module to your `config/config.js`:

### Picker mode (default)

```javascript
{
  module: "MMM-GooglePhotos",
  position: "middle_center",
  config: {
    updateInterval: 60000,
    sort: "random",
    showWidth: 1080,
    showHeight: 1920
  }
}
```

On first launch, the module will display a link on screen. Open it on your phone or computer to select which photos to display.

### Drive mode

```javascript
{
  module: "MMM-GooglePhotos",
  position: "middle_center",
  config: {
    driveFolder: "MagicMirror Photos",
    updateInterval: 60000,
    sort: "random",
    showWidth: 1080,
    showHeight: 1920
  }
}
```

Place your photos in a Google Drive folder, then set `driveFolder` to the folder name. You can also use the folder ID directly (the long string in the folder's URL).

### All configuration options

| Option | Description | Default |
|--------|-------------|---------|
| `driveFolder` | Google Drive folder name or ID. Set this to enable Drive mode. | `null` (Picker mode) |
| `updateInterval` | Time between photo changes in milliseconds (minimum 10000) | `60000` |
| `sort` | Sort order: `"random"`, `"new"` (newest first), or `"old"` (oldest first) | `"random"` |
| `showWidth` | Photo width in pixels (used for display size and download quality) | `1080` |
| `showHeight` | Photo height in pixels (used for display size and download quality) | `1920` |
| `timeFormat` | Photo timestamp format ([moment.js](https://momentjs.com/docs/#/displaying/format/)) or `"relative"` | `"YYYY/MM/DD HH:mm"` |
| `autoInfoPosition` | Rotate info overlay position every 15 minutes (prevents screen burn-in) | `false` |
| `debug` | Enable verbose logging in the console | `false` |

### Fullscreen example

To use the module as a fullscreen photo frame:

```javascript
{
  module: "MMM-GooglePhotos",
  position: "fullscreen_above",
  config: {
    driveFolder: "MagicMirror Photos",
    updateInterval: 30000,
    sort: "random",
    showWidth: 1920,
    showHeight: 1080,
    autoInfoPosition: true
  }
}
```

---

## How it works

### Picker mode

1. The module creates a Picker session and shows a link on the mirror display
2. You open the link on any device and select photos from your Google Photos library
3. The module downloads and displays your selection as a slideshow
4. The session is saved to `picker_session.json` — on restart, it resumes without re-picking
5. Photo URLs are automatically refreshed every 50 minutes (they expire after 60)
6. When the session expires (~7 days), a new link appears on screen

### Drive mode

1. The module connects to Google Drive and finds the configured folder
2. It lists all images in the folder and displays them as a slideshow
3. The photo list is refreshed every 50 minutes to pick up new additions
4. No user interaction needed after initial setup

---

## CSS Customization

Add any of these to your `css/custom.css` to customize the appearance:

**Hide the photo info overlay:**
```css
#GPHOTO_INFO { display: none; }
```

**Hide the blurred background:**
```css
#GPHOTO_BACK { display: none; }
```

**Fill the entire region (crop to fit):**
```css
#GPHOTO_CURRENT { background-size: cover; }
```

**Add opacity to photos (useful with other modules on screen):**
```css
#GPHOTO_CURRENT { opacity: 0.5; }
```

**Display clock clearly over fullscreen photos:**
```css
.clock {
  padding: 10px;
  background-color: rgba(0, 0, 0, 0.5);
}
```

---

## Managing photos

### Picker mode: select different photos

Delete the saved session and restart MagicMirror:

```bash
rm ~/MagicMirror/modules/MMM-GooglePhotos/picker_session.json
pm2 restart MagicMirror
```

A new picker link will appear on screen.

### Drive mode: add or remove photos

Simply add or remove photos from your Google Drive folder. The module picks up changes automatically within 50 minutes, or restart MagicMirror for immediate effect.

---

## Remote setup (headless Raspberry Pi)

If your MagicMirror runs on a headless Raspberry Pi, generate the token on a computer with a browser first:

1. On your **computer**: clone the repo, run `npm install`, place `credentials.json`, and run `node generate_token_v2.js`
2. Copy `credentials.json` and `token.json` to the Pi:

```bash
scp credentials.json token.json pi@<pi-ip>:~/MagicMirror/modules/MMM-GooglePhotos/
```

3. Restart MagicMirror on the Pi

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "insufficient authentication scopes" | Delete `token.json`, check the scope in `google_auth.json`, and re-run `node generate_token_v2.js` |
| "No OAuth token found" | Run `node generate_token_v2.js` to generate `token.json` |
| "Missing credentials.json" | Download OAuth credentials from the Google Cloud Console |
| Picker link not working | Make sure you enabled **Google Photos Picker API** (not "Google Picker API") |
| Photos are very small | Increase `showWidth` and `showHeight` in your config to match your screen resolution |
| Photos stop loading | URLs expire after 60 min — the module auto-refreshes every 50 min. If issues persist, restart MagicMirror |
| Drive folder not found | Verify the folder name is exact (case-sensitive) or use the folder ID from the URL |
| Token expires every week | Publish your app on the OAuth consent screen (see [Step 3](#step-3-configure-the-oauth-consent-screen)) |
| Want to switch modes | Update the scope in `google_auth.json`, delete `token.json`, re-run `node generate_token_v2.js` |

---

## File structure

```
MMM-GooglePhotos/
├── MMM-GooglePhotos.js       # Frontend module
├── MMM-GooglePhotos.css      # Styles
├── node_helper.js            # Backend (mode orchestration)
├── GPhotosPicker.js          # Google Photos Picker API client
├── GDrive.js                 # Google Drive API client
├── generate_token_v2.js      # OAuth token generator
├── google_auth.json          # Auth config (scope + file paths)
├── credentials.json          # Your OAuth credentials (not in git)
├── token.json                # Generated OAuth token (not in git)
├── picker_session.json       # Saved picker session (auto-created)
└── package.json              # Dependencies
```

> `credentials.json` and `token.json` are excluded from git via `.gitignore`. Never share these files publicly.

---

## Updating

```bash
cd ~/MagicMirror/modules/MMM-GooglePhotos
git pull
npm run install-prod
```

Then restart MagicMirror.

---

## License

MIT

## Credits

Originally created by [eouia](https://github.com/eouia), maintained by [hermanho](https://github.com/hermanho).
Drive mode and Picker API migration by contributors.
