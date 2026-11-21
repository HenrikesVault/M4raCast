/**
 * M4raCast Agent Discovery
 * Probes local network IP addresses for M4raCast agents using the HTTP /info endpoint.
 */
export class Discovery {
    constructor() {
        this.agents = new Map(); // key: "host:port" -> agent object
        this.onAgentsChanged = null;
        this.onScanProgress = null;
        this.onScanComplete = null;
        this._scanController = null;
    }

    /**
     * Start scanning the local LAN for active M4raCast agents.
     */
    async scan() {
        if (this._scanController) {
            this._scanController.abort();
        }
        this._scanController = new AbortController();
        const signal = this._scanController.signal;

        this.agents.clear();
        this._notify();

        // Check if page was loaded directly from an agent
        if (window.location.hostname && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
            const host = window.location.hostname;
            const port = parseInt(window.location.port || '80', 10);
            await this._probeAgent(host, port, signal);
        }

        // Check localhost / loopback for local dev testing
        await this._probeAgent('127.0.0.1', 8080, signal);
        await this._probeAgent('127.0.0.1', 54321, signal);

        // Subnet scanning
        const subnets = this._guessSubnets();
        const commonPorts = [54321, 8080, 8888, 5000, 42401];

        const targets = [];
        for (const subnet of subnets) {
            for (let i = 1; i <= 254; i++) {
                const ip = `${subnet}.${i}`;
                for (const p of commonPorts) {
                    targets.push({ host: ip, port: p });
                }
            }
        }

        // Run batched probes to avoid browser connection limit exhaustion
        const batchSize = 32;
        for (let i = 0; i < targets.length; i += batchSize) {
            if (signal.aborted) break;
            const batch = targets.slice(i, i + batchSize);
            const promises = batch.map(t => this._probeAgent(t.host, t.port, signal).catch(e => e));
            await Promise.all(promises);
            if (this.onScanProgress) this.onScanProgress(Math.round(((i + batch.length) / targets.length) * 100));
        }

        if (!signal.aborted) {
            if (this.onScanComplete) this.onScanComplete();
        }
    }

    async _probeAgent(host, port, signal) {
        try {
            const timeoutSignal = AbortSignal.timeout ? AbortSignal.timeout(900) : null;
            const combinedSignal = timeoutSignal && AbortSignal.any 
                ? AbortSignal.any([signal, timeoutSignal])
                : signal;

            const url = `http://${host}:${port}/m4racast/v1/info`;
            const resp = await fetch(url, {
                signal: combinedSignal,
                mode: 'cors',
                headers: { 'Accept': 'application/json' }
            });

            if (!resp.ok) return null;
            const info = await resp.json();

            // Validate M4raCast protocol signature
            if (info && (info.version || info.name)) {
                const agent = {
                    host,
                    port,
                    name: info.name || `M4raCast (${host})`,
                    version: info.version || '1.0',
                    protected: Boolean(info.protected),
                    streaming: Boolean(info.streaming),
                    resolution: info.resolution || 'unknown',
                    fps: info.fps || 30
                };
                const key = `${host}:${port}`;
                this.agents.set(key, agent);
                this._notify();
                return agent;
            }
        } catch (_) {
            // Unreachable or not a M4raCast agent
        }
        return null;
    }

    async probeSpecific(host, port) {
        const controller = new AbortController();
        const agent = await this._probeAgent(host, port, controller.signal);
        return agent;
    }

    _guessSubnets() {
        const subnets = new Set();
        const host = window.location.hostname;
        if (host && host.includes('.')) {
            const parts = host.split('.');
            if (parts.length === 4 && parts[0] !== '127') {
                subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
            }
        }
        // Common default private subnets
        subnets.add('192.168.1');
        subnets.add('192.168.0');
        subnets.add('192.168.43'); // Android Hotspot default subnet
        subnets.add('10.0.0');
        return Array.from(subnets);
    }

    _notify() {
        if (this.onAgentsChanged) this.onAgentsChanged(Array.from(this.agents.values()));
    }
}

