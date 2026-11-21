/**
 * M4raCast Low-Latency Audio Player
 * Uses Web Audio API to play streaming raw PCM 16-bit 48kHz stereo audio from agent.
 */
export class AudioPlayer {
    constructor(sampleRate = 48000, channels = 2) {
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.ctx = null;
        this.gainNode = null;
        this.nextStartTime = 0;
        this.muted = false;
        this.volume = 1.0;
        this.onMuteChange = null;

        this._packetsReceived = 0;
        this._lastLogTime = 0;
        this._firstFrameLogged = false;
    }

    /**
     * Initializes or resumes the AudioContext after a user gesture.
     */
    initContext() {
        if (!this.ctx) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) {
                console.warn('[Audio] Web Audio API not supported in this browser');
                return;
            }
            this.ctx = new AudioCtx({ sampleRate: this.sampleRate, latencyHint: 'interactive' });
            this.gainNode = this.ctx.createGain();
            this.gainNode.gain.value = this.muted ? 0.0 : this.volume;
            this.gainNode.connect(this.ctx.destination);
            console.log('[Audio] AudioContext initialized at', this.ctx.sampleRate, 'Hz');
        }

        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume().then(() => {
                console.log('[Audio] AudioContext resumed successfully');
            }).catch(err => {
                console.warn('[Audio] Could not resume AudioContext:', err);
            });
        }
    }

    /**
     * Resume on any user interaction (to satisfy browser autoplay policy).
     */
    resume() {
        this.initContext();
    }

    /**
     * Feed a raw PCM frame (16-bit signed, little-endian, stereo).
     * @param {Uint8Array} bytes 
     */
    playPcmChunk(bytes) {
        if (!bytes || bytes.byteLength < 4) return;
        this._packetsReceived++;

        if (!this._firstFrameLogged) {
            this._firstFrameLogged = true;
            console.log(`[Audio] First audio frame received from agent! (${bytes.byteLength} bytes)`);
        }

        const now = Date.now();
        if (now - this._lastLogTime > 5000) {
            console.log(`[Audio] Streaming audio: ${this._packetsReceived} packets received so far`);
            this._lastLogTime = now;
        }

        if (this.muted) return;
        this.initContext();
        if (!this.ctx) return;

        // Ensure buffer is 2-byte aligned for Int16Array
        const sampleCount = Math.floor(bytes.byteLength / 2);
        if (sampleCount < this.channels) return;

        // Copy bytes to guarantee 2-byte alignment (payload from WebSocket has odd byteOffset=1)
        const aligned = bytes.slice();
        const int16 = new Int16Array(aligned.buffer, 0, sampleCount);
        const frameCount = Math.floor(sampleCount / this.channels);

        const audioBuffer = this.ctx.createBuffer(this.channels, frameCount, this.sampleRate);
        const leftChannel = audioBuffer.getChannelData(0);
        const rightChannel = this.channels > 1 ? audioBuffer.getChannelData(1) : leftChannel;

        for (let i = 0; i < frameCount; i++) {
            // Normalize 16-bit signed integer [-32768, 32767] to float [-1.0, 1.0]
            leftChannel[i] = int16[i * 2] / 32768.0;
            rightChannel[i] = int16[i * 2 + 1] / 32768.0;
        }

        const source = this.ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.gainNode);

        const currentTime = this.ctx.currentTime;
        // Schedule next chunk seamlessly with small jitter buffer (25ms) and drift clamp
        if (this.nextStartTime < currentTime || this.nextStartTime > currentTime + 0.15) {
            this.nextStartTime = currentTime + 0.025;
        }

        source.start(this.nextStartTime);
        this.nextStartTime += audioBuffer.duration;
    }

    toggleMute() {
        this.setMuted(!this.muted);
        return this.muted;
    }

    setMuted(muted) {
        this.muted = Boolean(muted);
        if (this.gainNode) {
            this.gainNode.gain.value = this.muted ? 0.0 : this.volume;
        }
        if (!this.muted) {
            this.initContext();
        }
        if (this.onMuteChange) this.onMuteChange(this.muted);
    }

    setVolume(vol) {
        this.volume = Math.max(0.0, Math.min(1.0, vol));
        if (this.gainNode && !this.muted) {
            this.gainNode.gain.value = this.volume;
        }
    }

    destroy() {
        if (this.ctx) {
            try { this.ctx.close(); } catch (_) {}
            this.ctx = null;
            this.gainNode = null;
        }
        this.nextStartTime = 0;
        this._packetsReceived = 0;
        this._firstFrameLogged = false;
    }
}
