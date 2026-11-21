/**
 * M4raCast TV Web Client — Orchestrator Application
 * TV-first UI with D-Pad navigation, detailed connection diagnostics, and /stream/{code} routing.
 * Fully compatible with LG webOS 5.40.97 (Chromium 68) — no optional chaining, no nullish coalescing.
 */
import { Connection } from './connection.js';
import { Player } from './player.js';
import { Cropper } from './cropper.js';
import { AudioPlayer } from './audio.js';

class M4raCastApp {
    constructor() {
        this.connection = null;
        this.player = null;
        this.cropper = null;
        this.audioPlayer = new AudioPlayer();
        this.abortController = null;
        this.isConnecting = false;

        this.screens = {
            connect: document.getElementById('screen-connect'),
            viewer: document.getElementById('screen-viewer'),
        };

        this.initTVNavigation();
        this.initConnectUI();
        this.initViewerUI();
        this.initCropperUI();
        this.handleInitialRouting();
    }

    /* =========================================================================
       URL ROUTING & DEEP LINKING (/stream/{code} or /stream/{ip}:{port})
       ========================================================================= */
    async handleInitialRouting() {
        const path = window.location.pathname;
        const search = new URLSearchParams(window.location.search);

        let targetIp = search.get('host') || search.get('ip') || '';
        let targetPort = search.get('port') || '';

        // Check if path is like /stream/192.168.0.7:46283 or /stream/192.168.0.7_46283
        if (path.indexOf('/stream/') === 0) {
            const rawParam = decodeURIComponent(path.replace('/stream/', '').trim());
            if (rawParam) {
                if (rawParam.indexOf(':') !== -1) {
                    const parts = rawParam.split(':');
                    targetIp = parts[0];
                    targetPort = parts[1];
                } else if (rawParam.indexOf('_') !== -1) {
                    const parts = rawParam.split('_');
                    targetIp = parts[0];
                    targetPort = parts[1];
                } else {
                    targetIp = rawParam;
                }
            }
        }

        const manualGroup = document.getElementById('manual-connect-group');
        const hintBox = document.getElementById('endpoint-hint-box');
        const fieldPassword = document.getElementById('field-password');
        const passwordHint = document.getElementById('password-hint');
        const subtitle = document.querySelector('.tv-subtitle');
        const ipInput = document.getElementById('input-ip');
        const portInput = document.getElementById('input-port');
        const passwordInput = document.getElementById('input-password');

        // Check if this webpage is served directly by the Android app's own agent server
        let isDirectAgent = false;
        let agentInfo = null;
        try {
            const probeResp = await fetch('/m4racast/v1/info');
            if (probeResp.ok) {
                agentInfo = await probeResp.json();
                if (agentInfo && agentInfo.name) {
                    isDirectAgent = true;
                }
            }
        } catch (_) {}

        if (isDirectAgent) {
            targetIp = window.location.hostname;
            targetPort = window.location.port || '80';
            ipInput.value = targetIp;
            portInput.value = targetPort;

            if (manualGroup) manualGroup.style.display = 'none';
            if (hintBox) hintBox.style.display = 'none';

            if (agentInfo.protected) {
                if (subtitle) subtitle.textContent = 'Enter the security password to connect to this screen.';
                if (passwordHint) passwordHint.textContent = '(required)';
                if (passwordInput) passwordInput.focus();
            } else {
                if (fieldPassword) fieldPassword.style.display = 'none';
                if (subtitle) subtitle.textContent = 'Connecting directly to screen...';
                setTimeout(() => this.startConnectFlow(), 150);
                return;
            }
        } else {
            if (manualGroup) manualGroup.style.display = 'block';
            if (hintBox) hintBox.style.display = 'block';

            const savedIp = localStorage.getItem('m4racast_tv_ip') || '';
            const savedPort = localStorage.getItem('m4racast_tv_port') || '46283';

            if (targetIp) {
                ipInput.value = targetIp;
                portInput.value = targetPort || savedPort || '46283';
                setTimeout(() => this.startConnectFlow(), 300);
            } else {
                ipInput.value = savedIp;
                portInput.value = savedPort;
                const btnConnect = document.getElementById('btn-connect-main');
                if (savedIp && btnConnect) {
                    btnConnect.focus();
                } else if (ipInput) {
                    ipInput.focus();
                }
            }
        }
    }

    /* =========================================================================
       TV REMOTE & D-PAD NAVIGATION
       ========================================================================= */
    initTVNavigation() {
        setTimeout(() => {
            const initialFocus = document.getElementById('btn-connect-main') || document.getElementById('input-ip');
            if (initialFocus) initialFocus.focus();
        }, 150);

        window.addEventListener('keydown', (e) => {
            const code = e.keyCode || e.which;
            const key = e.key || '';

            // Arrow Down
            if (code === 40 || key === 'ArrowDown' || key === 'Down') {
                this.navigateSpatial('down');
                e.preventDefault();
            }
            // Arrow Up
            else if (code === 38 || key === 'ArrowUp' || key === 'Up') {
                this.navigateSpatial('up');
                e.preventDefault();
            }
            // Arrow Right
            else if (code === 39 || key === 'ArrowRight' || key === 'Right') {
                this.navigateSpatial('right');
                e.preventDefault();
            }
            // Arrow Left
            else if (code === 37 || key === 'ArrowLeft' || key === 'Left') {
                this.navigateSpatial('left');
                e.preventDefault();
            }
            // Enter / OK button
            else if (code === 13 || key === 'Enter') {
                const active = document.activeElement;
                if (active && active.tagName === 'BUTTON') {
                    active.click();
                    e.preventDefault();
                } else if (active && (active.id === 'input-ip' || active.id === 'input-port' || active.id === 'input-password')) {
                    this.startConnectFlow();
                    e.preventDefault();
                }
            }
            // Escape / Back
            else if (code === 27 || code === 461 || key === 'Escape' || key === 'Back' || key === 'BrowserBack') {
                this.handleTVBack();
                e.preventDefault();
            }
        });
    }

    navigateSpatial(direction) {
        const modalConnecting = document.getElementById('modal-connecting');
        const cropPanel = document.getElementById('crop-panel');
        let container = document.body;

        if (modalConnecting && modalConnecting.style.display !== 'none') {
            container = modalConnecting;
        } else if (cropPanel && cropPanel.style.display === 'block') {
            container = cropPanel;
        } else {
            const activeScreen = document.querySelector('.screen.active');
            if (activeScreen) container = activeScreen;
        }

        const focusable = Array.from(container.querySelectorAll(
            'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )).filter(el => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none' && window.getComputedStyle(el).visibility !== 'hidden';
        });

        if (focusable.length === 0) return;

        const active = document.activeElement;
        const currentIndex = focusable.indexOf(active);

        if (currentIndex === -1 || active === document.body || !active) {
            const preferred = focusable.find(el => el.id === 'btn-connect-main') || focusable[0];
            if (preferred) preferred.focus();
            return;
        }

        const currentRect = active.getBoundingClientRect();
        let bestTarget = null;
        let minDistance = Infinity;

        focusable.forEach(candidate => {
            if (candidate === active) return;
            const candRect = candidate.getBoundingClientRect();

            let isDirectional = false;
            let dX = (candRect.left + candRect.width / 2) - (currentRect.left + currentRect.width / 2);
            let dY = (candRect.top + candRect.height / 2) - (currentRect.top + currentRect.height / 2);

            switch (direction) {
                case 'down':
                    isDirectional = dY > 15;
                    break;
                case 'up':
                    isDirectional = dY < -15;
                    break;
                case 'right':
                    isDirectional = dX > 15;
                    break;
                case 'left':
                    isDirectional = dX < -15;
                    break;
            }

            if (isDirectional) {
                const dist = Math.hypot(dX, dY);
                if (dist < minDistance) {
                    minDistance = dist;
                    bestTarget = candidate;
                }
            }
        });

        if (bestTarget) {
            bestTarget.focus();
        } else {
            if (direction === 'down' || direction === 'right') {
                const next = focusable[(currentIndex + 1) % focusable.length];
                if (next) next.focus();
            } else if (direction === 'up' || direction === 'left') {
                const prev = focusable[(currentIndex - 1 + focusable.length) % focusable.length];
                if (prev) prev.focus();
            }
        }
    }

    handleTVBack() {
        const modal = document.getElementById('modal-connecting');
        if (modal && modal.style.display !== 'none') {
            this.cancelConnectFlow();
            return;
        }

        const cropPanel = document.getElementById('crop-panel');
        if (cropPanel && cropPanel.style.display !== 'none') {
            cropPanel.style.display = 'none';
            const btnCrop = document.getElementById('btn-crop');
            if (btnCrop) btnCrop.focus();
            return;
        }

        if (this.screens.viewer.classList.contains('active')) {
            if (this.connection) this.connection.disconnect();
        }
    }

    /* =========================================================================
       CONNECT FLOW & DIAGNOSTICS MODAL
       ========================================================================= */
    initConnectUI() {
        const btnConnect = document.getElementById('btn-connect-main');
        const btnCancel = document.getElementById('btn-cancel-connecting');
        const ipInput = document.getElementById('input-ip');
        const portInput = document.getElementById('input-port');
        const passwordInput = document.getElementById('input-password');

        if (btnConnect) btnConnect.addEventListener('click', () => this.startConnectFlow());
        if (btnCancel) btnCancel.addEventListener('click', () => this.cancelConnectFlow());

        [ipInput, portInput, passwordInput].forEach(inp => {
            if (inp) {
                inp.addEventListener('keydown', (e) => {
                    const code = e.keyCode || e.which;
                    if (code === 13 || e.key === 'Enter') {
                        this.startConnectFlow();
                    }
                });
            }
        });
    }

    async startConnectFlow() {
        if (this.isConnecting) return;

        const ip = document.getElementById('input-ip').value.trim();
        const port = parseInt(document.getElementById('input-port').value.trim(), 10);
        const password = document.getElementById('input-password').value;

        if (!ip || isNaN(port)) {
            alert('Please enter a valid IP address and port.');
            const inputIp = document.getElementById('input-ip');
            if (inputIp) inputIp.focus();
            return;
        }

        localStorage.setItem('m4racast_tv_ip', ip);
        localStorage.setItem('m4racast_tv_port', port.toString());

        this.isConnecting = true;
        this.abortController = new AbortController();

        if (this.audioPlayer) this.audioPlayer.initContext();

        const modal = document.getElementById('modal-connecting');
        if (modal) modal.style.display = 'flex';
        const targetEl = document.getElementById('connecting-target');
        if (targetEl) targetEl.textContent = `${ip}:${port}`;
        const titleEl = document.getElementById('connecting-title');
        if (titleEl) titleEl.textContent = 'Connecting to Screen...';
        const cancelBtn = document.getElementById('btn-cancel-connecting');
        if (cancelBtn) {
            cancelBtn.textContent = 'Cancel Connection';
            cancelBtn.focus();
        }

        this.resetSteps();
        this.logDebug(`[Init] Establishing connection to ${ip}:${port}...`, 'info');

        const baseUrl = `http://${ip}:${port}`;

        try {
            // Step 1: Probe Host Endpoint
            this.setStepStatus('step-probe', 'active');
            this.logDebug(`[Step 1] GET ${baseUrl}/m4racast/v1/info`, 'info');

            const infoResp = await fetch(`${baseUrl}/m4racast/v1/info`, {
                signal: this.abortController.signal,
                mode: 'cors'
            });

            if (!infoResp.ok) throw new Error(`Agent info returned HTTP ${infoResp.status}`);
            const infoData = await infoResp.json();
            this.setStepStatus('step-probe', 'done');
            this.logDebug(`[Step 1] Verified agent "${infoData.name}" (${infoData.fps}fps, ${infoData.resolution})`, 'success');

            // Step 2: Authentication
            this.setStepStatus('step-auth', 'active');
            let token = '';

            if (infoData.protected) {
                this.logDebug(`[Step 2] Agent is protected, retrieving challenge nonce...`, 'info');
                const nonceResp = await fetch(`${baseUrl}/m4racast/v1/nonce`, { signal: this.abortController.signal });
                if (!nonceResp.ok) throw new Error('Failed to retrieve authentication nonce');
                const nonceObj = await nonceResp.json();
                const nonce = nonceObj.nonce;

                const passHash = await this.sha256((password || '') + nonce);
                const authResp = await fetch(`${baseUrl}/m4racast/v1/auth`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password_hash: passHash, nonce }),
                    signal: this.abortController.signal
                });

                if (!authResp.ok) throw new Error('Authentication failed: Invalid password');
                const authData = await authResp.json();
                token = authData.token;
            } else {
                this.logDebug(`[Step 2] Requesting open session token...`, 'info');
                const authResp = await fetch(`${baseUrl}/m4racast/v1/auth`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({}),
                    signal: this.abortController.signal
                });
                if (authResp.ok) {
                    const authData = await authResp.json();
                    token = authData.token || '';
                }
            }

            this.setStepStatus('step-auth', 'done');
            this.logDebug(`[Step 2] Session authenticated (Token: ${token ? token.substring(0, 8) + '...' : 'none'})`, 'success');

            // Step 3: Decoder & Audio Pipeline
            this.setStepStatus('step-decoder', 'active');
            const decoderMode = typeof window.VideoDecoder === 'function' ? 'WebCodecs' : 'MSE/fMP4';
            this.logDebug(`[Step 3] Initializing ${decoderMode} decoder & AudioContext...`, 'info');

            const streamCanvas = document.getElementById('stream-canvas');
            const streamVideo = document.getElementById('stream-video');
            const cropCanvas = document.getElementById('crop-canvas');

            this.player = new Player(streamCanvas, streamVideo);
            this.cropper = new Cropper(streamCanvas, cropCanvas);
            if (this.audioPlayer) this.audioPlayer.initContext();

            this.setStepStatus('step-decoder', 'done');
            this.logDebug(`[Step 3] Decoder & Audio pipelines online`, 'success');

            // Step 4: WebSocket Handshake
            this.setStepStatus('step-ws', 'active');
            const wsUrl = `ws://${ip}:${port}/m4racast/v1/stream/connect${token ? `?token=${encodeURIComponent(token)}` : ''}`;
            this.logDebug(`[Step 4] Handshaking WebSocket stream at ${wsUrl}...`, 'info');

            const agent = { host: ip, port: port, name: infoData.name };
            this.connection = new Connection(agent, token, this.player, this.audioPlayer);

            this.connection.onError = (err) => {
                const errText = (err && err.message) ? err.message : String(err);
                this.logDebug(`[WebSocket] Error: ${errText}`, 'error');
            };

            this.connection.onStats = (stats) => {
                const statFps = document.getElementById('stat-fps');
                const statRes = document.getElementById('stat-resolution');
                const statLat = document.getElementById('stat-latency');
                if (statFps) statFps.textContent = `${stats.fps} fps`;
                if (statRes) statRes.textContent = `${stats.width}×${stats.height}`;
                if (statLat) statLat.textContent = `${stats.latencyMs} ms`;
            };

            this.connection.onDisconnect = () => {
                if (this.cropper) this.cropper.destroy();
                if (this.player) this.player.destroy();
                if (this.audioPlayer) this.audioPlayer.destroy();
                this.switchScreen('connect');
                const btnConnect = document.getElementById('btn-connect-main');
                if (btnConnect) btnConnect.focus();
            };

            this.connection.connect();

            // Check connection readyState
            const checkConnected = setInterval(() => {
                if (this.connection && this.connection.ws && this.connection.ws.readyState === WebSocket.OPEN) {
                    clearInterval(checkConnected);
                    this.setStepStatus('step-ws', 'done');
                    this.logDebug(`[Step 4] Handshake complete! Streaming active.`, 'success');

                    setTimeout(() => {
                        if (modal) modal.style.display = 'none';
                        this.switchScreen('viewer');
                        if (this.player) this.player.setScaleMode('fit');
                        const hudAgent = document.getElementById('hud-agent-name');
                        if (hudAgent) hudAgent.textContent = infoData.name || `${ip}:${port}`;
                        const btnDisc = document.getElementById('btn-disconnect');
                        if (btnDisc) btnDisc.focus();
                        this.isConnecting = false;
                    }, 400);
                }
            }, 100);

            // Timeout safety (8 seconds)
            setTimeout(() => {
                clearInterval(checkConnected);
                if (this.isConnecting && (!this.connection || !this.connection.ws || this.connection.ws.readyState !== WebSocket.OPEN)) {
                    this.handleConnectError(new Error('WebSocket handshake timed out (check network / firewall)'));
                }
            }, 8000);

        } catch (err) {
            this.handleConnectError(err);
        }
    }

    handleConnectError(err) {
        this.isConnecting = false;
        const msg = (err && err.message) ? err.message : String(err);
        this.logDebug(`[Error] ${msg}`, 'error');
        const titleEl = document.getElementById('connecting-title');
        if (titleEl) titleEl.textContent = 'Connection Failed';
        const cancelBtn = document.getElementById('btn-cancel-connecting');
        if (cancelBtn) cancelBtn.textContent = 'Dismiss / Try Again';

        const activeStep = document.querySelector('.tv-step.active');
        if (activeStep) {
            activeStep.classList.remove('active');
            activeStep.classList.add('error');
            const icon = activeStep.querySelector('.step-icon');
            if (icon) icon.textContent = '✕';
        }
    }

    cancelConnectFlow() {
        if (this.abortController) this.abortController.abort();
        if (this.connection) this.connection.disconnect();
        this.isConnecting = false;
        const modal = document.getElementById('modal-connecting');
        if (modal) modal.style.display = 'none';
        const btnConnect = document.getElementById('btn-connect-main');
        if (btnConnect) btnConnect.focus();
    }

    resetSteps() {
        ['step-probe', 'step-auth', 'step-decoder', 'step-ws'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.className = 'tv-step';
                const icon = el.querySelector('.step-icon');
                if (icon) icon.textContent = '○';
            }
        });
        const debugBox = document.getElementById('tv-debug-logs');
        if (debugBox) debugBox.innerHTML = '';
    }

    setStepStatus(id, status) {
        const el = document.getElementById(id);
        if (!el) return;
        el.className = `tv-step ${status}`;
        const icon = el.querySelector('.step-icon');
        if (icon) {
            if (status === 'done') icon.textContent = '✓';
            else if (status === 'active') icon.textContent = '●';
            else if (status === 'error') icon.textContent = '✕';
        }
    }

    logDebug(text, type) {
        type = type || 'info';
        const debugBox = document.getElementById('tv-debug-logs');
        if (!debugBox) return;
        const line = document.createElement('div');
        line.className = `log-line ${type}`;
        line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
        debugBox.appendChild(line);
        debugBox.scrollTop = debugBox.scrollHeight;
    }

    /* =========================================================================
       VIEWER UI
       ========================================================================= */
    initViewerUI() {
        const btnDisconnect = document.getElementById('btn-disconnect');
        if (btnDisconnect) {
            btnDisconnect.addEventListener('click', () => {
                if (this.connection) this.connection.disconnect();
            });
        }

        const btnAudio = document.getElementById('btn-audio');
        const iconAudioOn = document.getElementById('icon-audio-on');
        const iconAudioOff = document.getElementById('icon-audio-off');
        const labelAudio = document.getElementById('label-audio');

        if (btnAudio) {
            btnAudio.addEventListener('click', () => {
                const isMuted = this.audioPlayer ? this.audioPlayer.toggleMute() : false;
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

        const volumeSlider = document.getElementById('volume-slider');
        const volumeLabel = document.getElementById('volume-label');
        if (volumeSlider) {
            volumeSlider.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10);
                if (volumeLabel) volumeLabel.textContent = `${val}%`;
                if (this.audioPlayer) this.audioPlayer.setVolume(val / 100);
                if (val > 0 && this.audioPlayer && this.audioPlayer.muted) {
                    this.audioPlayer.setMuted(false);
                    if (iconAudioOn) iconAudioOn.style.display = 'inline';
                    if (iconAudioOff) iconAudioOff.style.display = 'none';
                    if (labelAudio) labelAudio.textContent = 'Audio';
                    if (btnAudio) btnAudio.classList.remove('muted');
                }
            });
        }

        const btnFs = document.getElementById('btn-fullscreen');
        if (btnFs) {
            btnFs.addEventListener('click', () => {
                const container = document.getElementById('viewer-container');
                if (!document.fullscreenElement) {
                    if (container && container.requestFullscreen) container.requestFullscreen();
                } else {
                    if (document.exitFullscreen) document.exitFullscreen();
                }
            });
        }

        const btnFit = document.getElementById('btn-fit');
        if (btnFit) {
            btnFit.addEventListener('click', () => {
                if (this.player) this.player.setScaleMode('fit');
                const scaleMode = document.getElementById('scale-mode');
                if (scaleMode) scaleMode.value = 'fit';
                const customZoom = document.getElementById('custom-zoom-row');
                if (customZoom) customZoom.style.display = 'none';
            });
        }

        const btnRot = document.getElementById('btn-rotate');
        if (btnRot) {
            btnRot.addEventListener('click', () => {
                if (this.player) this.player.rotate90();
            });
        }

        const btnCrop = document.getElementById('btn-crop');
        const panelCrop = document.getElementById('crop-panel');
        if (btnCrop) {
            btnCrop.addEventListener('click', () => {
                if (!panelCrop) return;
                const isOpen = panelCrop.style.display === 'block';
                panelCrop.style.display = isOpen ? 'none' : 'block';
                if (!isOpen) {
                    const presetBtn = document.querySelector('.preset-btn');
                    if (presetBtn) presetBtn.focus();
                }
            });
        }
        const btnCloseCrop = document.getElementById('btn-close-crop');
        if (btnCloseCrop) {
            btnCloseCrop.addEventListener('click', () => {
                if (panelCrop) panelCrop.style.display = 'none';
                if (btnCrop) btnCrop.focus();
            });
        }

        const viewerContainer = document.getElementById('viewer-container');
        if (viewerContainer) {
            viewerContainer.addEventListener('click', () => {
                if (this.audioPlayer) this.audioPlayer.resume();
            }, { once: true });
        }

        let hudTimer = null;
        const hud = document.getElementById('viewer-hud');
        const showHUD = () => {
            if (!hud) return;
            hud.classList.remove('hidden');
            clearTimeout(hudTimer);
            hudTimer = setTimeout(() => hud.classList.add('hidden'), 4000);
        };

        if (viewerContainer) viewerContainer.addEventListener('mousemove', showHUD);
        document.addEventListener('keydown', () => {
            if (this.screens.viewer && this.screens.viewer.classList.contains('active')) {
                showHUD();
            }
        });
    }

    /* =========================================================================
       PRECISION CROP & DISPLAY UI
       ========================================================================= */
    initCropperUI() {
        const sides = ['top', 'bottom', 'left', 'right'];

        sides.forEach(side => {
            const slider = document.getElementById(`crop-${side}`);
            const num = document.getElementById(`crop-${side}-num`);

            if (slider) {
                slider.addEventListener('input', () => {
                    if (num) num.value = slider.value;
                    this.updateCropFromUI();
                });
            }

            if (num) {
                num.addEventListener('input', () => {
                    if (slider) slider.value = num.value;
                    this.updateCropFromUI();
                });
            }
        });

        document.querySelectorAll('.preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                const preset = btn.dataset.preset;
                const newCrop = this.cropper ? this.cropper.applyAspectRatioPreset(preset) : null;
                if (newCrop) {
                    sides.forEach(side => {
                        const s = document.getElementById(`crop-${side}`);
                        const n = document.getElementById(`crop-${side}-num`);
                        if (s) s.value = newCrop[side];
                        if (n) n.value = newCrop[side];
                    });
                }
            });
        });

        const btnResetCrop = document.getElementById('btn-reset-crop');
        if (btnResetCrop) {
            btnResetCrop.addEventListener('click', () => {
                sides.forEach(side => {
                    const s = document.getElementById(`crop-${side}`);
                    const n = document.getElementById(`crop-${side}-num`);
                    if (s) s.value = 0;
                    if (n) n.value = 0;
                });
                document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
                const originalBtn = document.querySelector('.preset-btn[data-preset="original"]');
                if (originalBtn) originalBtn.classList.add('active');
                if (this.cropper) this.cropper.reset();
            });
        }

        const btnCenter = document.getElementById('btn-center-view');
        if (btnCenter) {
            btnCenter.addEventListener('click', () => {
                if (this.player) this.player.resetView();
                const scaleMode = document.getElementById('scale-mode');
                if (scaleMode) scaleMode.value = 'fit';
                const customZoom = document.getElementById('custom-zoom-row');
                if (customZoom) customZoom.style.display = 'none';
            });
        }

        const scaleModeSelect = document.getElementById('scale-mode');
        if (scaleModeSelect) {
            scaleModeSelect.addEventListener('change', (e) => {
                const mode = e.target.value;
                const customZoom = document.getElementById('custom-zoom-row');
                if (customZoom) customZoom.style.display = mode === 'custom' ? 'block' : 'none';
                if (this.player) this.player.setScaleMode(mode);
            });
        }

        const zoomSlider = document.getElementById('zoom-slider');
        const zoomLabel = document.getElementById('zoom-label');
        if (zoomSlider) {
            zoomSlider.addEventListener('input', (e) => {
                const pct = parseInt(e.target.value, 10);
                if (zoomLabel) zoomLabel.textContent = `${pct}%`;
                if (this.player) this.player.setZoom(pct / 100);
            });
        }
    }

    updateCropFromUI() {
        const crop = {
            top: parseInt(document.getElementById('crop-top').value, 10) || 0,
            bottom: parseInt(document.getElementById('crop-bottom').value, 10) || 0,
            left: parseInt(document.getElementById('crop-left').value, 10) || 0,
            right: parseInt(document.getElementById('crop-right').value, 10) || 0,
        };
        if (this.cropper) this.cropper.setCrop(crop);
    }

    switchScreen(name) {
        Object.entries(this.screens).forEach(([key, el]) => {
            if (el) el.classList.toggle('active', key === name);
        });
    }

    async sha256(str) {
        if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle && typeof window.crypto.subtle.digest === 'function') {
            try {
                const buffer = new TextEncoder().encode(str);
                const digest = await window.crypto.subtle.digest('SHA-256', buffer);
                return Array.from(new Uint8Array(digest))
                    .map(b => b.toString(16).padStart(2, '0'))
                    .join('');
            } catch (_) {}
        }
        return this.pureJsSha256(str);
    }

    pureJsSha256(str) {
        function rotr(n, b) {
            return (n >>> b) | (n << (32 - b));
        }

        const K = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
        ];

        let H0 = 0x6a09e667, H1 = 0xbb67ae85, H2 = 0x3c6ef372, H3 = 0xa54ff53a;
        let H4 = 0x510e527f, H5 = 0x9b05688c, H6 = 0x1f83d9ab, H7 = 0x5be0cd19;

        const utf8 = unescape(encodeURIComponent(str));
        const byteLen = utf8.length;
        const words = [];
        for (let i = 0; i < byteLen; i++) {
            words[i >> 2] |= (utf8.charCodeAt(i) & 0xff) << (24 - (i % 4) * 8);
        }

        words[byteLen >> 2] |= 0x80 << (24 - (byteLen % 4) * 8);
        const totalWords = (((byteLen + 8) >> 6) + 1) * 16;
        while (words.length < totalWords - 2) {
            words.push(0);
        }
        words.push((byteLen * 8 / 0x100000000) | 0);
        words.push((byteLen * 8) | 0);

        const W = new Int32Array(64);

        for (let i = 0; i < words.length; i += 16) {
            for (let t = 0; t < 16; t++) {
                W[t] = words[i + t] | 0;
            }
            for (let t = 16; t < 64; t++) {
                const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
                const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
                W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
            }

            let a = H0, b = H1, c = H2, d = H3;
            let e = H4, f = H5, g = H6, h = H7;

            for (let t = 0; t < 64; t++) {
                const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
                const ch = (e & f) ^ ((~e) & g);
                const temp1 = (h + S1 + ch + K[t] + W[t]) | 0;
                const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
                const maj = (a & b) ^ (a & c) ^ (b & c);
                const temp2 = (S0 + maj) | 0;

                h = g;
                g = f;
                f = e;
                e = (d + temp1) | 0;
                d = c;
                c = b;
                b = a;
                a = (temp1 + temp2) | 0;
            }

            H0 = (H0 + a) | 0;
            H1 = (H1 + b) | 0;
            H2 = (H2 + c) | 0;
            H3 = (H3 + d) | 0;
            H4 = (H4 + e) | 0;
            H5 = (H5 + f) | 0;
            H6 = (H6 + g) | 0;
            H7 = (H7 + h) | 0;
        }

        const toHex = n => (n >>> 0).toString(16).padStart(8, '0');
        return toHex(H0) + toHex(H1) + toHex(H2) + toHex(H3) + toHex(H4) + toHex(H5) + toHex(H6) + toHex(H7);
    }
}

// Bootstrap on DOM Ready
window.addEventListener('DOMContentLoaded', () => {
    new M4raCastApp();
});
