/**
 * M4raCast Video Player
 * Dual-mode decoder:
 *   1. WebCodecs (VideoDecoder) — preferred, requires secure context (HTTPS / localhost)
 *   2. MSE (MediaSource + fMP4) — fallback for plain HTTP (e.g. http://192.168.x.x:port)
 *
 * MSE path packages incoming Annex-B H.264 NAL units into fragmented MP4 segments
 * on-the-fly in JavaScript — no server changes needed.
 */
export class Player {
    constructor(canvasEl, videoEl) {
        this.canvas = canvasEl;
        this.video = videoEl;
        this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });

        // Prefer WebCodecs when available (requires secure context)
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
        this._msePending = false;
        this._mseInitSent = false;

        // SPS / PPS (raw RBSP without start codes, for fMP4 avcC box)
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

        // Diagnostic counters
        this._frameLogCount = 0;

        this.onFrameDecoded = null;

        console.log(`[Player] Mode: ${this._useWebCodecs ? 'WebCodecs' : this._useMSE ? 'MSE/fMP4' : 'NONE'}, isSecureContext=${window.isSecureContext}`);

        this._initDecoder();
        this.setScaleMode('fit');
    }

    // =========================================================================
    // INIT
    // =========================================================================

    _initDecoder() {
        if (this._useWebCodecs) {
            try {
                this._decoder = new VideoDecoder({
                    output: (videoFrame) => this._renderFrame(videoFrame),
                    error: (err) => {
                        console.error('[Player] WebCodecs decode error:', err);
                        this._firstKeyframeReceived = false;
                    }
                });
                console.log('[Player] WebCodecs decoder initialized');
            } catch (e) {
                console.warn('[Player] VideoDecoder instantiation failed:', e);
                this._useWebCodecs = false;
                this._useMSE = typeof window.MediaSource === 'function';
            }
        }

        if (!this._useWebCodecs && this._useMSE) {
            this._initMSE();
        }

        if (!this._useWebCodecs && !this._useMSE) {
            console.error('[Player] No video decoder available — WebCodecs requires HTTPS/localhost, MSE unavailable');
        }

        if (this._useWebCodecs) {
            this.canvas.style.display = 'block';
            this.canvas.style.width = '100%';
            this.canvas.style.height = '100%';
            this.canvas.style.objectFit = 'contain';
            this.video.style.display = 'none';
        } else if (this._useMSE) {
            this.canvas.style.display = 'none';
            this.video.style.display = 'block';
            this.video.style.width = '100%';
            this.video.style.height = '100%';
            this.video.style.objectFit = 'contain';
            this.video.style.background = '#000';
        }
    }

    // =========================================================================
    // MSE / fMP4 PATH
    // =========================================================================

    _initMSE() {
        const ms = new MediaSource();
        this._ms = ms;
        this.video.src = URL.createObjectURL(ms);

        ms.addEventListener('sourceopen', () => {
            console.log('[Player] MSE sourceopen, readyState:', ms.readyState);
            // We'll add the SourceBuffer only after we know the codec string (from first config)
            this._mseSourceOpen = true;
            if (this._pendingMSECodec) {
                this._createSourceBuffer(this._pendingMSECodec);
                this._pendingMSECodec = null;
            }
        }, { once: true });

        ms.addEventListener('sourceclose', () => {
            console.warn('[Player] MSE sourceclose');
            this._mseReady = false;
        });

        this.video.addEventListener('error', (e) => {
            console.error('[Player] Video element error:', this.video.error);
        });

        // Auto-play when data is buffered
        this.video.addEventListener('canplay', () => {
            console.log('[Player] MSE canplay, playing...');
            this.video.play().catch(err => console.warn('[Player] play() failed:', err));
        }, { once: true });
    }

    _createSourceBuffer(mimeType) {
        try {
            console.log('[Player] Creating SourceBuffer for:', mimeType);
            const sb = this._ms.addSourceBuffer(mimeType);
            sb.mode = 'sequence'; // append in order, let browser manage timestamps
            this._sb = sb;
            sb.addEventListener('updateend', () => this._flushMSEQueue());
            sb.addEventListener('error', (e) => console.error('[Player] SourceBuffer error:', e));
            this._mseReady = true;
            this._flushMSEQueue();
        } catch (e) {
            console.error('[Player] addSourceBuffer failed for', mimeType, ':', e);
            this._useMSE = false;
        }
    }

    _appendMSE(segment) {
        this._mseQueue.push(segment);
        this._flushMSEQueue();
    }

    _flushMSEQueue() {
        if (!this._sb || this._sb.updating || this._mseQueue.length === 0) return;
        const seg = this._mseQueue.shift();
        try {
            this._sb.appendBuffer(seg);
        } catch (e) {
            console.warn('[Player] appendBuffer error:', e.message);
            if (e.name === 'QuotaExceededError') {
                // Evict old buffered data
                try {
                    if (this._sb.buffered.length > 0) {
                        const start = this._sb.buffered.start(0);
                        const end = this._sb.buffered.end(0);
                        const evictTo = end - 2; // keep last 2 seconds
                        if (evictTo > start) {
                            this._sb.remove(start, evictTo);
                        }
                    }
                } catch (_) {}
            }
        }
    }

    // =========================================================================
    // CONFIG (SPS / PPS)
    // =========================================================================

    /**
     * Receives SPS+PPS config in Annex-B format: [00 00 00 01][SPS NAL][00 00 00 01][PPS NAL]
     * For WebCodecs: configure the decoder.
     * For MSE: parse SPS/PPS RBSP bytes, build an fMP4 init segment when first frame arrives.
     */
    pushConfig(configBytes) {
        this._configData = configBytes;
        this._firstKeyframeReceived = false;
        this._mseInitSent = false;
        console.log(`[Player] pushConfig: ${configBytes.length} B, bytes=[${Array.from(configBytes.subarray(0, Math.min(12, configBytes.length))).map(b => b.toString(16).padStart(2, '0')).join(' ')}]`);

        // Parse SPS/PPS RBSP from Annex-B for use in fMP4 avcC box
        this._parseSPSPPSFromAnnexB(configBytes);

        const codecStr = this._deriveCodecStr(configBytes) || 'avc1.42001f';
        this._codecStr = codecStr;

        if (this._useWebCodecs) {
            this._configureWebCodecs(codecStr);
        } else if (this._useMSE) {
            const mimeType = `video/mp4; codecs="${codecStr}"`;
            if (!MediaSource.isTypeSupported(mimeType)) {
                console.warn('[Player] MSE type not supported:', mimeType, '— trying avc1.42001f');
                this._codecStr = 'avc1.42001f';
            }
            if (this._mseSourceOpen && !this._sb) {
                this._createSourceBuffer(`video/mp4; codecs="${this._codecStr}"`);
            } else if (!this._mseSourceOpen) {
                this._pendingMSECodec = `video/mp4; codecs="${this._codecStr}"`;
            }
        }
    }

    _configureWebCodecs(codecStr) {
        if (this._decoder && this._decoder.state !== 'unconfigured') {
            try { this._decoder.close(); } catch (_) {}
            this._decoder = null;
        }
        if (!this._decoder) {
            try {
                this._decoder = new VideoDecoder({
                    output: (vf) => this._renderFrame(vf),
                    error: (err) => {
                        console.error('[Player] WebCodecs error:', err);
                        this._firstKeyframeReceived = false;
                    }
                });
            } catch (e) {
                console.error('[Player] Failed to recreate decoder:', e);
                return;
            }
        }
        try {
            this._decoder.configure({ codec: codecStr, optimizeForLatency: true });
            console.log('[Player] WebCodecs configured:', codecStr);
        } catch (e) {
            console.error('[Player] configure failed for', codecStr, e);
            try {
                this._decoder.configure({ codec: 'avc1.42001f', optimizeForLatency: true });
                this._codecStr = 'avc1.42001f';
                console.warn('[Player] Fallback configured: avc1.42001f');
            } catch (e2) {
                console.error('[Player] All configure attempts failed:', e2);
            }
        }
    }

    // =========================================================================
    // FRAME PUSH
    // =========================================================================

    /**
     * Encoded video frame layout: [8 bytes PTS big-endian][1 byte isKeyframe][Annex-B NAL data]
     */
    pushFrame(payload) {
        if (payload.length < 10) return;

        this._frameLogCount++;
        if (this._frameLogCount === 1 || this._frameLogCount % 150 === 0) {
            console.log(`[Player] pushFrame #${this._frameLogCount}: len=${payload.length}, mode=${this._useWebCodecs ? 'WebCodecs' : this._useMSE ? 'MSE' : 'NONE'}`);
        }

        // Extract PTS (microseconds)
        let pts = 0n;
        for (let i = 0; i < 8; i++) {
            pts = (pts << 8n) | BigInt(payload[i]);
        }
        const nalData = payload.subarray(9);

        // NAL scan: detect IDR (5), SPS (7), PPS (8) in the first 128 bytes
        let hasIdr = false, hasSps = false;
        for (let i = 0; i < Math.min(128, nalData.length - 4); i++) {
            const is4 = nalData[i]===0 && nalData[i+1]===0 && nalData[i+2]===0 && nalData[i+3]===1;
            const is3 = nalData[i]===0 && nalData[i+1]===0 && nalData[i+2]===1;
            if (is4 || is3) {
                const off = is4 ? i + 4 : i + 3;
                if (off < nalData.length) {
                    const t = nalData[off] & 0x1f;
                    if (t === 5) hasIdr = true;
                    if (t === 7) hasSps = true;
                }
            }
        }
        const isKeyframe = (payload[8] === 0x01) || hasIdr || hasSps;

        // Cache inline SPS/PPS if present in keyframe
        if (hasSps && !this._configData) {
            this._configData = nalData;
            this._parseSPSPPSFromAnnexB(nalData);
        }

        if (this._useWebCodecs) {
            this._pushFrameWebCodecs(pts, nalData, isKeyframe, hasSps);
        } else if (this._useMSE) {
            this._pushFrameMSE(nalData, isKeyframe);
        }
    }

    _pushFrameWebCodecs(pts, nalData, isKeyframe, hasSps) {
        // Auto-heal closed decoder
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
        if (this._decoder.decodeQueueSize > 2 && !isKeyframe) return;

        try {
            let chunkData = nalData;
            if (isKeyframe && this._configData && !hasSps) {
                const merged = new Uint8Array(this._configData.length + nalData.length);
                merged.set(this._configData, 0);
                merged.set(nalData, this._configData.length);
                chunkData = merged;
            }
            this._decoder.decode(new EncodedVideoChunk({
                type: isKeyframe ? 'key' : 'delta',
                timestamp: Number(pts),
                data: chunkData
            }));
            if (isKeyframe) this._firstKeyframeReceived = true;
        } catch (e) {
            console.warn('[Player] WebCodecs chunk error:', e.message);
            if (this._decoder.state === 'closed') this._firstKeyframeReceived = false;
        }
    }

    _pushFrameMSE(nalData, isKeyframe) {
        if (!this._mseReady || !this._sb) return;

        // Need a keyframe to start
        if (!isKeyframe && !this._firstKeyframeReceived) return;

        // On first keyframe, send fMP4 init segment then the first moof+mdat
        if (isKeyframe && !this._mseInitSent) {
            if (!this._spsRbsp || !this._ppsRbsp) {
                console.warn('[Player] MSE: no SPS/PPS yet, cannot build init segment');
                return;
            }
            // Use stream dimensions if known, else fall back to defaults (1920×1080)
            const w = this._frameWidth || this._width;
            const h = this._frameHeight || this._height;
            const init = this._buildFMP4Init(w, h, this._spsRbsp, this._ppsRbsp);
            this._appendMSE(init);
            this._mseInitSent = true;
            console.log(`[Player] MSE: sent init segment (${init.byteLength} B), ${w}x${h}`);
        }

        if (!this._mseInitSent) return;

        // Build moof+mdat for this frame
        const annexB = this._ensureAnnexB(nalData);
        const avcc = this._annexBToAVCC(annexB);
        const moof = this._buildMoof(this._mseSeq = (this._mseSeq || 0) + 1, avcc.length, isKeyframe);
        const mdat = this._buildMdat(avcc);
        const segment = new Uint8Array(moof.byteLength + mdat.byteLength);
        segment.set(new Uint8Array(moof), 0);
        segment.set(new Uint8Array(mdat), moof.byteLength);
        this._appendMSE(segment);

        if (isKeyframe) this._firstKeyframeReceived = true;
    }

    // =========================================================================
    // fMP4 BUILDER (Annex-B → fMP4 on-the-fly)
    // =========================================================================

    /**
     * Parse SPS and PPS RBSP bytes (without start codes) from Annex-B config data.
     * Stored for use in the fMP4 avcC box.
     */
    _parseSPSPPSFromAnnexB(data) {
        let i = 0;
        const len = data.length;
        while (i < len - 3) {
            // Find start code
            let nalStart = -1;
            if (data[i]===0 && data[i+1]===0 && data[i+2]===0 && data[i+3]===1) {
                nalStart = i + 4; i += 4;
            } else if (data[i]===0 && data[i+1]===0 && data[i+2]===1) {
                nalStart = i + 3; i += 3;
            } else { i++; continue; }

            // Find next start code to delimit NAL
            let nalEnd = len;
            for (let j = nalStart; j < len - 2; j++) {
                if (data[j]===0 && data[j+1]===0 && (data[j+2]===1 || (data[j+2]===0 && j+3<len && data[j+3]===1))) {
                    nalEnd = j; break;
                }
            }
            const nalType = data[nalStart] & 0x1f;
            const rbsp = data.subarray(nalStart, nalEnd);
            if (nalType === 7) { // SPS
                this._spsRbsp = rbsp.slice();
                // Extract width/height from SPS (simplified — uses stream_start notice if available)
                this._parseSPSDimensions(rbsp);
            } else if (nalType === 8) { // PPS
                this._ppsRbsp = rbsp.slice();
            }
            i = nalEnd;
        }
    }

    _parseSPSDimensions(sps) {
        // Very lightweight SPS dimension parser
        // SPS RBSP: [profile_idc(1)][constraint_flags(1)][level_idc(1)][seq_param_set_id(exp-golomb)...]
        // This is complex; we'll rely on onStreamStart() for dimensions when available.
        // As fallback, use _width/_height already set.
    }

    /** Ensure data has Annex-B start codes (pass-through if already does) */
    _ensureAnnexB(data) {
        if (data.length >= 4 && data[0]===0 && data[1]===0 && data[2]===0 && data[3]===1) return data;
        if (data.length >= 3 && data[0]===0 && data[1]===0 && data[2]===1) return data;
        // No start code — prepend 4-byte start code
        const out = new Uint8Array(data.length + 4);
        out[0]=0; out[1]=0; out[2]=0; out[3]=1;
        out.set(data, 4);
        return out;
    }

    /**
     * Convert Annex-B stream to AVCC length-prefixed format for fMP4 mdat.
     * Each NAL: [4-byte big-endian length][NAL data without start code]
     */
    _annexBToAVCC(annexB) {
        const nals = [];
        let i = 0;
        const len = annexB.length;
        while (i < len) {
            // Find start code
            let nalStart = -1;
            if (i + 3 < len && annexB[i]===0 && annexB[i+1]===0 && annexB[i+2]===0 && annexB[i+3]===1) {
                nalStart = i + 4; i += 4;
            } else if (i + 2 < len && annexB[i]===0 && annexB[i+1]===0 && annexB[i+2]===1) {
                nalStart = i + 3; i += 3;
            } else { i++; continue; }

            // Find end (next start code)
            let nalEnd = len;
            for (let j = nalStart; j < len - 2; j++) {
                if (annexB[j]===0 && annexB[j+1]===0 &&
                    (annexB[j+2]===1 || (j+3<len && annexB[j+2]===0 && annexB[j+3]===1))) {
                    nalEnd = j; break;
                }
            }
            if (nalEnd > nalStart) nals.push(annexB.subarray(nalStart, nalEnd));
            i = nalEnd;
        }

        const totalLen = nals.reduce((acc, n) => acc + 4 + n.length, 0);
        const out = new Uint8Array(totalLen);
        let off = 0;
        for (const nal of nals) {
            const l = nal.length;
            out[off]=(l>>>24)&0xFF; out[off+1]=(l>>>16)&0xFF; out[off+2]=(l>>>8)&0xFF; out[off+3]=l&0xFF;
            out.set(nal, off + 4);
            off += 4 + l;
        }
        return out;
    }

    /** Write a 4-byte big-endian uint32 into DataView at offset */
    _w32(dv, off, v) { dv.setUint32(off, v >>> 0, false); return off + 4; }
    /** Write a 4-byte box size + 4-char type name */
    _boxHdr(dv, off, size, type) {
        off = this._w32(dv, off, size);
        for (let i = 0; i < 4; i++) dv.setUint8(off + i, type.charCodeAt(i));
        return off + 4;
    }

    /**
     * Build fMP4 initialization segment:
     *   ftyp + moov (mvhd + trak (tkhd + mdia (mdhd + hdlr + minf (vmhd + dinf + stbl))) + mvex (trex))
     */
    _buildFMP4Init(width, height, spsRbsp, ppsRbsp) {
        const spsLen = spsRbsp.length;
        const ppsLen = ppsRbsp.length;

        // --- ftyp box ---
        // Derive the size from the brand list so the buffer can never be
        // smaller than the bytes written into it (that caused a DataView OOB).
        const compatibleBrands = ['iso5', 'iso6', 'mp41'];
        const ftypSize = 16 + compatibleBrands.length * 4; // header + major brand + minor version + brands
        const ftyp = new ArrayBuffer(ftypSize);
        const ftypDv = new DataView(ftyp);
        let o = this._boxHdr(ftypDv, 0, ftypSize, 'ftyp');
        const writeBrand = (brand) => {
            for (let i = 0; i < 4; i++) ftypDv.setUint8(o + i, brand.charCodeAt(i));
            o += 4;
        };
        writeBrand('iso5'); // major brand
        o = this._w32(ftypDv, o, 512); // minor version
        compatibleBrands.forEach(writeBrand);

        // --- avcC box content (variable) ---
        // avcC: configurationVersion(1) + profile(1) + profileCompatibility(1) + level(1)
        //       + 0xFF (lengthSizeMinusOne=3) + 0xE1 (numSPS=1) + spsLength(2) + sps
        //       + 0x01 (numPPS=1) + ppsLength(2) + pps
        const avcCPayload = 4 + 1 + 1 + 2 + spsLen + 1 + 2 + ppsLen;
        const avcCSize = 8 + avcCPayload;

        // --- avc1 sample entry (variable) ---
        // 6 reserved + 2 data_ref_idx + 16 reserved + 2+2 width/height + 4+4 resolution +
        // 4 reserved + 2 frame_count + 32 compressorname + 2 depth + 2 pre_defined + avcC
        const avc1Size = 6+2+16+2+2+4+4+4+2+32+2+2 + avcCSize + 8; // +8 for avc1 header

        // Box sizes computed bottom-up (all sizes include the 8-byte box header)
        // url  box: hdr(8) + version_flags(4) = 12  [self-contained, no location string]
        const urlBoxSize  = 12;
        // dref box: hdr(8) + version_flags(4) + entry_count(4) + url(12) = 28
        const drefSize    = 8 + 4 + 4 + urlBoxSize;
        // dinf box: hdr(8) + dref(28) = 36
        const dinfSize    = 8 + drefSize;
        // vmhd box: hdr(8) + version_flags(4) + graphicsMode(2) + opcolor(6) = 20
        const vmhdSize    = 20;

        // stsd: hdr(8)+version_flags(4)+entry_count(4)+avc1 = 16+avc1Size
        const stsdSize    = 16 + avc1Size;
        // stts/stsc/stco: hdr(8)+version_flags(4)+entry_count(4) = 16
        const sttsSize    = 16;
        const stscSize    = 16;
        const stcoSize    = 16;
        // stsz: hdr(8)+version_flags(4)+sample_size(4)+sample_count(4) = 20
        const stszSize    = 20;
        // stbl: hdr(8)+stsd+stts+stsc+stsz+stco
        const stblSize    = 8 + stsdSize + sttsSize + stscSize + stszSize + stcoSize;
        // minf: hdr(8)+vmhd+dinf+stbl
        const minfSize    = 8 + vmhdSize + dinfSize + stblSize;

        // mdhd (version 0): hdr(8)+version_flags(4)+creation(4)+modification(4)+timescale(4)+duration(4)+language(2)+pre_defined(2) = 32
        const mdhdSize    = 32;
        // hdlr: hdr(8)+version_flags(4)+pre_defined(4)+handler_type(4)+reserved(12)+name('VideoHandler\0'=13) = 45
        const hdlrSize    = 45;
        // mdia: hdr(8)+mdhd+hdlr+minf
        const mdiaSize    = 8 + mdhdSize + hdlrSize + minfSize;

        // tkhd (version 0): hdr(8)+version_flags(4)+creation(4)+modification(4)+track_id(4)+reserved(4)+
        //                    duration(4)+reserved2(8)+layer(2)+alt_group(2)+volume(2)+reserved3(2)+
        //                    matrix(36)+width(4)+height(4) = 92
        const tkhdSize    = 92;
        // trak: hdr(8)+tkhd+mdia
        const trakSize    = 8 + tkhdSize + mdiaSize;

        // mvhd (version 0): hdr(8)+version_flags(4)+creation(4)+modification(4)+timescale(4)+duration(4)+
        //                    rate(4)+volume(2)+reserved(2+8)+matrix(36)+pre_defined(24)+next_track_id(4) = 108
        const mvhdSize    = 108;
        // trex: hdr(8)+version_flags(4)+track_id(4)+desc_idx(4)+duration(4)+size(4)+flags(4) = 32
        const trexSize    = 32;
        // mvex: hdr(8)+trex
        const mvexSize    = 8 + trexSize;
        // moov: hdr(8)+mvhd+trak+mvex
        const moovSize    = 8 + mvhdSize + trakSize + mvexSize;
        const totalSize = ftyp.byteLength + moovSize;

        const buf = new ArrayBuffer(totalSize);
        const dv = new DataView(buf);
        const u8 = new Uint8Array(buf);

        // Copy ftyp
        u8.set(new Uint8Array(ftyp), 0);
        o = ftyp.byteLength;

        // moov
        const moovStart = o;
        o = this._boxHdr(dv, o, moovSize, 'moov');

        // mvhd
        o = this._boxHdr(dv, o, mvhdSize, 'mvhd');
        o = this._w32(dv, o, 0); // version+flags
        o = this._w32(dv, o, 0); // creation_time
        o = this._w32(dv, o, 0); // modification_time
        o = this._w32(dv, o, 90000); // timescale
        o = this._w32(dv, o, 0); // duration
        o = this._w32(dv, o, 0x00010000); // rate 1.0
        dv.setUint16(o, 0x0100, false); o += 2; // volume 1.0
        o += 2 + 8; // reserved
        // unity matrix
        const matrix = [0x00010000,0,0, 0,0x00010000,0, 0,0,0x40000000];
        matrix.forEach(v => { o = this._w32(dv, o, v); });
        o += 24; // pre_defined
        o = this._w32(dv, o, 2); // next_track_ID

        // trak
        o = this._boxHdr(dv, o, trakSize, 'trak');

        // tkhd
        o = this._boxHdr(dv, o, tkhdSize, 'tkhd');
        o = this._w32(dv, o, 0x00000003); // version+flags (enabled|in_movie)
        o = this._w32(dv, o, 0); // creation_time
        o = this._w32(dv, o, 0); // modification_time
        o = this._w32(dv, o, 1); // track_ID
        o = this._w32(dv, o, 0); // reserved
        o = this._w32(dv, o, 0); // duration
        o += 8; // reserved
        dv.setUint16(o, 0, false); o += 2; // layer
        dv.setUint16(o, 0, false); o += 2; // alternate_group
        dv.setUint16(o, 0, false); o += 2; // volume (0 for video)
        o += 2; // reserved
        matrix.forEach(v => { o = this._w32(dv, o, v); });
        o = this._w32(dv, o, width << 16);  // width (16.16 fixed)
        o = this._w32(dv, o, height << 16); // height (16.16 fixed)

        // mdia
        o = this._boxHdr(dv, o, mdiaSize, 'mdia');

        // mdhd
        o = this._boxHdr(dv, o, mdhdSize, 'mdhd');
        o = this._w32(dv, o, 0); // version+flags
        o = this._w32(dv, o, 0); // creation_time
        o = this._w32(dv, o, 0); // modification_time
        o = this._w32(dv, o, 90000); // timescale
        o = this._w32(dv, o, 0); // duration
        dv.setUint16(o, 0x55C4, false); o += 2; // language 'und'
        dv.setUint16(o, 0, false); o += 2; // pre_defined

        // hdlr
        o = this._boxHdr(dv, o, hdlrSize, 'hdlr');
        o = this._w32(dv, o, 0); // version+flags
        o = this._w32(dv, o, 0); // pre_defined
        'vide'.split('').forEach((c,i) => dv.setUint8(o+i, c.charCodeAt(0))); o += 4;
        o += 12; // reserved
        'VideoHandler\0'.split('').forEach((c,i) => dv.setUint8(o+i, c.charCodeAt(0))); o += 13;

        // minf
        o = this._boxHdr(dv, o, minfSize, 'minf');

        // vmhd
        o = this._boxHdr(dv, o, vmhdSize, 'vmhd');
        o = this._w32(dv, o, 1); // version 0, flags 1
        o += 2 + 6; // graphicsMode + opcolor

        // dinf
        o = this._boxHdr(dv, o, dinfSize, 'dinf');
        // dref
        o = this._boxHdr(dv, o, drefSize, 'dref');
        o = this._w32(dv, o, 0); // version+flags
        o = this._w32(dv, o, 1); // entry count
        // url box (self-contained: flags=1 means no location string)
        o = this._boxHdr(dv, o, urlBoxSize, 'url ');
        o = this._w32(dv, o, 1); // version=0, flags=1 (self-contained)

        // stbl
        o = this._boxHdr(dv, o, stblSize, 'stbl');

        // stsd
        o = this._boxHdr(dv, o, stsdSize, 'stsd');
        o = this._w32(dv, o, 0); // version+flags
        o = this._w32(dv, o, 1); // entry count

        // avc1
        o = this._boxHdr(dv, o, avc1Size, 'avc1');
        o += 6; // reserved
        dv.setUint16(o, 1, false); o += 2; // data_reference_index
        o += 16; // reserved
        dv.setUint16(o, width, false);  o += 2;
        dv.setUint16(o, height, false); o += 2;
        o = this._w32(dv, o, 0x00480000); // horizresolution 72dpi
        o = this._w32(dv, o, 0x00480000); // vertresolution 72dpi
        o = this._w32(dv, o, 0); // reserved
        dv.setUint16(o, 1, false); o += 2; // frame_count
        o += 32; // compressorname (empty)
        dv.setUint16(o, 0x0018, false); o += 2; // depth
        dv.setInt16(o, -1, false); o += 2; // pre_defined

        // avcC
        o = this._boxHdr(dv, o, avcCSize, 'avcC');
        dv.setUint8(o, 1); o++; // configurationVersion
        dv.setUint8(o, spsRbsp[1]); o++; // AVCProfileIndication
        dv.setUint8(o, spsRbsp[2]); o++; // profile_compatibility
        dv.setUint8(o, spsRbsp[3]); o++; // AVCLevelIndication
        dv.setUint8(o, 0xFF); o++; // lengthSizeMinusOne = 3 (4-byte lengths)
        dv.setUint8(o, 0xE1); o++; // numSequenceParameterSets = 1
        dv.setUint16(o, spsLen, false); o += 2;
        u8.set(spsRbsp, o); o += spsLen;
        dv.setUint8(o, 1); o++; // numPictureParameterSets = 1
        dv.setUint16(o, ppsLen, false); o += 2;
        u8.set(ppsRbsp, o); o += ppsLen;

        // stts (empty)
        o = this._boxHdr(dv, o, sttsSize, 'stts');
        o = this._w32(dv, o, 0); o = this._w32(dv, o, 0);
        // stsc (empty)
        o = this._boxHdr(dv, o, stscSize, 'stsc');
        o = this._w32(dv, o, 0); o = this._w32(dv, o, 0);
        // stsz (empty)
        o = this._boxHdr(dv, o, stszSize, 'stsz');
        o = this._w32(dv, o, 0); o = this._w32(dv, o, 0); o = this._w32(dv, o, 0);
        // stco (empty)
        o = this._boxHdr(dv, o, stcoSize, 'stco');
        o = this._w32(dv, o, 0); o = this._w32(dv, o, 0);

        // mvex
        o = this._boxHdr(dv, o, mvexSize, 'mvex');
        // trex
        o = this._boxHdr(dv, o, trexSize, 'trex');
        o = this._w32(dv, o, 0); // version+flags
        o = this._w32(dv, o, 1); // track_ID
        o = this._w32(dv, o, 1); // default_sample_description_index
        o = this._w32(dv, o, 0); // default_sample_duration
        o = this._w32(dv, o, 0); // default_sample_size
        o = this._w32(dv, o, 0); // default_sample_flags

        return buf;
    }

    /**
     * Build moof box for one fragment:
     * moof(mfhd + traf(tfhd + trun))
     */
    _buildMoof(seqNum, payloadSize, isKeyframe) {
        // trun flags: 0x000701 = data-offset-present(0x001) | sample-duration(0x100) | sample-size(0x200) | sample-flags(0x400)
        // Per-sample data: duration(4) + size(4) + flags(4) = 12 bytes
        const trunSize = 8 + 4 + 4 + 4 + 12; // hdr(8)+version_flags(4)+sample_count(4)+data_offset(4)+per_sample(12)
        const tfhdSize = 8 + 4 + 4;           // hdr(8)+version_flags(4)+track_ID(4)
        const tfdtSize = 8 + 4 + 4;           // hdr(8)+version_flags(4)+baseMediaDecodeTime(4)
        const trafSize = 8 + tfhdSize + tfdtSize + trunSize;
        const mfhdSize = 8 + 4 + 4;           // hdr(8)+version_flags(4)+sequence_number(4)
        const moofSize = 8 + mfhdSize + trafSize;

        const buf = new ArrayBuffer(moofSize);
        const dv = new DataView(buf);
        let o = 0;

        // moof
        o = this._boxHdr(dv, o, moofSize, 'moof');
        // mfhd
        o = this._boxHdr(dv, o, mfhdSize, 'mfhd');
        o = this._w32(dv, o, 0);       // version=0, flags=0
        o = this._w32(dv, o, seqNum);
        // traf
        o = this._boxHdr(dv, o, trafSize, 'traf');
        // tfhd: flags 0x020000 = default-base-is-moof
        o = this._boxHdr(dv, o, tfhdSize, 'tfhd');
        o = this._w32(dv, o, 0x020000);
        o = this._w32(dv, o, 1);  // track_ID
        // tfdt: Track Fragment Base Media Decode Time (mandatory for Chromium/webOS MSE demuxer)
        const decodeTime = (seqNum - 1) * 3000;
        o = this._boxHdr(dv, o, tfdtSize, 'tfdt');
        o = this._w32(dv, o, 0);
        o = this._w32(dv, o, decodeTime);
        // trun: flags 0x000701 = data-offset + sample-duration + sample-size + sample-flags
        o = this._boxHdr(dv, o, trunSize, 'trun');
        o = this._w32(dv, o, 0x000701);        // version=0, flags
        o = this._w32(dv, o, 1);               // sample_count
        o = this._w32(dv, o, moofSize + 8);    // data_offset (points past mdat header)
        // per-sample
        o = this._w32(dv, o, 3000);            // sample_duration (90000 timescale / 30fps)
        o = this._w32(dv, o, payloadSize);     // sample_size
        // sample_flags: is-not-leading(2<<26) | depends-on-others bit clear for keyframe
        o = this._w32(dv, o, isKeyframe ? 0x02000000 : 0x01010000);

        return buf;
    }

    /** Build mdat box wrapping AVCC-format payload */
    _buildMdat(avcc) {
        const size = 8 + avcc.length;
        const buf = new ArrayBuffer(size);
        const dv = new DataView(buf);
        this._boxHdr(dv, 0, size, 'mdat');
        new Uint8Array(buf).set(avcc, 8);
        return buf;
    }

    // =========================================================================
    // WebCodecs RENDER
    // =========================================================================

    _renderFrame(videoFrame) {
        try {
            const frameW = videoFrame.displayWidth || videoFrame.codedWidth;
            const frameH = videoFrame.displayHeight || videoFrame.codedHeight;
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
    }

    // =========================================================================
    // CODEC STRING DERIVATION
    // =========================================================================

    /**
     * Derive avc1.PPCCLL codec string from Annex-B SPS.
     * Also handles raw RBSP (no start code) as fallback.
     */
    _deriveCodecStr(configBytes) {
        // Annex-B path: scan for start code then SPS NAL
        for (let i = 0; i < Math.min(16, configBytes.length - 4); i++) {
            const is4 = configBytes[i]===0 && configBytes[i+1]===0 && configBytes[i+2]===0 && configBytes[i+3]===1;
            const is3 = configBytes[i]===0 && configBytes[i+1]===0 && configBytes[i+2]===1;
            const nalOff = is4 ? i + 4 : (is3 ? i + 3 : -1);
            if (nalOff < 0) continue;
            const nalType = configBytes[nalOff] & 0x1f;
            if (nalType === 7 && configBytes.length > nalOff + 3) {
                const p = configBytes[nalOff+1], c = configBytes[nalOff+2], l = configBytes[nalOff+3];
                const codec = `avc1.${p.toString(16).padStart(2,'0')}${c.toString(16).padStart(2,'0')}${l.toString(16).padStart(2,'0')}`;
                console.log(`[Player] Codec from Annex-B SPS: ${codec}`);
                return codec;
            }
        }
        // Raw RBSP fallback: first byte is NAL header
        if (configBytes.length >= 4 && (configBytes[0] & 0x1f) === 7) {
            const p = configBytes[1], c = configBytes[2], l = configBytes[3];
            const codec = `avc1.${p.toString(16).padStart(2,'0')}${c.toString(16).padStart(2,'0')}${l.toString(16).padStart(2,'0')}`;
            console.log(`[Player] Codec from raw RBSP SPS: ${codec}`);
            return codec;
        }
        console.warn('[Player] Could not derive codec string');
        return null;
    }

    // =========================================================================
    // STREAM EVENTS
    // =========================================================================

    onStreamStart(width, height, fps) {
        this._width = width;
        this._height = height;
        this._fps = fps;
        this._frameWidth = width;
        this._frameHeight = height;
        if (this._useWebCodecs) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
        console.log(`[Player] Stream start: ${width}x${height} @ ${fps}fps`);
    }

    onOrientationChange(rotation, width, height) {
        console.log(`[Player] Orientation: rot=${rotation}°, ${width}x${height}`);
        if (width && height) {
            this._width = width;
            this._height = height;
            this._frameWidth = width;
            this._frameHeight = height;
            if (this._useWebCodecs) {
                this.canvas.width = width;
                this.canvas.height = height;
            }
            this._rotation = 0;
        } else {
            this._rotation = rotation || 0;
        }
        this._updateTransforms();
        this.setScaleMode(this._scaleMode);
    }

    // =========================================================================
    // VIEW CONTROLS
    // =========================================================================

    rotate90() {
        this._rotation = (this._rotation + 90) % 360;
        this._updateTransforms();
        return this._rotation;
    }

    setScaleMode(mode) {
        this._scaleMode = mode;
        const cropCanvas = document.getElementById('crop-canvas');
        const targets = this._useWebCodecs
            ? [this.canvas, ...(cropCanvas ? [cropCanvas] : [])]
            : [this.video, ...(cropCanvas ? [cropCanvas] : [])];

        targets.forEach(target => {
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
                    target.style.width = `${this._width}px`;
                    target.style.height = `${this._height}px`;
                    target.style.objectFit = 'none';
                    this._zoom = 1.0;
                    break;
                case 'custom':
                    target.style.objectFit = 'contain';
                    break;
            }
        });
        this._updateTransforms();
    }

    setZoom(factor) {
        this._zoom = Math.max(0.2, Math.min(6.0, factor));
        this._updateTransforms();
    }

    zoomBy(multiplier) {
        this.setZoom(this._zoom * multiplier);
        return this._zoom;
    }

    resetView() {
        this._zoom = 1.0;
        this._rotation = 0;
        this.setScaleMode('fit');
    }

    _updateTransforms() {
        const cropCanvas = document.getElementById('crop-canvas');
        const active = this._useWebCodecs ? this.canvas : this.video;
        [active, ...(cropCanvas ? [cropCanvas] : [])].forEach(t => {
            if (t) t.style.transform = `rotate(${this._rotation}deg) scale(${this._zoom})`;
        });
    }

    getStats() {
        return {
            width: this._width,
            height: this._height,
            fps: this._fps,
            rotation: this._rotation,
            zoom: this._zoom
        };
    }

    destroy() {
        if (this._decoder) {
            try { this._decoder.close(); } catch (_) {}
            this._decoder = null;
        }
        if (this._ms && this._ms.readyState === 'open') {
            try { this._ms.endOfStream(); } catch (_) {}
        }
        if (this.video.src) {
            URL.revokeObjectURL(this.video.src);
            this.video.src = '';
        }
        if (this.ctx) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
    }
}
