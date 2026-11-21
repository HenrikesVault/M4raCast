/**
 * M4raCast TV Web Client — Universal Bundle
 * Compatible with LG webOS 4.x / 5.x / 6.x (Chromium 53+).
 * No ES modules, no async/await, no BigInt, no class fields, no optional chaining.
 */
(function (window, document) {
    'use strict';

    /* =========================================================================
       1. AUDIO PLAYER
       ========================================================================= */
    function AudioPlayer() {
        this.ctx = null;
        this.gainNode = null;
        this.nextPlayTime = 0;
        this.volume = 1.0;
        this.muted = false;
        this.sampleRate = 48000;
        this.channels = 2;
        this.onMuteChange = null;
        this._initialized = false;
        this._firstChunkReceived = false;
    }

    AudioPlayer.prototype.initContext = function () {
        if (this._initialized && this.ctx) {
            if (this.ctx.state === 'suspended') {
                this.ctx.resume();
            }
            return;
        }
        var AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) {
            console.warn('[Audio] Web Audio API not supported');
            return;
        }
        try {
            this.ctx = new AudioCtx({ sampleRate: this.sampleRate });
        } catch (_) {
            this.ctx = new AudioCtx();
            // Do NOT overwrite this.sampleRate — incoming PCM is always 48000 Hz.
            // We pass 48000 explicitly to createBuffer so the Web Audio engine resamples.
        }
        // Immediately try to resume — on webOS the context starts suspended.
        // This call is inside a user-gesture callback (click/OK), so it should succeed.
        try { this.ctx.resume(); } catch (_) {}
        try {
            this.gainNode = this.ctx.createGain();
            this.gainNode.gain.value = this.muted ? 0.0 : this.volume;
            this.gainNode.connect(this.ctx.destination);
            this.nextPlayTime = this.ctx.currentTime;
            this._initialized = true;
            console.log('[Audio] AudioContext initialized at ' + this.ctx.sampleRate + ' Hz (target 48000)');
        } catch (e) {
            console.warn('[Audio] Gain node creation failed:', e);
        }
    };

    AudioPlayer.prototype.playPcmChunk = function (pcmBytes) {
        if (!this._firstChunkReceived) {
            this._firstChunkReceived = true;
            console.log('[Audio] First audio frame received from agent (' + pcmBytes.length + ' bytes)');
        }
        if (this.muted) return;
        if (!this.ctx || this.ctx.state === 'suspended') {
            this.initContext();
        }
        if (!this.ctx) return;

        var byteOffset = pcmBytes.byteOffset;
        var byteLength = pcmBytes.byteLength;
        var pcm16;

        if (byteOffset % 2 === 0) {
            pcm16 = new Int16Array(pcmBytes.buffer, byteOffset, Math.floor(byteLength / 2));
        } else {
            var aligned = new Uint8Array(byteLength);
            aligned.set(pcmBytes);
            pcm16 = new Int16Array(aligned.buffer, 0, Math.floor(byteLength / 2));
        }

        var numFrames = Math.floor(pcm16.length / this.channels);
        if (numFrames <= 0) return;

        var audioBuffer = this.ctx.createBuffer(this.channels, numFrames, 48000);
        var left = audioBuffer.getChannelData(0);
        var right = this.channels > 1 ? audioBuffer.getChannelData(1) : left;

        for (var i = 0; i < numFrames; i++) {
            left[i] = pcm16[i * this.channels] / 32768.0;
            if (this.channels > 1) {
                right[i] = pcm16[i * this.channels + 1] / 32768.0;
            }
        }

        var source = this.ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.gainNode);

        var now = this.ctx.currentTime;
        if (this.nextPlayTime < now + 0.005 || this.nextPlayTime > now + 0.4) {
            // Reset if starved (behind) or too far ahead (drift > 400ms)
            this.nextPlayTime = now + 0.02;
        }
        source.start(this.nextPlayTime);
        this.nextPlayTime += audioBuffer.duration;
    };

    AudioPlayer.prototype.toggleMute = function () {
        this.setMuted(!this.muted);
        return this.muted;
    };

    AudioPlayer.prototype.setMuted = function (muted) {
        this.muted = Boolean(muted);
        if (this.gainNode) {
            this.gainNode.gain.value = this.muted ? 0.0 : this.volume;
        }
        if (!this.muted) {
            this.initContext();
        }
        if (this.onMuteChange) this.onMuteChange(this.muted);
    };

    AudioPlayer.prototype.setVolume = function (vol) {
        this.volume = Math.max(0.0, Math.min(1.0, vol));
        if (this.gainNode && !this.muted) {
            this.gainNode.gain.value = this.volume;
        }
    };

    AudioPlayer.prototype.resume = function () {
        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
    };

    AudioPlayer.prototype.destroy = function () {
        if (this.ctx) {
            try { this.ctx.close(); } catch (_) {}
            this.ctx = null;
        }
        this._initialized = false;
        this._firstChunkReceived = false;
    };

    /* =========================================================================
       2. CROPPER HELPER
       ========================================================================= */
    function Cropper(sourceEl, targetCanvas) {
        this.source = sourceEl;
        this.canvas = targetCanvas;
        this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
        this.crop = { top: 0, bottom: 0, left: 0, right: 0 };
        this._animId = null;
        this.onCropChange = null;
    }

    Cropper.prototype.isCropActive = function () {
        return this.crop.top > 0 || this.crop.bottom > 0 || this.crop.left > 0 || this.crop.right > 0;
    };

    Cropper.prototype.setCrop = function (cropValues) {
        this.crop.top = Math.max(0, parseInt(cropValues.top, 10) || 0);
        this.crop.bottom = Math.max(0, parseInt(cropValues.bottom, 10) || 0);
        this.crop.left = Math.max(0, parseInt(cropValues.left, 10) || 0);
        this.crop.right = Math.max(0, parseInt(cropValues.right, 10) || 0);

        if (this.isCropActive()) {
            this._startRenderLoop();
        } else {
            this._stopRenderLoop();
        }
        if (this.onCropChange) this.onCropChange(this.crop);
    };

    Cropper.prototype.applyAspectRatioPreset = function (preset) {
        var sw = this.source.videoWidth || this.source.width || 1920;
        var sh = this.source.videoHeight || this.source.height || 1080;
        var ratios = {
            '16:9': 16 / 9,
            '16:10': 16 / 10,
            '4:3': 4 / 3,
            '21:9': 21 / 9,
            '9:16': 9 / 16
        };
        if (!ratios[preset]) {
            this.setCrop({ top: 0, bottom: 0, left: 0, right: 0 });
            return this.crop;
        }
        var targetRatio = ratios[preset];
        var curRatio = sw / sh;
        var newCrop = { top: 0, bottom: 0, left: 0, right: 0 };

        if (curRatio > targetRatio) {
            var targetW = sh * targetRatio;
            var cutW = Math.round((sw - targetW) / 2);
            newCrop.left = cutW;
            newCrop.right = cutW;
        } else {
            var targetH = sw / targetRatio;
            var cutH = Math.round((sh - targetH) / 2);
            newCrop.top = cutH;
            newCrop.bottom = cutH;
        }
        this.setCrop(newCrop);
        return this.crop;
    };

    Cropper.prototype._startRenderLoop = function () {
        if (this._animId) return;
        if (this.canvas) this.canvas.style.display = 'block';
        if (this.source) this.source.style.display = 'none';
        var self = this;
        function loop() {
            self._render();
            self._animId = requestAnimationFrame(loop);
        }
        this._animId = requestAnimationFrame(loop);
    };

    Cropper.prototype._stopRenderLoop = function () {
        if (this._animId) {
            cancelAnimationFrame(this._animId);
            this._animId = null;
        }
        if (this.canvas) this.canvas.style.display = 'none';
        if (this.source) this.source.style.display = 'block';
    };

    Cropper.prototype._render = function () {
        if (!this.ctx || !this.source) return;
        var sw = this.source.videoWidth || this.source.width || 1920;
        var sh = this.source.videoHeight || this.source.height || 1080;
        var sx = this.crop.left;
        var sy = this.crop.top;
        var sCropW = Math.max(1, sw - this.crop.left - this.crop.right);
        var sCropH = Math.max(1, sh - this.crop.top - this.crop.bottom);

        if (this.canvas.width !== sCropW || this.canvas.height !== sCropH) {
            this.canvas.width = sCropW;
            this.canvas.height = sCropH;
        }
        try {
            this.ctx.drawImage(this.source, sx, sy, sCropW, sCropH, 0, 0, sCropW, sCropH);
        } catch (_) {}
    };

    Cropper.prototype.reset = function () {
        this.setCrop({ top: 0, bottom: 0, left: 0, right: 0 });
    };

    Cropper.prototype.destroy = function () {
        this._stopRenderLoop();
    };

    /* =========================================================================
       3. VIDEO PLAYER (Dual-Mode: WebCodecs or MSE fMP4)
       ========================================================================= */
    function Player(canvasEl, videoEl) {
        this.canvas = canvasEl;
        this.video = videoEl;
        this.ctx = this.canvas ? this.canvas.getContext('2d', { alpha: false }) : null;

        this._useWebCodecs = typeof window.VideoDecoder === 'function';
        this._useMSE = !this._useWebCodecs && typeof window.MediaSource === 'function';

        this._decoder = null;
        this._configData = null;
        this._codecStr = null;
        this._firstKeyframeReceived = false;

        // MSE state
        this._ms = null;
        this._sb = null;
        this._mseReady = false;
        this._mseQueue = [];
        this._mseInitSent = false;
        this._pendingMSECodec = null;
        this._mseSourceOpen = false;
        this._mseSeq = 0;

        this._spsRbsp = null;
        this._ppsRbsp = null;
        this._frameWidth = 0;
        this._frameHeight = 0;

        this._width = 1920;
        this._height = 1080;
        this._fps = 30;
        this._rotation = 0;
        this._zoom = 1.0;
        this._scaleMode = 'fit';
        this._frameLogCount = 0;

        this.onFrameDecoded = null;

        console.log('[Player] Mode: ' + (this._useWebCodecs ? 'WebCodecs' : (this._useMSE ? 'MSE/fMP4' : 'NONE')));
        this._initDecoder();
        this.setScaleMode('fit');
    }

    Player.prototype._initDecoder = function () {
        if (this._useWebCodecs) {
            try {
                var self = this;
                this._decoder = new VideoDecoder({
                    output: function (videoFrame) { self._renderFrame(videoFrame); },
                    error: function (err) {
                        console.error('[Player] WebCodecs decode error:', err);
                        self._firstKeyframeReceived = false;
                    }
                });
            } catch (e) {
                console.warn('[Player] VideoDecoder failed, falling back to MSE');
                this._useWebCodecs = false;
                this._useMSE = typeof window.MediaSource === 'function';
            }
        }

        if (!this._useWebCodecs && this._useMSE) {
            this._initMSE();
        }

        if (this._useWebCodecs) {
            if (this.canvas) this.canvas.style.display = 'block';
            if (this.video) this.video.style.display = 'none';
        if (!this._useWebCodecs && this._useMSE) {
            if (this.canvas) this.canvas.style.display = 'none';
            if (this.video) {
                this.video.style.display = 'block';
                this.video.style.width = '100%';
                this.video.style.height = '100%';
                this.video.style.objectFit = 'contain';
                // CRITICAL: transparent background — opaque bg masks hardware video plane on webOS
                this.video.style.background = 'transparent';
                // CRITICAL: no CSS transforms on video element — breaks webOS hardware punch-through
                this.video.style.webkitTransform = 'none';
                this.video.style.transform = 'none';
                this.video.style.transition = 'none';
            }
        }
    };

    Player.prototype._initMSE = function () {
        var ms = new MediaSource();
        this._ms = ms;
        this.video.src = URL.createObjectURL(ms);
        if (this.video) {
            this.video.muted = true;
            this.video.autoplay = true;
            this.video.playsInline = true;
            this.video.setAttribute('playsinline', '');
            this.video.setAttribute('webkit-playsinline', '');
        }
        var self = this;

        ms.addEventListener('sourceopen', function () {
            console.log('[Player] MSE sourceopen');
            self._mseSourceOpen = true;
            if (self._pendingMSECodec) {
                self._createSourceBuffer(self._pendingMSECodec);
                self._pendingMSECodec = null;
            }
        });

        this.video.addEventListener('canplay', function () {
            console.log('[Player] MSE canplay');
            var p = self.video.play();
            if (p && typeof p.catch === 'function') {
                p.catch(function (err) { console.warn('[Player] play() failed:', err); });
            }
        });
    };

    Player.prototype._createSourceBuffer = function (mimeType) {
        if (!this._ms || this._ms.readyState !== 'open') {
            this._pendingMSECodec = mimeType;
            return;
        }
        var candidates = [
            mimeType,
            'video/mp4; codecs="avc1.42E01E"',
            'video/mp4; codecs="avc1.42001e"',
            'video/mp4; codecs="avc1.4d401f"',
            'video/mp4; codecs="avc1.640028"',
            'video/mp4; codecs="avc1.42001f"',
            'video/mp4'
        ];
        var sb = null;
        for (var i = 0; i < candidates.length; i++) {
            var candidate = candidates[i];
            if (!candidate) continue;
            try {
                if (window.MediaSource && MediaSource.isTypeSupported && !MediaSource.isTypeSupported(candidate)) {
                    continue;
                }
                console.log('[Player] Attempting SourceBuffer with candidate:', candidate);
                sb = this._ms.addSourceBuffer(candidate);
                console.log('[Player] SourceBuffer created successfully with:', candidate);
                break;
            } catch (err) {
                console.warn('[Player] Candidate failed (' + candidate + '):', err);
            }
        }
        if (!sb) {
            console.error('[Player] All SourceBuffer candidates failed!');
            return;
        }
        try {
            sb.mode = 'sequence';
        } catch (_) {}
        this._sb = sb;
        var self = this;
        sb.addEventListener('updateend', function () { self._flushMSEQueue(); });
        sb.addEventListener('error', function (e) { console.error('[Player] SourceBuffer error:', e); });
        this._mseReady = true;
        this._flushMSEQueue();
    };

    Player.prototype._appendMSE = function (segment) {
        this._mseQueue.push(segment);
        this._flushMSEQueue();
    };

    Player.prototype._flushMSEQueue = function () {
        if (!this._sb || this._sb.updating || this._mseQueue.length === 0) return;
        var seg = this._mseQueue.shift();
        try {
            this._sb.appendBuffer(seg);
            if (this.video && this.video.paused) {
                var p = this.video.play();
                if (p && typeof p.catch === 'function') {
                    p.catch(function () {});
                }
            }
        } catch (e) {
            console.warn('[Player] appendBuffer error:', e.message);
            if (e.name === 'QuotaExceededError') {
                try {
                    if (this._sb.buffered.length > 0) {
                        var start = this._sb.buffered.start(0);
                        var end = this._sb.buffered.end(0);
                        if (end - 2 > start) this._sb.remove(start, end - 2);
                    }
                } catch (_) {}
            }
        }
    };

    Player.prototype.pushConfig = function (configBytes) {
        this._configData = configBytes;
        this._firstKeyframeReceived = false;
        this._mseInitSent = false;

        this._parseSPSPPSFromAnnexB(configBytes);
        var codecStr = this._deriveCodecStr(configBytes) || 'avc1.42001f';
        this._codecStr = codecStr;

        if (this._useWebCodecs) {
            this._configureWebCodecs(codecStr);
        } else if (this._useMSE) {
            var mimeType = 'video/mp4; codecs="' + codecStr + '"';
            if (this._mseSourceOpen && !this._sb) {
                this._createSourceBuffer(mimeType);
            } else if (!this._mseSourceOpen) {
                this._pendingMSECodec = mimeType;
            }
        }
    };

    Player.prototype._configureWebCodecs = function (codecStr) {
        if (this._decoder && this._decoder.state !== 'unconfigured') {
            try { this._decoder.close(); } catch (_) {}
            this._decoder = null;
        }
        var self = this;
        if (!this._decoder) {
            try {
                this._decoder = new VideoDecoder({
                    output: function (vf) { self._renderFrame(vf); },
                    error: function (err) {
                        console.error('[Player] WebCodecs error:', err);
                        self._firstKeyframeReceived = false;
                    }
                });
            } catch (e) {
                console.error('[Player] Failed to recreate decoder:', e);
                return;
            }
        }
        try {
            this._decoder.configure({ codec: codecStr, optimizeForLatency: true });
        } catch (_) {
            try { this._decoder.configure({ codec: 'avc1.42001f', optimizeForLatency: true }); } catch (_) {}
        }
    };

    Player.prototype.pushFrame = function (payload) {
        if (payload.length < 10) return;

        this._frameLogCount++;
        if (this._frameLogCount === 1 || this._frameLogCount % 300 === 0) {
            console.log('[Player] Frame #' + this._frameLogCount + ' len=' + payload.length + ' mode=' + (this._useWebCodecs ? 'WebCodecs' : 'MSE'));
        }

        // Standard integer PTS extraction (no BigInt, 100% Chromium 53 safe)
        var pts = 0;
        for (var i = 0; i < 8; i++) {
            pts = (pts * 256) + payload[i];
        }
        var nalData = payload.subarray(9);

        // NAL scan: detect IDR (5), SPS (7), PPS (8)
        var hasIdr = false, hasSps = false;
        var limit = Math.min(128, nalData.length - 4);
        for (var j = 0; j < limit; j++) {
            var is4 = nalData[j] === 0 && nalData[j+1] === 0 && nalData[j+2] === 0 && nalData[j+3] === 1;
            var is3 = nalData[j] === 0 && nalData[j+1] === 0 && nalData[j+2] === 1;
            if (is4 || is3) {
                var off = is4 ? j + 4 : j + 3;
                if (off < nalData.length) {
                    var t = nalData[off] & 0x1f;
                    if (t === 5) hasIdr = true;
                    if (t === 7) hasSps = true;
                }
            }
        }
        var isKeyframe = (payload[8] === 0x01) || hasIdr || hasSps;

        if (hasSps && !this._configData) {
            this._configData = nalData;
            this._parseSPSPPSFromAnnexB(nalData);
            if (!this._sb && this._useMSE) {
                var codecStr = this._deriveCodecStr(nalData) || 'avc1.42001f';
                var mimeType = 'video/mp4; codecs="' + codecStr + '"';
                if (this._mseSourceOpen) {
                    this._createSourceBuffer(mimeType);
                } else {
                    this._pendingMSECodec = mimeType;
                }
            }
        }

        if (this._useWebCodecs) {
            this._pushFrameWebCodecs(pts, nalData, isKeyframe, hasSps);
        } else if (this._useMSE) {
            this._pushFrameMSE(nalData, isKeyframe);
        }
    };

    Player.prototype._pushFrameWebCodecs = function (pts, nalData, isKeyframe, hasSps) {
        if (!this._decoder || this._decoder.state === 'closed') {
            this._initDecoder();
            if (this._configData) this._configureWebCodecs(this._codecStr || 'avc1.42001f');
        }
        if (this._decoder && this._decoder.state === 'unconfigured') {
            if (this._configData) this._configureWebCodecs(this._codecStr || 'avc1.42001f');
            else { try { this._decoder.configure({ codec: 'avc1.42001f', optimizeForLatency: true }); } catch (_) {} }
        }
        if (!this._decoder || this._decoder.state !== 'configured') return;
        if (!isKeyframe && !this._firstKeyframeReceived) return;

        try {
            var chunkData = nalData;
            if (isKeyframe && this._configData && !hasSps) {
                var merged = new Uint8Array(this._configData.length + nalData.length);
                merged.set(this._configData, 0);
                merged.set(nalData, this._configData.length);
                chunkData = merged;
            }
            this._decoder.decode(new EncodedVideoChunk({
                type: isKeyframe ? 'key' : 'delta',
                timestamp: pts,
                data: chunkData
            }));
            if (isKeyframe) this._firstKeyframeReceived = true;
        } catch (e) {
            if (this._decoder.state === 'closed') this._firstKeyframeReceived = false;
        }
    };

    Player.prototype._pushFrameMSE = function (nalData, isKeyframe) {
        if (!this._mseReady || !this._sb) return;
        if (!isKeyframe && !this._firstKeyframeReceived) return;

        if (isKeyframe && !this._mseInitSent) {
            if (!this._spsRbsp || !this._ppsRbsp) return;
            var w = this._frameWidth || this._width;
            var h = this._frameHeight || this._height;
            var init = this._buildFMP4Init(w, h, this._spsRbsp, this._ppsRbsp);
            this._appendMSE(init);
            this._mseInitSent = true;
            console.log('[Player] MSE init segment sent: ' + w + 'x' + h);
        }
        if (!this._mseInitSent) return;

        var annexB = this._ensureAnnexB(nalData);
        var avcc = this._annexBToAVCC(annexB);
        if (avcc.length === 0) return;
        var moof = this._buildMoof(++this._mseSeq, avcc.length, isKeyframe);
        var mdat = this._buildMdat(avcc);

        var segment = new Uint8Array(moof.byteLength + mdat.byteLength);
        segment.set(new Uint8Array(moof), 0);
        segment.set(new Uint8Array(mdat), moof.byteLength);
        this._appendMSE(segment);

        if (isKeyframe) this._firstKeyframeReceived = true;
    };

    Player.prototype._parseSPSPPSFromAnnexB = function (data) {
        var i = 0;
        var len = data.length;
        while (i < len - 3) {
            var nalStart = -1;
            if (data[i]===0 && data[i+1]===0 && data[i+2]===0 && data[i+3]===1) {
                nalStart = i + 4; i += 4;
            } else if (data[i]===0 && data[i+1]===0 && data[i+2]===1) {
                nalStart = i + 3; i += 3;
            } else { i++; continue; }

            var nalEnd = len;
            for (var j = nalStart; j < len - 2; j++) {
                if (data[j]===0 && data[j+1]===0 && (data[j+2]===1 || (data[j+2]===0 && j+3<len && data[j+3]===1))) {
                    nalEnd = j; break;
                }
            }
            var nalType = data[nalStart] & 0x1f;
            var rbsp = data.subarray(nalStart, nalEnd);
            if (nalType === 7) {
                this._spsRbsp = rbsp.slice();
            } else if (nalType === 8) {
                this._ppsRbsp = rbsp.slice();
            }
            i = nalEnd;
        }
    };

    Player.prototype._ensureAnnexB = function (data) {
        if (data.length >= 4 && data[0]===0 && data[1]===0 && data[2]===0 && data[3]===1) return data;
        if (data.length >= 3 && data[0]===0 && data[1]===0 && data[2]===1) return data;
        var out = new Uint8Array(data.length + 4);
        out[0]=0; out[1]=0; out[2]=0; out[3]=1;
        out.set(data, 4);
        return out;
    };

    Player.prototype._annexBToAVCC = function (annexB) {
        var nals = [];
        var i = 0;
        var len = annexB.length;
        while (i < len) {
            var nalStart = -1;
            if (i + 3 < len && annexB[i]===0 && annexB[i+1]===0 && annexB[i+2]===0 && annexB[i+3]===1) {
                nalStart = i + 4; i += 4;
            } else if (i + 2 < len && annexB[i]===0 && annexB[i+1]===0 && annexB[i+2]===1) {
                nalStart = i + 3; i += 3;
            } else { i++; continue; }

            var nalEnd = len;
            for (var j = nalStart; j < len - 2; j++) {
                if (annexB[j]===0 && annexB[j+1]===0 &&
                    (annexB[j+2]===1 || (j+3<len && annexB[j+2]===0 && annexB[j+3]===1))) {
                    nalEnd = j; break;
                }
            }
            if (nalEnd > nalStart) {
                var nal = annexB.subarray(nalStart, nalEnd);
                var nalType = nal[0] & 0x1f;
                if (nalType !== 7 && nalType !== 8) {
                    nals.push(nal);
                }
            }
            i = nalEnd;
        }

        var totalLen = 0;
        for (var k = 0; k < nals.length; k++) totalLen += 4 + nals[k].length;
        var out = new Uint8Array(totalLen);
        var off = 0;
        for (var n = 0; n < nals.length; n++) {
            var nal = nals[n];
            var l = nal.length;
            out[off] = (l >>> 24) & 0xFF;
            out[off+1] = (l >>> 16) & 0xFF;
            out[off+2] = (l >>> 8) & 0xFF;
            out[off+3] = l & 0xFF;
            out.set(nal, off + 4);
            off += 4 + l;
        }
        return out;
    };

    Player.prototype._w32 = function (dv, off, v) { dv.setUint32(off, v >>> 0, false); return off + 4; };
    Player.prototype._boxHdr = function (dv, off, size, type) {
        off = this._w32(dv, off, size);
        for (var i = 0; i < 4; i++) dv.setUint8(off + i, type.charCodeAt(i));
        return off + 4;
    };

    Player.prototype._buildFMP4Init = function (width, height, spsRbsp, ppsRbsp) {
        var spsLen = spsRbsp.length;
        var ppsLen = ppsRbsp.length;

        // Derive the size from the brand list so the buffer can never be
        // smaller than the bytes written into it (that caused a DataView OOB).
        var compatibleBrands = ['iso5', 'iso6', 'mp41'];
        var ftypSize = 16 + compatibleBrands.length * 4;
        var ftyp = new ArrayBuffer(ftypSize);
        var ftypDv = new DataView(ftyp);
        var o = this._boxHdr(ftypDv, 0, ftypSize, 'ftyp');
        for (var mi = 0; mi < 4; mi++) ftypDv.setUint8(o + mi, 'iso5'.charCodeAt(mi));
        o += 4;
        o = this._w32(ftypDv, o, 512);
        for (var bi = 0; bi < compatibleBrands.length; bi++) {
            var brand = compatibleBrands[bi];
            for (var bj = 0; bj < 4; bj++) ftypDv.setUint8(o + bj, brand.charCodeAt(bj));
            o += 4;
        }

        var avcCPayload = 4 + 1 + 1 + 2 + spsLen + 1 + 2 + ppsLen;
        var avcCSize = 8 + avcCPayload;
        var avc1Size = 6+2+16+2+2+4+4+4+2+32+2+2 + avcCSize + 8;

        var urlBoxSize = 12;
        var drefSize = 8 + 4 + 4 + urlBoxSize;
        var dinfSize = 8 + drefSize;
        var vmhdSize = 20;
        var stsdSize = 16 + avc1Size;
        var sttsSize = 16, stscSize = 16, stcoSize = 16, stszSize = 20;
        var stblSize = 8 + stsdSize + sttsSize + stscSize + stszSize + stcoSize;
        var minfSize = 8 + vmhdSize + dinfSize + stblSize;
        var mdhdSize = 32, hdlrSize = 45;
        var mdiaSize = 8 + mdhdSize + hdlrSize + minfSize;
        var tkhdSize = 92;
        var trakSize = 8 + tkhdSize + mdiaSize;
        var mvhdSize = 108, trexSize = 32, mvexSize = 8 + trexSize;
        var moovSize = 8 + mvhdSize + trakSize + mvexSize;
        var totalSize = ftyp.byteLength + moovSize;

        var buf = new ArrayBuffer(totalSize);
        var dv = new DataView(buf);
        var u8 = new Uint8Array(buf);

        u8.set(new Uint8Array(ftyp), 0);
        o = ftyp.byteLength;

        o = this._boxHdr(dv, o, moovSize, 'moov');
        o = this._boxHdr(dv, o, mvhdSize, 'mvhd');
        o = this._w32(dv, o, 0); o = this._w32(dv, o, 0); o = this._w32(dv, o, 0);
        o = this._w32(dv, o, 90000); o = this._w32(dv, o, 0); o = this._w32(dv, o, 0x00010000);
        dv.setUint16(o, 0x0100, false); o += 2;
        o += 10;
        var matrix = [0x00010000,0,0, 0,0x00010000,0, 0,0,0x40000000];
        var self = this;
        matrix.forEach(function (v) { o = self._w32(dv, o, v); });
        o += 24;
        o = this._w32(dv, o, 2);

        o = this._boxHdr(dv, o, trakSize, 'trak');
        o = this._boxHdr(dv, o, tkhdSize, 'tkhd');
        o = this._w32(dv, o, 0x00000003); o = this._w32(dv, o, 0); o = this._w32(dv, o, 0);
        o = this._w32(dv, o, 1); o = this._w32(dv, o, 0); o = this._w32(dv, o, 0);
        o += 8;
        dv.setUint16(o, 0, false); o += 2;
        dv.setUint16(o, 0, false); o += 2;
        dv.setUint16(o, 0, false); o += 2;
        o += 2;
        matrix.forEach(function (v) { o = self._w32(dv, o, v); });
        o = this._w32(dv, o, width << 16);
        o = this._w32(dv, o, height << 16);

        o = this._boxHdr(dv, o, mdiaSize, 'mdia');
        o = this._boxHdr(dv, o, mdhdSize, 'mdhd');
        o = this._w32(dv, o, 0); o = this._w32(dv, o, 0); o = this._w32(dv, o, 0);
        o = this._w32(dv, o, 90000); o = this._w32(dv, o, 0);
        dv.setUint16(o, 0x55C4, false); o += 2;
        dv.setUint16(o, 0, false); o += 2;

        o = this._boxHdr(dv, o, hdlrSize, 'hdlr');
        o = this._w32(dv, o, 0); o = this._w32(dv, o, 0);
        'vide'.split('').forEach(function (c, idx) { dv.setUint8(o + idx, c.charCodeAt(0)); }); o += 4;
        o += 12;
        'VideoHandler\0'.split('').forEach(function (c, idx) { dv.setUint8(o + idx, c.charCodeAt(0)); }); o += 13;

        o = this._boxHdr(dv, o, minfSize, 'minf');
        o = this._boxHdr(dv, o, vmhdSize, 'vmhd');
        o = this._w32(dv, o, 1); o += 8;

        o = this._boxHdr(dv, o, dinfSize, 'dinf');
        o = this._boxHdr(dv, o, drefSize, 'dref');
        o = this._w32(dv, o, 0); o = this._w32(dv, o, 1);
        o = this._boxHdr(dv, o, urlBoxSize, 'url ');
        o = this._w32(dv, o, 1);

        o = this._boxHdr(dv, o, stblSize, 'stbl');
        o = this._boxHdr(dv, o, stsdSize, 'stsd');
        o = this._w32(dv, o, 0); o = this._w32(dv, o, 1);

        o = this._boxHdr(dv, o, avc1Size, 'avc1');
        o += 6; dv.setUint16(o, 1, false); o += 2; o += 16;
        dv.setUint16(o, width, false); o += 2;
        dv.setUint16(o, height, false); o += 2;
        o = this._w32(dv, o, 0x00480000); o = this._w32(dv, o, 0x00480000);
        o = this._w32(dv, o, 0); dv.setUint16(o, 1, false); o += 2;
        o += 32; dv.setUint16(o, 0x0018, false); o += 2;
        dv.setInt16(o, -1, false); o += 2;

        o = this._boxHdr(dv, o, avcCSize, 'avcC');
        dv.setUint8(o, 1); o++;
        dv.setUint8(o, spsRbsp[1]); o++;
        dv.setUint8(o, spsRbsp[2]); o++;
        dv.setUint8(o, spsRbsp[3]); o++;
        dv.setUint8(o, 0xFF); o++;
        dv.setUint8(o, 0xE1); o++;
        dv.setUint16(o, spsLen, false); o += 2;
        u8.set(spsRbsp, o); o += spsLen;
        dv.setUint8(o, 1); o++;
        dv.setUint16(o, ppsLen, false); o += 2;
        u8.set(ppsRbsp, o); o += ppsLen;

        o = this._boxHdr(dv, o, sttsSize, 'stts'); o = this._w32(dv, o, 0); o = this._w32(dv, o, 0);
        o = this._boxHdr(dv, o, stscSize, 'stsc'); o = this._w32(dv, o, 0); o = this._w32(dv, o, 0);
        o = this._boxHdr(dv, o, stszSize, 'stsz'); o = this._w32(dv, o, 0); o = this._w32(dv, o, 0); o = this._w32(dv, o, 0);
        o = this._boxHdr(dv, o, stcoSize, 'stco'); o = this._w32(dv, o, 0); o = this._w32(dv, o, 0);

        o = this._boxHdr(dv, o, mvexSize, 'mvex');
        o = this._boxHdr(dv, o, trexSize, 'trex');
        o = this._w32(dv, o, 0); o = this._w32(dv, o, 1); o = this._w32(dv, o, 1);
        o = this._w32(dv, o, 0); o = this._w32(dv, o, 0); o = this._w32(dv, o, 0);

        return buf;
    };

    Player.prototype._buildMoof = function (seqNum, payloadSize, isKeyframe) {
        var trunSize = 8 + 4 + 4 + 4 + 12;
        var tfhdSize = 8 + 4 + 4;
        var tfdtSize = 8 + 4 + 4;
        var trafSize = 8 + tfhdSize + tfdtSize + trunSize;
        var mfhdSize = 8 + 4 + 4;
        var moofSize = 8 + mfhdSize + trafSize;

        var buf = new ArrayBuffer(moofSize);
        var dv = new DataView(buf);
        var o = 0;

        o = this._boxHdr(dv, o, moofSize, 'moof');
        o = this._boxHdr(dv, o, mfhdSize, 'mfhd');
        o = this._w32(dv, o, 0); o = this._w32(dv, o, seqNum);

        o = this._boxHdr(dv, o, trafSize, 'traf');
        o = this._boxHdr(dv, o, tfhdSize, 'tfhd');
        o = this._w32(dv, o, 0x020000); o = this._w32(dv, o, 1);

        // tfdt (Track Fragment Base Media Decode Time) - mandatory for Chromium MSE demuxer
        var decodeTime = (seqNum - 1) * 3000;
        o = this._boxHdr(dv, o, tfdtSize, 'tfdt');
        o = this._w32(dv, o, 0);
        o = this._w32(dv, o, decodeTime);

        o = this._boxHdr(dv, o, trunSize, 'trun');
        o = this._w32(dv, o, 0x000701); o = this._w32(dv, o, 1);
        o = this._w32(dv, o, moofSize + 8);
        o = this._w32(dv, o, 3000);
        o = this._w32(dv, o, payloadSize);
        o = this._w32(dv, o, isKeyframe ? 0x02000000 : 0x01010000);

        return buf;
    };

    Player.prototype._buildMdat = function (avcc) {
        var size = 8 + avcc.length;
        var buf = new ArrayBuffer(size);
        var dv = new DataView(buf);
        this._boxHdr(dv, 0, size, 'mdat');
        new Uint8Array(buf).set(avcc, 8);
        return buf;
    };

    Player.prototype._renderFrame = function (videoFrame) {
        try {
            var frameW = videoFrame.displayWidth || videoFrame.codedWidth;
            var frameH = videoFrame.displayHeight || videoFrame.codedHeight;
            if (frameW && frameH && (this.canvas.width !== frameW || this.canvas.height !== frameH)) {
                this.canvas.width = frameW;
                this.canvas.height = frameH;
                this._width = frameW;
                this._height = frameH;
            }
            this.ctx.drawImage(videoFrame, 0, 0, this.canvas.width, this.canvas.height);
        } catch (e) {
            console.error('[Player] drawImage error:', e);
        } finally {
            videoFrame.close();
        }
        if (this.onFrameDecoded) this.onFrameDecoded(this.canvas);
    };

    Player.prototype._deriveCodecStr = function (configBytes) {
        for (var i = 0; i < Math.min(16, configBytes.length - 4); i++) {
            var is4 = configBytes[i]===0 && configBytes[i+1]===0 && configBytes[i+2]===0 && configBytes[i+3]===1;
            var is3 = configBytes[i]===0 && configBytes[i+1]===0 && configBytes[i+2]===1;
            var nalOff = is4 ? i + 4 : (is3 ? i + 3 : -1);
            if (nalOff < 0) continue;
            var nalType = configBytes[nalOff] & 0x1f;
            if (nalType === 7 && configBytes.length > nalOff + 3) {
                var p = configBytes[nalOff+1], c = configBytes[nalOff+2], l = configBytes[nalOff+3];
                var toHex = function(n) { return (n < 16 ? '0' : '') + n.toString(16); };
                return 'avc1.' + toHex(p) + toHex(c) + toHex(l);
            }
        }
        if (configBytes.length >= 4 && (configBytes[0] & 0x1f) === 7) {
            var p1 = configBytes[1], c1 = configBytes[2], l1 = configBytes[3];
            var toHex1 = function(n) { return (n < 16 ? '0' : '') + n.toString(16); };
            return 'avc1.' + toHex1(p1) + toHex1(c1) + toHex1(l1);
        }
        return 'avc1.42001f';
    };

    Player.prototype.onStreamStart = function (width, height, fps) {
        this._width = width;
        this._height = height;
        this._fps = fps;
        this._frameWidth = width;
        this._frameHeight = height;
        if (this._useWebCodecs && this.canvas) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
    };

    Player.prototype.onOrientationChange = function (rotation, width, height) {
        if (width && height) {
            this._width = width;
            this._height = height;
            this._frameWidth = width;
            this._frameHeight = height;
            if (this._useWebCodecs && this.canvas) {
                this.canvas.width = width;
                this.canvas.height = height;
            }
            this._rotation = 0;
        } else {
            this._rotation = rotation || 0;
        }
        this._updateTransforms();
        this.setScaleMode(this._scaleMode);
    };

    Player.prototype.rotate90 = function () {
        this._rotation = (this._rotation + 90) % 360;
        this._updateTransforms();
        return this._rotation;
    };

    Player.prototype.setScaleMode = function (mode) {
        this._scaleMode = mode;
        var cropCanvas = document.getElementById('crop-canvas');
        var targets = this._useWebCodecs
            ? [this.canvas, cropCanvas]
            : [this.video, cropCanvas];

        for (var i = 0; i < targets.length; i++) {
            var target = targets[i];
            if (!target) continue;
            switch (mode) {
                case 'fit':
                    target.style.width = '100%';
                    target.style.height = '100%';
                    target.style.objectFit = 'contain';
                    this._zoom = 1.0;
                    break;
                case 'fill':
                    target.style.width = '100%';
                    target.style.height = '100%';
                    target.style.objectFit = 'cover';
                    this._zoom = 1.0;
                    break;
                case 'original':
                    target.style.width = this._width + 'px';
                    target.style.height = this._height + 'px';
                    target.style.objectFit = 'none';
                    this._zoom = 1.0;
                    break;
                case 'custom':
                    target.style.objectFit = 'contain';
                    break;
            }
        }
        this._updateTransforms();
    };

    Player.prototype.setZoom = function (factor) {
        this._zoom = Math.max(0.2, Math.min(6.0, factor));
        this._updateTransforms();
    };

    Player.prototype.resetView = function () {
        this._zoom = 1.0;
        this._rotation = 0;
        this.setScaleMode('fit');
    };

    Player.prototype._updateTransforms = function () {
        var cropCanvas = document.getElementById('crop-canvas');
        // CRITICAL: Never apply CSS transforms to this.video on webOS!
        // CSS transform breaks the hardware video punch-through plane, causing black screen.
        // Transforms are only applied to canvas (WebCodecs path) or crop-canvas.
        if (this._useWebCodecs) {
            var targets = [this.canvas, cropCanvas];
            for (var i = 0; i < targets.length; i++) {
                var t = targets[i];
                if (t) t.style.transform = 'rotate(' + this._rotation + 'deg) scale(' + this._zoom + ')';
            }
        }
        // For MSE/video path: transforms are intentionally not applied.
        // Rotation/zoom on video would break hardware decoding plane on webOS 4.x.
    };

    Player.prototype.getStats = function () {
        return {
            width: this._width,
            height: this._height,
            fps: this._fps,
            rotation: this._rotation,
            zoom: this._zoom
        };
    };

    Player.prototype.destroy = function () {
        if (this._decoder) {
            try { this._decoder.close(); } catch (_) {}
            this._decoder = null;
        }
        if (this._ms && this._ms.readyState === 'open') {
            try { this._ms.endOfStream(); } catch (_) {}
        }
        if (this.video && this.video.src) {
            URL.revokeObjectURL(this.video.src);
            this.video.src = '';
        }
        if (this.ctx && this.canvas) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
    };

    /* =========================================================================
       4. WEBSOCKET CONNECTION
       ========================================================================= */
    function Connection(agent, token, player, audioPlayer) {
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
    }

    Connection.TYPES = {
        VIDEO_FRAME: 0x01,
        CONFIG: 0x02,
        CONTROL: 0x03,
        STATS: 0x04,
        PING: 0x05,
        PONG: 0x06,
        AUDIO_FRAME: 0x07
    };

    Connection.prototype.connect = function () {
        var tokenQuery = this.token ? ('?token=' + encodeURIComponent(this.token)) : '';
        var endpoint = this.agent.endpoint || '/m4racast/v1/stream/connect';
        var wsUrl = 'ws://' + this.agent.host + ':' + this.agent.port + endpoint + tokenQuery;
        console.log('[Connection] Connecting to:', wsUrl);

        var self = this;
        try {
            this.ws = new WebSocket(wsUrl);
            this.ws.binaryType = 'arraybuffer';

            this.ws.onopen = function () {
                console.log('[Connection] Connected');
                self._startPingLoop();
                self._startStatsLoop();
            };

            this.ws.onmessage = function (event) {
                if (event.data instanceof ArrayBuffer) {
                    self._handleBinaryFrame(event.data);
                } else if (typeof event.data === 'string') {
                    self._handleTextFrame(event.data);
                }
            };

            this.ws.onclose = function (event) {
                console.log('[Connection] Closed (' + event.code + ')');
                self._cleanup();
                if (self.onDisconnect) self.onDisconnect();
            };

            this.ws.onerror = function (error) {
                console.error('[Connection] Error:', error);
                if (self.onError) self.onError(error);
            };
        } catch (e) {
            console.error('[Connection] Socket initialization failed:', e);
            if (this.onError) this.onError(e);
            if (this.onDisconnect) this.onDisconnect();
        }
    };

    Connection.prototype._handleBinaryFrame = function (buffer) {
        var data = new Uint8Array(buffer);
        if (data.length < 1) return;

        var type = data[0];
        var payload = data.subarray(1);
        this._byteCount += data.length;

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
            case Connection.TYPES.CONTROL:
                try {
                    var text = new TextDecoder().decode(payload);
                    this._handleControlMessage(JSON.parse(text));
                } catch (_) {}
                break;
            case Connection.TYPES.STATS:
                try {
                    var statsText = new TextDecoder().decode(payload);
                    if (this.onStats) this.onStats(JSON.parse(statsText));
                } catch (_) {}
                break;
            case Connection.TYPES.PING:
                this._sendPong();
                break;
            case Connection.TYPES.PONG:
                if (this._lastPingTime > 0) {
                    this._latencyMs = Math.max(1, Date.now() - this._lastPingTime);
                }
                break;
        }
    };

    Connection.prototype._handleTextFrame = function (text) {
        try {
            this._handleControlMessage(JSON.parse(text));
        } catch (_) {}
    };

    Connection.prototype._handleControlMessage = function (msg) {
        switch (msg.type) {
            case 'stream_start':
                if (this.player) this.player.onStreamStart(msg.width, msg.height, msg.fps);
                break;
            case 'stream_stop':
                this.disconnect();
                break;
            case 'orientation_change':
                if (this.player) this.player.onOrientationChange(msg.rotation || 0, msg.width, msg.height);
                break;
            case 'error':
                alert('Agent notice: ' + msg.message);
                break;
        }
    };

    Connection.prototype._startPingLoop = function () {
        var self = this;
        this._pingInterval = setInterval(function () {
            if (self.ws && self.ws.readyState === WebSocket.OPEN) {
                self._lastPingTime = Date.now();
                self.ws.send(new Uint8Array([Connection.TYPES.PING]));
            }
        }, 2000);
    };

    Connection.prototype._sendPong = function () {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(new Uint8Array([Connection.TYPES.PONG]));
        }
    };

    Connection.prototype._startStatsLoop = function () {
        var self = this;
        this._fpsInterval = setInterval(function () {
            var now = Date.now();
            var elapsedSec = (now - self._lastFpsTime) / 1000;
            var fps = Math.round(self._frameCount / elapsedSec);
            var kbps = Math.round((self._byteCount * 8) / (elapsedSec * 1000));
            self._frameCount = 0;
            self._byteCount = 0;
            self._lastFpsTime = now;

            var playerStats = (self.player && typeof self.player.getStats === 'function') ? self.player.getStats() : {};
            if (self.onStats) {
                self.onStats({
                    fps: fps,
                    kbps: kbps,
                    width: playerStats.width || 0,
                    height: playerStats.height || 0,
                    latencyMs: self._latencyMs
                });
            }
        }, 1000);
    };

    Connection.prototype.sendControl = function (command) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            var json = JSON.stringify(command);
            var payload = new TextEncoder().encode(json);
            var packet = new Uint8Array(payload.length + 1);
            packet[0] = Connection.TYPES.CONTROL;
            packet.set(payload, 1);
            this.ws.send(packet);
        }
    };

    Connection.prototype.disconnect = function () {
        if (this.ws) {
            try {
                this.sendControl({ type: 'disconnect' });
                this.ws.close();
            } catch (_) {}
            this.ws = null;
        }
        this._cleanup();
    };

    Connection.prototype._cleanup = function () {
        clearInterval(this._pingInterval);
        clearInterval(this._fpsInterval);
        this._pingInterval = null;
        this._fpsInterval = null;
    };

    /* =========================================================================
       5. MAIN APPLICATION (Promise-based, Chromium 53 friendly)
       ========================================================================= */
    function M4raCastApp() {
        this.connection = null;
        this.player = null;
        this.cropper = null;
        this.audioPlayer = new AudioPlayer();
        this.isConnecting = false;

        this.screens = {
            connect: document.getElementById('screen-connect'),
            viewer: document.getElementById('screen-viewer')
        };

        this.initTVNavigation();
        this.initConnectUI();
        this.initViewerUI();
        this.initCropperUI();
        this.handleInitialRouting();
    }

    M4raCastApp.prototype.handleInitialRouting = function () {
        var path = window.location.pathname;
        var search = new URLSearchParams(window.location.search);
        var targetIp = search.get('host') || search.get('ip') || '';
        var targetPort = search.get('port') || '';

        if (path.indexOf('/stream/') === 0) {
            var rawParam = decodeURIComponent(path.replace('/stream/', '').trim());
            if (rawParam) {
                if (rawParam.indexOf(':') !== -1) {
                    var parts = rawParam.split(':');
                    targetIp = parts[0]; targetPort = parts[1];
                } else if (rawParam.indexOf('_') !== -1) {
                    var parts2 = rawParam.split('_');
                    targetIp = parts2[0]; targetPort = parts2[1];
                } else {
                    targetIp = rawParam;
                }
            }
        }

        var manualGroup = document.getElementById('manual-connect-group');
        var hintBox = document.getElementById('endpoint-hint-box');
        var fieldPassword = document.getElementById('field-password');
        var passwordHint = document.getElementById('password-hint');
        var subtitle = document.querySelector('.tv-subtitle');
        var ipInput = document.getElementById('input-ip');
        var portInput = document.getElementById('input-port');
        var passwordInput = document.getElementById('input-password');

        var self = this;
        // Probe endpoint via Promise chain (no async/await)
        fetch('/m4racast/v1/info')
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (agentInfo) {
                if (agentInfo && agentInfo.name) {
                    // Direct Agent mode
                    targetIp = window.location.hostname;
                    targetPort = window.location.port || '80';
                    if (ipInput) ipInput.value = targetIp;
                    if (portInput) portInput.value = targetPort;

                    if (manualGroup) manualGroup.style.display = 'none';
                    if (hintBox) hintBox.style.display = 'none';

                    if (agentInfo.protected) {
                        if (subtitle) subtitle.textContent = 'Enter the security password to connect to this screen.';
                        if (passwordHint) passwordHint.textContent = '(required)';
                        var btnConnect = document.getElementById('btn-connect-main');
                        if (btnConnect) btnConnect.focus();
                    } else {
                        if (fieldPassword) fieldPassword.style.display = 'none';
                        if (subtitle) subtitle.textContent = 'Connecting directly to screen...';
                        setTimeout(function () { self.startConnectFlow(); }, 150);
                    }
                } else {
                    self._setupRegularClient(manualGroup, hintBox, ipInput, portInput, targetIp, targetPort);
                }
            })
            .catch(function () {
                self._setupRegularClient(manualGroup, hintBox, ipInput, portInput, targetIp, targetPort);
            });
    };

    M4raCastApp.prototype._setupRegularClient = function (manualGroup, hintBox, ipInput, portInput, targetIp, targetPort) {
        if (manualGroup) manualGroup.style.display = 'block';
        if (hintBox) hintBox.style.display = 'block';

        var savedIp = localStorage.getItem('m4racast_tv_ip') || '';
        var savedPort = localStorage.getItem('m4racast_tv_port') || '46283';
        var self = this;

        if (targetIp) {
            if (ipInput) ipInput.value = targetIp;
            if (portInput) portInput.value = targetPort || savedPort || '46283';
            setTimeout(function () { self.startConnectFlow(); }, 300);
        } else {
            if (ipInput) ipInput.value = savedIp;
            if (portInput) portInput.value = savedPort;
            var btnConnect = document.getElementById('btn-connect-main');
            if (btnConnect) {
                btnConnect.focus();
            }
        }
    };

    M4raCastApp.prototype.initTVNavigation = function () {
        // High-visibility focus tracking for older Chromium 53 / webOS 5
        document.addEventListener('focusin', function (e) {
            var all = document.querySelectorAll('.tv-focused');
            for (var i = 0; i < all.length; i++) {
                all[i].classList.remove('tv-focused');
            }
            if (e.target && e.target.classList) {
                e.target.classList.add('tv-focused');
            }
        });
        document.addEventListener('focusout', function (e) {
            if (e.target && e.target.classList) {
                e.target.classList.remove('tv-focused');
            }
        });

        setTimeout(function () {
            var initialFocus = document.getElementById('btn-connect-main');
            if (initialFocus) initialFocus.focus();
        }, 150);

        var self = this;
        window.addEventListener('keydown', function (e) {
            var code = e.keyCode || e.which;
            var key = e.key || '';

            if (code === 40 || key === 'ArrowDown' || key === 'Down') {
                self.navigateSpatial('down');
                e.preventDefault();
            } else if (code === 38 || key === 'ArrowUp' || key === 'Up') {
                self.navigateSpatial('up');
                e.preventDefault();
            } else if (code === 39 || key === 'ArrowRight' || key === 'Right') {
                self.navigateSpatial('right');
                e.preventDefault();
            } else if (code === 37 || key === 'ArrowLeft' || key === 'Left') {
                self.navigateSpatial('left');
                e.preventDefault();
            } else if (code === 13 || key === 'Enter') {
                if (self.tvSelectedInput) {
                    var targetInput = self.tvSelectedInput;
                    self.tvSelectedInput = null;
                    targetInput.focus();
                    e.preventDefault();
                    return;
                }
                var active = document.activeElement;
                if (active && active.tagName === 'BUTTON') {
                    active.click();
                    e.preventDefault();
                } else if (active && (active.id === 'input-ip' || active.id === 'input-port' || active.id === 'input-password')) {
                    self.startConnectFlow();
                    e.preventDefault();
                }
            } else if (code === 27 || code === 461 || key === 'Escape' || key === 'Back' || key === 'BrowserBack') {
                self.handleTVBack();
                e.preventDefault();
            }
        });
    };

    M4raCastApp.prototype.navigateSpatial = function (direction) {
        var modalConfirm = document.getElementById('modal-confirm-disconnect');
        var modalConnecting = document.getElementById('modal-connecting');
        var cropPanel = document.getElementById('crop-panel');
        var container = document.body;

        if (modalConfirm && modalConfirm.style.display !== 'none') {
            container = modalConfirm;
        } else if (modalConnecting && modalConnecting.style.display !== 'none') {
            container = modalConnecting;
        } else if (cropPanel && cropPanel.style.display === 'block') {
            container = cropPanel;
        } else {
            var activeScreen = document.querySelector('.screen.active');
            if (activeScreen) container = activeScreen;
        }

        var focusable = Array.from(container.querySelectorAll(
            'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )).filter(function (el) {
            var rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none';
        });

        if (focusable.length === 0) return;

        var active = document.activeElement;
        var currentIndex = focusable.indexOf(active);

        if (currentIndex === -1 || active === document.body || !active) {
            var preferred = focusable.find(function (el) { return el.id === 'btn-connect-main' || el.id === 'btn-confirm-disconnect-no'; }) || focusable[0];
            if (preferred) preferred.focus();
            return;
        }

        var currentRect = active.getBoundingClientRect();
        var bestTarget = null;
        var minDistance = Infinity;

        for (var i = 0; i < focusable.length; i++) {
            var candidate = focusable[i];
            if (candidate === active) continue;
            var candRect = candidate.getBoundingClientRect();

            var isDirectional = false;
            var dX = (candRect.left + candRect.width / 2) - (currentRect.left + currentRect.width / 2);
            var dY = (candRect.top + candRect.height / 2) - (currentRect.top + currentRect.height / 2);

            switch (direction) {
                case 'down':  isDirectional = dY > 15; break;
                case 'up':    isDirectional = dY < -15; break;
                case 'right': isDirectional = dX > 15; break;
                case 'left':  isDirectional = dX < -15; break;
            }

            if (isDirectional) {
                var dist = Math.hypot(dX, dY);
                if (dist < minDistance) {
                    minDistance = dist;
                    bestTarget = candidate;
                }
            }
        }

        if (bestTarget) {
            if (bestTarget.tagName === 'INPUT') {
                var prevs = document.querySelectorAll('.tv-focused');
                for (var f = 0; f < prevs.length; f++) prevs[f].classList.remove('tv-focused');
                bestTarget.classList.add('tv-focused');
                self.tvSelectedInput = bestTarget;
                if (document.activeElement && document.activeElement.blur) {
                    document.activeElement.blur();
                }
            } else {
                if (self.tvSelectedInput) {
                    self.tvSelectedInput.classList.remove('tv-focused');
                    self.tvSelectedInput = null;
                }
                bestTarget.focus();
            }
        } else {
            if (direction === 'down' || direction === 'right') {
                var next = focusable[(currentIndex + 1) % focusable.length];
                if (next) next.focus();
            } else if (direction === 'up' || direction === 'left') {
                var prev = focusable[(currentIndex - 1 + focusable.length) % focusable.length];
                if (prev) prev.focus();
            }
        }
    };

    M4raCastApp.prototype.showConfirmDisconnect = function () {
        var modal = document.getElementById('modal-confirm-disconnect');
        if (modal) {
            modal.style.display = 'flex';
            var btnNo = document.getElementById('btn-confirm-disconnect-no');
            if (btnNo) btnNo.focus();
        }
    };

    M4raCastApp.prototype.hideConfirmDisconnect = function () {
        var modal = document.getElementById('modal-confirm-disconnect');
        if (modal) modal.style.display = 'none';
        var hud = document.getElementById('viewer-hud');
        if (hud && !hud.classList.contains('hidden')) {
            var bDisc = document.getElementById('btn-disconnect');
            if (bDisc) bDisc.focus();
        }
    };

    M4raCastApp.prototype.handleTVBack = function () {
        // 0. If an input is currently active, Back blurs it and closes the virtual keyboard
        var active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.classList.contains('tv-input'))) {
            if (active.blur) active.blur();
            var btnConnect = document.getElementById('btn-connect-main');
            if (btnConnect) btnConnect.focus();
            return;
        }
        if (this.tvSelectedInput) {
            this.tvSelectedInput.classList.remove('tv-focused');
            this.tvSelectedInput = null;
            var btnConnect2 = document.getElementById('btn-connect-main');
            if (btnConnect2) btnConnect2.focus();
            return;
        }

        // 1. If Confirmation modal is open, back closes it
        var modalConfirm = document.getElementById('modal-confirm-disconnect');
        if (modalConfirm && modalConfirm.style.display !== 'none') {
            this.hideConfirmDisconnect();
            return;
        }

        // 2. If Connecting modal is open, back cancels connection
        var modalConnecting = document.getElementById('modal-connecting');
        if (modalConnecting && modalConnecting.style.display !== 'none') {
            this.cancelConnectFlow();
            return;
        }

        // 3. If Crop panel is open, back closes it
        var cropPanel = document.getElementById('crop-panel');
        if (cropPanel && cropPanel.style.display !== 'none') {
            cropPanel.style.display = 'none';
            var btnCrop = document.getElementById('btn-crop');
            if (btnCrop) btnCrop.focus();
            return;
        }

        // 4. In Viewer screen:
        if (this.screens.viewer && this.screens.viewer.classList.contains('active')) {
            var hud = document.getElementById('viewer-hud');
            var isHudVisible = hud && !hud.classList.contains('hidden');
            if (isHudVisible) {
                // If stream controls / HUD menu are active, close/hide the menu only, NOT the stream!
                hud.classList.add('hidden');
                if (document.activeElement && document.activeElement.blur) {
                    document.activeElement.blur();
                }
                return;
            } else {
                // When pressing back with menu hidden, show confirmation popup "Are you sure you want to end the stream?"
                this.showConfirmDisconnect();
                return;
            }
        }
    };

    M4raCastApp.prototype.initConnectUI = function () {
        var btnConnect = document.getElementById('btn-connect-main');
        var btnCancel = document.getElementById('btn-cancel-connecting');
        var ipInput = document.getElementById('input-ip');
        var portInput = document.getElementById('input-port');
        var passwordInput = document.getElementById('input-password');
        var self = this;

        if (btnConnect) btnConnect.addEventListener('click', function () { self.startConnectFlow(); });
        if (btnCancel) btnCancel.addEventListener('click', function () { self.cancelConnectFlow(); });

        [ipInput, portInput, passwordInput].forEach(function (inp) {
            if (!inp) return;
            inp.addEventListener('focus', function () {
                self.tvSelectedInput = null;
            });
            inp.addEventListener('keydown', function (e) {
                var code = e.keyCode || e.which;
                if (code === 13 || e.key === 'Enter') {
                    self.startConnectFlow();
                }
            });
        });
    };

    M4raCastApp.prototype.startConnectFlow = function () {
        if (this.isConnecting) return;

        var ip = document.getElementById('input-ip').value.trim();
        var port = parseInt(document.getElementById('input-port').value.trim(), 10);
        var password = document.getElementById('input-password').value;

        if (!ip || isNaN(port)) {
            alert('Please enter a valid IP address and port.');
            var inputIp = document.getElementById('input-ip');
            if (inputIp) inputIp.focus();
            return;
        }

        localStorage.setItem('m4racast_tv_ip', ip);
        localStorage.setItem('m4racast_tv_port', port.toString());

        this.isConnecting = true;
        if (this.audioPlayer) {
            this.audioPlayer.initContext();
            // Explicitly resume inside this user-gesture handler to unlock autoplay on webOS
            if (this.audioPlayer.ctx) {
                try { this.audioPlayer.ctx.resume(); } catch (_) {}
            }
        }

        var modal = document.getElementById('modal-connecting');
        if (modal) modal.style.display = 'flex';
        var targetEl = document.getElementById('connecting-target');
        if (targetEl) targetEl.textContent = ip + ':' + port;
        var titleEl = document.getElementById('connecting-title');
        if (titleEl) titleEl.textContent = 'Connecting to Screen...';
        var cancelBtn = document.getElementById('btn-cancel-connecting');
        if (cancelBtn) {
            cancelBtn.textContent = 'Cancel Connection';
            cancelBtn.focus();
        }

        this.resetSteps();
        this.logDebug('[Init] Establishing connection to ' + ip + ':' + port + '...', 'info');

        var baseUrl = 'http://' + ip + ':' + port;
        var self = this;
        var infoData = null;
        var token = '';

        // Step 1: Probe Host
        this.setStepStatus('step-probe', 'active');
        this.logDebug('[Step 1] GET ' + baseUrl + '/m4racast/v1/info', 'info');

        fetch(baseUrl + '/m4racast/v1/info')
            .then(function (res) {
                if (!res.ok) throw new Error('Agent returned HTTP ' + res.status);
                return res.json();
            })
            .then(function (info) {
                infoData = info;
                self.setStepStatus('step-probe', 'done');
                self.logDebug('[Step 1] Verified agent: ' + info.name, 'success');

                // Step 2: Auth
                self.setStepStatus('step-auth', 'active');
                if (infoData.protected) {
                    self.logDebug('[Step 2] Requesting auth challenge...', 'info');
                    return fetch(baseUrl + '/m4racast/v1/nonce')
                        .then(function (nr) { return nr.json(); })
                        .then(function (nData) {
                            var hash = self.pureJsSha256((password || '') + nData.nonce);
                            return fetch(baseUrl + '/m4racast/v1/auth', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ password_hash: hash, nonce: nData.nonce })
                            });
                        })
                        .then(function (ar) {
                            if (!ar.ok) throw new Error('Invalid password');
                            return ar.json();
                        })
                        .then(function (authData) { token = authData.token; });
                } else {
                    return fetch(baseUrl + '/m4racast/v1/auth', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({})
                    })
                    .then(function (ar) { return ar.ok ? ar.json() : {}; })
                    .then(function (ad) { token = ad.token || ''; });
                }
            })
            .then(function () {
                self.setStepStatus('step-auth', 'done');
                self.logDebug('[Step 2] Authenticated', 'success');

                // Step 3: Decoder & Audio
                self.setStepStatus('step-decoder', 'active');
                var streamCanvas = document.getElementById('stream-canvas');
                var streamVideo = document.getElementById('stream-video');
                var cropCanvas = document.getElementById('crop-canvas');

                self.player = new Player(streamCanvas, streamVideo);
                self.cropper = new Cropper(streamCanvas, cropCanvas);
                if (self.audioPlayer) self.audioPlayer.initContext();

                self.setStepStatus('step-decoder', 'done');
                self.logDebug('[Step 3] Pipelines ready', 'success');

                // Step 4: WebSocket
                self.setStepStatus('step-ws', 'active');
                var agent = { host: ip, port: port, name: infoData.name };
                self.connection = new Connection(agent, token, self.player, self.audioPlayer);

                self.connection.onError = function (err) {
                    self.logDebug('[WebSocket] Error: ' + (err && err.message ? err.message : err), 'error');
                };

                self.connection.onStats = function (stats) {
                    var sFps = document.getElementById('stat-fps');
                    var sRes = document.getElementById('stat-resolution');
                    var sLat = document.getElementById('stat-latency');
                    if (sFps) sFps.textContent = stats.fps + ' fps';
                    if (sRes) sRes.textContent = stats.width + 'x' + stats.height;
                    if (sLat) sLat.textContent = stats.latencyMs + ' ms';
                };

                self.connection.onDisconnect = function () {
                    if (self.cropper) self.cropper.destroy();
                    if (self.player) self.player.destroy();
                    if (self.audioPlayer) self.audioPlayer.destroy();
                    self.switchScreen('connect');
                    var bc = document.getElementById('btn-connect-main');
                    if (bc) bc.focus();
                };

                self.connection.connect();

                var checkInterval = setInterval(function () {
                    if (self.connection && self.connection.ws && self.connection.ws.readyState === WebSocket.OPEN) {
                        clearInterval(checkInterval);
                        self.setStepStatus('step-ws', 'done');
                        self.logDebug('[Step 4] Handshake complete', 'success');

                        setTimeout(function () {
                            if (modal) modal.style.display = 'none';
                            self.switchScreen('viewer');
                            if (self.player) self.player.setScaleMode('fit');
                            var hName = document.getElementById('hud-agent-name');
                            if (hName) hName.textContent = infoData.name || (ip + ':' + port);
                            var bDisc = document.getElementById('btn-disconnect');
                            if (bDisc) bDisc.focus();
                            self.isConnecting = false;
                        }, 400);
                    }
                }, 100);

                setTimeout(function () {
                    clearInterval(checkInterval);
                    if (self.isConnecting && (!self.connection || !self.connection.ws || self.connection.ws.readyState !== WebSocket.OPEN)) {
                        self.handleConnectError(new Error('WebSocket timeout'));
                    }
                }, 8000);
            })
            .catch(function (err) {
                self.handleConnectError(err);
            });
    };

    M4raCastApp.prototype.handleConnectError = function (err) {
        this.isConnecting = false;
        var msg = (err && err.message) ? err.message : String(err);
        this.logDebug('[Error] ' + msg, 'error');
        var t = document.getElementById('connecting-title');
        if (t) t.textContent = 'Connection Failed';
        var b = document.getElementById('btn-cancel-connecting');
        if (b) b.textContent = 'Dismiss / Try Again';

        var activeStep = document.querySelector('.tv-step.active');
        if (activeStep) {
            activeStep.classList.remove('active');
            activeStep.classList.add('error');
            var icon = activeStep.querySelector('.step-icon');
            if (icon) icon.textContent = '✕';
        }
    };

    M4raCastApp.prototype.cancelConnectFlow = function () {
        if (this.connection) this.connection.disconnect();
        this.isConnecting = false;
        var modal = document.getElementById('modal-connecting');
        if (modal) modal.style.display = 'none';
        var btn = document.getElementById('btn-connect-main');
        if (btn) btn.focus();
    };

    M4raCastApp.prototype.resetSteps = function () {
        ['step-probe', 'step-auth', 'step-decoder', 'step-ws'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) {
                el.className = 'tv-step';
                var icon = el.querySelector('.step-icon');
                if (icon) icon.textContent = '○';
            }
        });
        var db = document.getElementById('tv-debug-logs');
        if (db) db.innerHTML = '';
    };

    M4raCastApp.prototype.setStepStatus = function (id, status) {
        var el = document.getElementById(id);
        if (!el) return;
        el.className = 'tv-step ' + status;
        var icon = el.querySelector('.step-icon');
        if (icon) {
            if (status === 'done') icon.textContent = '✓';
            else if (status === 'active') icon.textContent = '●';
            else if (status === 'error') icon.textContent = '✕';
        }
    };

    M4raCastApp.prototype.logDebug = function (text, type) {
        type = type || 'info';
        var debugBox = document.getElementById('tv-debug-logs');
        if (!debugBox) return;
        var line = document.createElement('div');
        line.className = 'log-line ' + type;
        line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + text;
        debugBox.appendChild(line);
        debugBox.scrollTop = debugBox.scrollHeight;
    };

    M4raCastApp.prototype.initViewerUI = function () {
        var self = this;
        var btnDisconnect = document.getElementById('btn-disconnect');
        if (btnDisconnect) {
            btnDisconnect.addEventListener('click', function () {
                self.showConfirmDisconnect();
            });
        }

        var btnConfirmYes = document.getElementById('btn-confirm-disconnect-yes');
        if (btnConfirmYes) {
            btnConfirmYes.addEventListener('click', function () {
                self.hideConfirmDisconnect();
                if (self.connection) self.connection.disconnect();
            });
        }

        var btnConfirmNo = document.getElementById('btn-confirm-disconnect-no');
        if (btnConfirmNo) {
            btnConfirmNo.addEventListener('click', function () {
                self.hideConfirmDisconnect();
            });
        }

        var btnAudio = document.getElementById('btn-audio');
        var iconAudioOn = document.getElementById('icon-audio-on');
        var iconAudioOff = document.getElementById('icon-audio-off');
        var labelAudio = document.getElementById('label-audio');

        if (btnAudio) {
            btnAudio.addEventListener('click', function () {
                var isMuted = self.audioPlayer ? self.audioPlayer.toggleMute() : false;
                if (isMuted) {
                    if (iconAudioOn) iconAudioOn.style.display = 'none';
                    if (iconAudioOff) iconAudioOff.style.display = 'inline';
                    if (labelAudio) labelAudio.textContent = 'Muted';
                    btnAudio.classList.add('muted');
                } else {
                    if (iconAudioOn) iconAudioOn.style.display = 'inline';
                    if (iconAudioOff) iconAudioOff.style.display = 'none';
                    if (labelAudio) labelAudio.textContent = 'Audio';
                    btnAudio.classList.remove('muted');
                }
            });
        }

        var btnFit = document.getElementById('btn-fit');
        if (btnFit) {
            btnFit.addEventListener('click', function () {
                if (self.player) self.player.setScaleMode('fit');
            });
        }

        var btnRot = document.getElementById('btn-rotate');
        if (btnRot) {
            btnRot.addEventListener('click', function () {
                if (self.player) self.player.rotate90();
            });
        }

        var btnCrop = document.getElementById('btn-crop');
        var panelCrop = document.getElementById('crop-panel');
        if (btnCrop) {
            btnCrop.addEventListener('click', function () {
                if (!panelCrop) return;
                var isOpen = panelCrop.style.display === 'block';
                panelCrop.style.display = isOpen ? 'none' : 'block';
            });
        }
        var btnCloseCrop = document.getElementById('btn-close-crop');
        if (btnCloseCrop) {
            btnCloseCrop.addEventListener('click', function () {
                if (panelCrop) panelCrop.style.display = 'none';
            });
        }

        var hudTimer = null;
        var hud = document.getElementById('viewer-hud');
        var showHUD = function () {
            if (!hud) return;
            var confirmModal = document.getElementById('modal-confirm-disconnect');
            if (confirmModal && confirmModal.style.display !== 'none') return;
            hud.classList.remove('hidden');
            clearTimeout(hudTimer);
            hudTimer = setTimeout(function () { hud.classList.add('hidden'); }, 5000);
        };
        var vc = document.getElementById('viewer-container');
        if (vc) vc.addEventListener('mousemove', showHUD);
        document.addEventListener('keydown', function (e) {
            var code = e.keyCode || e.which;
            var key = e.key || '';
            if (code === 27 || code === 461 || key === 'Escape' || key === 'Back' || key === 'BrowserBack') {
                return;
            }
            if (self.screens.viewer && self.screens.viewer.classList.contains('active')) {
                var confirmModal = document.getElementById('modal-confirm-disconnect');
                if (confirmModal && confirmModal.style.display !== 'none') return;
                showHUD();
            }
        });
    };

    M4raCastApp.prototype.initCropperUI = function () {
        var sides = ['top', 'bottom', 'left', 'right'];
        var self = this;
        sides.forEach(function (side) {
            var slider = document.getElementById('crop-' + side);
            var num = document.getElementById('crop-' + side + '-num');
            if (slider) {
                slider.addEventListener('input', function () {
                    if (num) num.value = slider.value;
                    self.updateCropFromUI();
                });
            }
        });
        document.querySelectorAll('.preset-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                document.querySelectorAll('.preset-btn').forEach(function (b) { b.classList.remove('active'); });
                btn.classList.add('active');
                if (self.cropper) self.cropper.applyAspectRatioPreset(btn.dataset.preset);
            });
        });
        var btnReset = document.getElementById('btn-reset-crop');
        if (btnReset) {
            btnReset.addEventListener('click', function () {
                if (self.cropper) self.cropper.reset();
            });
        }
    };

    M4raCastApp.prototype.updateCropFromUI = function () {
        var crop = {
            top: parseInt(document.getElementById('crop-top').value, 10) || 0,
            bottom: parseInt(document.getElementById('crop-bottom').value, 10) || 0,
            left: parseInt(document.getElementById('crop-left').value, 10) || 0,
            right: parseInt(document.getElementById('crop-right').value, 10) || 0
        };
        if (this.cropper) this.cropper.setCrop(crop);
    };

    M4raCastApp.prototype.switchScreen = function (name) {
        var self = this;
        Object.keys(this.screens).forEach(function (key) {
            var el = self.screens[key];
            if (el) el.classList.toggle('active', key === name);
        });
    };

    M4raCastApp.prototype.pureJsSha256 = function (str) {
        function rotr(n, b) { return (n >>> b) | (n << (32 - b)); }
        var K = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
        ];
        var H0 = 0x6a09e667, H1 = 0xbb67ae85, H2 = 0x3c6ef372, H3 = 0xa54ff53a;
        var H4 = 0x510e527f, H5 = 0x9b05688c, H6 = 0x1f83d9ab, H7 = 0x5be0cd19;

        var utf8 = unescape(encodeURIComponent(str));
        var byteLen = utf8.length;
        var words = [];
        for (var i = 0; i < byteLen; i++) {
            words[i >> 2] |= (utf8.charCodeAt(i) & 0xff) << (24 - (i % 4) * 8);
        }
        words[byteLen >> 2] |= 0x80 << (24 - (byteLen % 4) * 8);
        var totalWords = (((byteLen + 8) >> 6) + 1) * 16;
        while (words.length < totalWords - 2) words.push(0);
        words.push((byteLen * 8 / 0x100000000) | 0);
        words.push((byteLen * 8) | 0);

        var W = new Int32Array(64);
        for (var i2 = 0; i2 < words.length; i2 += 16) {
            for (var t = 0; t < 16; t++) W[t] = words[i2 + t] | 0;
            for (var t2 = 16; t2 < 64; t2++) {
                var s0 = rotr(W[t2 - 15], 7) ^ rotr(W[t2 - 15], 18) ^ (W[t2 - 15] >>> 3);
                var s1 = rotr(W[t2 - 2], 17) ^ rotr(W[t2 - 2], 19) ^ (W[t2 - 2] >>> 10);
                W[t2] = (W[t2 - 16] + s0 + W[t2 - 7] + s1) | 0;
            }
            var a = H0, b = H1, c = H2, d = H3, e = H4, f = H5, g = H6, h = H7;
            for (var t3 = 0; t3 < 64; t3++) {
                var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
                var ch = (e & f) ^ ((~e) & g);
                var temp1 = (h + S1 + ch + K[t3] + W[t3]) | 0;
                var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
                var maj = (a & b) ^ (a & c) ^ (b & c);
                var temp2 = (S0 + maj) | 0;
                h = g; g = f; f = e; e = (d + temp1) | 0;
                d = c; c = b; b = a; a = (temp1 + temp2) | 0;
            }
            H0 = (H0 + a) | 0; H1 = (H1 + b) | 0; H2 = (H2 + c) | 0; H3 = (H3 + d) | 0;
            H4 = (H4 + e) | 0; H5 = (H5 + f) | 0; H6 = (H6 + g) | 0; H7 = (H7 + h) | 0;
        }
        function toHex(n) {
            var hex = (n >>> 0).toString(16);
            while (hex.length < 8) hex = '0' + hex;
            return hex;
        }
        return toHex(H0) + toHex(H1) + toHex(H2) + toHex(H3) + toHex(H4) + toHex(H5) + toHex(H6) + toHex(H7);
    };

    // Auto-bootstrap on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { new M4raCastApp(); });
    } else {
        new M4raCastApp();
    }

})(window, document);

