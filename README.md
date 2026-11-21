# M4raCast — Lightweight LAN Screen Sharing System

M4raCast is a high-performance, multifunctional LAN screen-sharing system designed for zero-cloud, direct peer-to-peer streaming over Wi-Fi/Ethernet.

The system is composed of two primary components:
1. **Android Agent:** Native Kotlin + Android SDK server leveraging hardware-accelerated screen capture and video encoding (`MediaProjection` + `MediaCodec` H.264).
2. **Web Client:** Zero-dependency modern browser viewer featuring ultra-low latency WebCodecs decoding and **client-side pixel-precise cropping** designed for TVs and monitors.

---

## Architecture (Domain-Driven Design)

```
OpenCast/
├── android/                             # Android Agent (Kotlin + Android SDK)
│   ├── app/
│   │   ├── src/main/
│   │   │   ├── java/com/m4racast/agent/
│   │   │   │   ├── domain/              # Pure domain logic (No Android dependencies)
│   │   │   │   │   ├── agent/           # Agent identity & configuration
│   │   │   │   │   ├── streaming/       # Stream session state & resolution models
│   │   │   │   │   ├── client/          # Connected client abstractions
│   │   │   │   │   ├── auth/            # Nonce-based SHA-256 challenge-response
│   │   │   │   │   └── discovery/       # Discovery packet format
│   │   │   │   ├── application/         # Use Cases
│   │   │   │   │   ├── StartStreamingUseCase.kt
│   │   │   │   │   ├── StopStreamingUseCase.kt
│   │   │   │   │   └── UpdateConfigurationUseCase.kt
│   │   │   │   ├── infrastructure/      # Concrete implementations
│   │   │   │   │   ├── http/            # Embedded HTTP/1.1 & WebSocket Server
│   │   │   │   │   ├── capture/         # MediaProjection & VirtualDisplay adapter
│   │   │   │   │   ├── encoding/        # MediaCodec hardware H.264 encoder
│   │   │   │   │   ├── network/         # UDP broadcast & LAN IP discovery
│   │   │   │   │   ├── storage/         # SharedPreferences repository
│   │   │   │   │   └── StreamingService.kt # Foreground service orchestrator
│   │   │   │   └── presentation/        # Native Android XML UI + ViewModels
│   │   │   │       ├── main/            # MainActivity, MainViewModel
│   │   │   │       └── settings/        # SettingsActivity, SettingsViewModel
│   │   │   ├── assets/webclient/        # Bundled web client served by embedded server
│   │   │   └── res/                     # Native XML layouts, drawables, themes
│   └── build.gradle
└── webclient/                           # Standalone / Embedded Browser Client
    ├── index.html                       # Responsive viewer UI
    ├── css/main.css                     # Modern dark theme UI styles
    └── js/
        ├── app.js                       # Client orchestrator & UI bindings
        ├── discovery.js                 # LAN subnet probe & agent detection
        ├── connection.js                # M4raCast WebSocket protocol handler
        ├── player.js                    # WebCodecs low-latency video decoder
        └── cropper.js                   # Client-side precision cropping engine
```

---

## M4raCast Protocol Specification

### 1. Agent Discovery

Agents announce themselves over UDP broadcast:
- **Port:** `42400`
- **Interval:** Every 2 seconds
- **Format (UTF-8 JSON):**
  ```json
  {
    "protocol": "M4raCast",
    "version": "1.0",
    "name": "Pixel 8 Pro",
    "port": 54321,
    "protected": false
  }
  ```

Browsers also probe local subnets via HTTP `/m4racast/v1/info` or connect directly using IP:Port.

### 2. HTTP API (Port assigned or configured)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` or `/index.html` | Serves embedded Web Client |
| `GET` | `/m4racast/v1/info` | Public agent info & streaming status |
| `GET` | `/m4racast/v1/nonce` | Single-use nonce for password challenge-response |
| `POST` | `/m4racast/v1/auth` | Challenge verification: `{ password_hash: sha256(password + nonce), nonce }` |
| `GET` | `/m4racast/v1/stream/info` | Current stream resolution, FPS, bitrate, codec |
| `GET` | `/m4racast/v1/stream/connect` | Upgrade request to WebSocket stream |

### 3. Binary WebSocket Transport

After upgrade, video frames and control messages are multiplexed using a 1-byte binary prefix:

| Byte | Packet Type | Payload Content |
|---|---|---|
| `0x01` | `VIDEO_FRAME` | `[8-byte uint64 PTS BE][1-byte isKeyframe flag][NAL Units (Annex B)...]` |
| `0x02` | `CONFIG` | SPS (csd-0) + PPS (csd-1) parameter set bytes |
| `0x03` | `CONTROL` | UTF-8 JSON control packet (`stream_start`, `stream_stop`, `orientation_change`) |
| `0x04` | `STATS` | Real-time statistics JSON |
| `0x05` | `PING` | Keepalive heartbeat ping |
| `0x06` | `PONG` | Heartbeat latency pong reply |

---

## Precision Cropping Feature

M4raCast includes an in-browser precision cropping engine (`cropper.js`):
- **Client-Side:** Operates via HTML5 Canvas sub-rectangle blitting with zero re-encoding and zero latency overhead.
- **TV / Monitor Presets:** 1-click format adaptors for `16:9`, `16:10`, and `4:3` monitors.
- **Pixel-Accurate Controls:** Independent top, bottom, left, and right sliders + number inputs to eliminate black bars, status bars, and navigation pills.
- **Lossless Transform:** Eliminates aspect ratio distortion or stretching.

---

## Building and Running

### Android Agent
1. Open `android/` in Android Studio or build via CLI:
   ```bash
   cd android
   gradle assembleDebug
   ```
2. Install the APK on your Android device (Android 8.0+ / API 26+).
3. Grant notification & screen capture permissions when prompted.
4. Tap **"Start Sharing"**. The assigned LAN IP and Port will be displayed on screen.

### Web Client
- **Option 1 (Embedded):** Open `http://<device-ip>:<port>` in any browser on the same Wi-Fi/Ethernet network. The Android agent serves the web client directly!
- **Option 2 (Standalone):** Open `webclient/index.html` directly in Chrome, Edge, Safari, or Firefox. The client will automatically scan your LAN and list available agents.

