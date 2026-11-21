/**
 * M4raCast WebSocket Connection
 * Manages WebSocket lifecycle, binary frame demuxing, and control signaling.
 * Compatible with webOS 5.40.97 (Chromium 68) — standard ES6 syntax without class fields or optional chaining.
 */
export class Connection {
    constructor(agent, token, player, audioPlayer) {
        this.agent = agent;
        this.token = token;
        this.player = player;
        this.audioPlayer = audioPlayer || null;
        this.ws = null;
        this.onDisconnect = null;
        this.onStats = null;
        this.onError = null;

        this._frameCount = 0;
        this._byteCount = 0;
        this._lastFpsTime = Date.now();
        this._fpsInterval = null;
        this._pingInterval = null;
        this._lastPingTime = 0;
        this._latencyMs = 0;
        this._videoFrameCount = 0;
    }

    connect() {
        const tokenQuery = this.token ? `?token=${encodeURIComponent(this.token)}` : '';
        const endpoint = this.agent.endpoint || '/m4racast/v1/stream/connect';
        const wsUrl = `ws://${this.agent.host}:${this.agent.port}${endpoint}${tokenQuery}`;
        console.log('[Connection] Connecting to:', wsUrl);

        try {
            this.ws = new WebSocket(wsUrl);
            this.ws.binaryType = 'arraybuffer';

            this.ws.onopen = () => {
                console.log('[Connection] Connected to M4raCast Agent');
                this._startPingLoop();
                this._startStatsLoop();
            };

            this.ws.onmessage = (event) => {
                if (event.data instanceof ArrayBuffer) {
                    this._handleBinaryFrame(event.data);
                } else if (typeof event.data === 'string') {
                    this._handleTextFrame(event.data);
                }
            };

            this.ws.onclose = (event) => {
                console.log(`[Connection] Closed (code: ${event.code}, reason: ${event.reason})`);
                this._cleanup();
                if (this.onDisconnect) this.onDisconnect();
            };

            this.ws.onerror = (error) => {
                console.error('[Connection] Error:', error);
                if (this.onError) this.onError(error);
            };
        } catch (e) {
            console.error('[Connection] Socket initialization failed:', e);
            if (this.onError) this.onError(e);
            if (this.onDisconnect) this.onDisconnect();
        }
    }

    _handleBinaryFrame(buffer) {
        const data = new Uint8Array(buffer);
        if (data.length < 1) return;

        const type = data[0];
        const payload = data.subarray(1);
        this._byteCount += data.length;

        if (type === Connection.TYPES.VIDEO_FRAME || type === Connection.TYPES.CONFIG) {
            this._videoFrameCount++;
            if (this._videoFrameCount === 1 || this._videoFrameCount % 300 === 0) {
                console.log(`[Connection] Video frame #${this._videoFrameCount}: type=0x${type.toString(16)}, size=${payload.length}, playerNull=${this.player == null}`);
            }
        }

        switch (type) {
            case Connection.TYPES.VIDEO_FRAME:
                this._frameCount++;
                if (this.player) this.player.pushFrame(payload);
                break;

            case Connection.TYPES.CONFIG:
                if (this.player) this.player.pushConfig(payload);
                break;

            case Connection.TYPES.AUDIO_FRAME:
                if (this.audioPlayer) this.audioPlayer.playPcmChunk(payload);
                break;

            case Connection.TYPES.CONTROL: {
                const text = new TextDecoder().decode(payload);
                try {
                    this._handleControlMessage(JSON.parse(text));
                } catch (e) {
                    console.warn('[Connection] Malformed control message:', text);
                }
                break;
            }

            case Connection.TYPES.STATS: {
                const text = new TextDecoder().decode(payload);
                try {
                    const stats = JSON.parse(text);
                    if (this.onStats) this.onStats(stats);
                } catch (_) {}
                break;
            }

            case Connection.TYPES.PING:
                this._sendPong();
                break;

            case Connection.TYPES.PONG:
                if (this._lastPingTime > 0) {
                    this._latencyMs = Math.max(1, Date.now() - this._lastPingTime);
                }
                break;

            default:
                console.warn('[Connection] Unknown packet type:', type);
        }
    }

    _handleTextFrame(text) {
        try {
            const msg = JSON.parse(text);
            this._handleControlMessage(msg);
        } catch (_) {
            console.warn('[Connection] Received non-JSON text:', text);
        }
    }

    _handleControlMessage(msg) {
        console.log('[Connection] Control packet:', msg);
        switch (msg.type) {
            case 'stream_start':
                if (this.player) this.player.onStreamStart(msg.width, msg.height, msg.fps);
                break;
            case 'stream_stop':
                console.log('[Connection] Stream stopped by agent');
                this.disconnect();
                break;
            case 'orientation_change':
                if (this.player) this.player.onOrientationChange(msg.rotation || 0, msg.width, msg.height);
                break;
            case 'error':
                console.error(`[Connection] Agent Error: [${msg.code}] ${msg.message}`);
                alert(`Agent notice: ${msg.message}`);
                break;
        }
    }

    _startPingLoop() {
        this._pingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this._lastPingTime = Date.now();
                const pingPacket = new Uint8Array([Connection.TYPES.PING]);
                this.ws.send(pingPacket);
            }
        }, 2000);
    }

    _sendPong() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const pongPacket = new Uint8Array([Connection.TYPES.PONG]);
            this.ws.send(pongPacket);
        }
    }

    _startStatsLoop() {
        this._fpsInterval = setInterval(() => {
            const now = Date.now();
            const elapsedSec = (now - this._lastFpsTime) / 1000;
            const fps = Math.round(this._frameCount / elapsedSec);
            const kbps = Math.round((this._byteCount * 8) / (elapsedSec * 1000));

            this._frameCount = 0;
            this._byteCount = 0;
            this._lastFpsTime = now;

            const playerStats = (this.player && typeof this.player.getStats === 'function') ? this.player.getStats() : {};
            if (this.onStats) {
                this.onStats({
                    fps: fps,
                    kbps: kbps,
                    width: playerStats.width || 0,
                    height: playerStats.height || 0,
                    latencyMs: this._latencyMs
                });
            }
        }, 1000);
    }

    sendControl(command) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const json = JSON.stringify(command);
            const payload = new TextEncoder().encode(json);
            const packet = new Uint8Array(payload.length + 1);
            packet[0] = Connection.TYPES.CONTROL;
            packet.set(payload, 1);
            this.ws.send(packet);
        }
    }

    disconnect() {
        if (this.ws) {
            try {
                this.sendControl({ type: 'disconnect' });
                this.ws.close();
            } catch (_) {}
            this.ws = null;
        }
        this._cleanup();
    }

    _cleanup() {
        clearInterval(this._pingInterval);
        clearInterval(this._fpsInterval);
        this._pingInterval = null;
        this._fpsInterval = null;
    }
}

// Assigned on class object directly for Chromium 68 compatibility (avoids class field SyntaxError)
Connection.TYPES = {
    VIDEO_FRAME: 0x01,
    CONFIG: 0x02,
    CONTROL: 0x03,
    STATS: 0x04,
    PING: 0x05,
    PONG: 0x06,
    AUDIO_FRAME: 0x07,
};
