/**
 * M4raCast Precision Cropper
 * Performs client-side, zero-re-encode, pixel-accurate video cropping and aspect ratio transforms.
 */
export class Cropper {
    constructor(sourceCanvas, cropCanvas) {
        this.sourceCanvas = sourceCanvas;
        this.cropCanvas = cropCanvas;
        this.ctx = this.cropCanvas.getContext('2d', { alpha: false, desynchronized: true });

        this.crop = { top: 0, bottom: 0, left: 0, right: 0 };
        this._active = false;
        this._animFrame = null;
        this.onCropChange = null;
    }

    /**
     * Check if any crop edge is active (> 0)
     */
    isCropActive() {
        return this.crop.top > 0 || this.crop.bottom > 0 || this.crop.left > 0 || this.crop.right > 0;
    }

    /**
     * Set explicit pixel crop boundaries
     */
    setCrop(cropValues) {
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
    }

    /**
     * Compute and apply crop parameters to match target aspect ratio (e.g. 16:9, 16:10, 4:3)
     */
    applyAspectRatioPreset(preset) {
        const sw = this.sourceCanvas.width || 1920;
        const sh = this.sourceCanvas.height || 1080;

        if (preset === 'original' || preset === 'none') {
            this.setCrop({ top: 0, bottom: 0, left: 0, right: 0 });
            return { top: 0, bottom: 0, left: 0, right: 0 };
        }

        let targetRatio = 16 / 9;
        if (preset === '16:10') targetRatio = 16 / 10;
        else if (preset === '4:3') targetRatio = 4 / 3;
        else if (preset === '21:9') targetRatio = 21 / 9;
        else if (preset === '9:16') targetRatio = 9 / 16;

        const currentRatio = sw / sh;
        let newCrop = { top: 0, bottom: 0, left: 0, right: 0 };

        if (currentRatio > targetRatio) {
            // Source is wider than target -> crop left and right
            const targetW = Math.round(sh * targetRatio);
            const totalDiff = Math.max(0, sw - targetW);
            newCrop.left = Math.floor(totalDiff / 2);
            newCrop.right = totalDiff - newCrop.left;
        } else {
            // Source is taller than target (common for phone portrait screen) -> crop top and bottom
            const targetH = Math.round(sw / targetRatio);
            const totalDiff = Math.max(0, sh - targetH);
            newCrop.top = Math.floor(totalDiff / 2);
            newCrop.bottom = totalDiff - newCrop.top;
        }

        this.setCrop(newCrop);
        return newCrop;
    }

    reset() {
        this.setCrop({ top: 0, bottom: 0, left: 0, right: 0 });
    }

    _startRenderLoop() {
        if (!this._active) {
            this._active = true;
            this.cropCanvas.style.display = 'block';
            this.sourceCanvas.style.display = 'none';

            const loop = () => {
                if (!this._active) return;
                this._render();
                this._animFrame = requestAnimationFrame(loop);
            };
            this._animFrame = requestAnimationFrame(loop);
        }
    }

    _stopRenderLoop() {
        if (this._active) {
            this._active = false;
            if (this._animFrame) {
                cancelAnimationFrame(this._animFrame);
                this._animFrame = null;
            }
            this.cropCanvas.style.display = 'none';
            this.sourceCanvas.style.display = 'block';
        }
    }

    _render() {
        const sw = this.sourceCanvas.width;
        const sh = this.sourceCanvas.height;
        if (!sw || !sh) return;

        const sx = this.crop.left;
        const sy = this.crop.top;
        const sWidth = Math.max(1, sw - this.crop.left - this.crop.right);
        const sHeight = Math.max(1, sh - this.crop.top - this.crop.bottom);

        if (this.cropCanvas.width !== sWidth || this.cropCanvas.height !== sHeight) {
            this.cropCanvas.width = sWidth;
            this.cropCanvas.height = sHeight;
        }

        // Blit sub-rectangle of source canvas to cropped canvas
        this.ctx.drawImage(
            this.sourceCanvas,
            sx, sy, sWidth, sHeight,
            0, 0, sWidth, sHeight
        );
    }

    destroy() {
        this._stopRenderLoop();
    }
}

