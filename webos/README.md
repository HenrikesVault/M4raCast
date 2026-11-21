# M4raCast LG webOS TV App

This is the standalone LG webOS TV application for M4raCast, built as a webOS web application with complete Magic Remote & D-pad controller support.

## Key Features for LG webOS TV
- **Magic Remote & D-Pad support**:
  - **D-Pad (Up, Down, Left, Right)** & **OK**: navigate spatial UI and connect
  - **Back / Return button (`keyCode 461`)**: closes modals, cancels connect, or disconnects stream
  - **Exit key (`keyCode 1001`)**: calls webOS platform exit
  - **Color Buttons**:
    - 🔴 **Red (`keyCode 403`)**: Disconnect stream
    - 🟢 **Green (`keyCode 404`)**: Toggle Mute/Audio
    - 🟡 **Yellow (`keyCode 405`)**: Fit / Aspect Ratio
    - 🔵 **Blue (`keyCode 406`)**: Toggle Fullscreen
  - **Magic Remote Pointer**: Auto-hides after 3 seconds of inactivity and on keypress so the cursor doesn't obscure the stream.
- **Dual-mode streaming engine**:
  - **WebCodecs (VideoDecoder)** when running in secure contexts
  - **MSE (Media Source Extensions + fMP4)** for plain LAN HTTP connections (`http://<phone-ip>:<port>`)
- **1080p Native Resolution**: configured with `"resolution": "1920x1080"` in `appinfo.json`.

---

## How to Package & Install (.ipk)

### Method 1: Using LG webOS TV CLI (`ares-*`)
1. Ensure the webOS CLI is installed:
   ```bash
   npm install -g @webos-tools/cli
   # or download from LG Developer website
   ```
2. Double-click `package.bat` or run:
   ```bash
   cd webos
   ares-package .
   ```
   This generates `com.m4racast.receiver_1.0.0_all.ipk`.
3. Install to your configured TV:
   ```bash
   ares-install com.m4racast.receiver_1.0.0_all.ipk
   ```

### Method 2: Using webOS Dev Manager (GUI)
1. Install [webOS Dev Manager](https://github.com/webosbrew/dev-manager-desktop) on your PC.
2. Connect to your LG TV in Developer Mode or via Homebrew Channel.
3. Click **"Install IPK"** and select the `.ipk` generated above (or click "Install Web App" and point to this `webos/` folder).

