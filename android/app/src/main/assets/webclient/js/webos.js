/**
 * M4raCast — LG webOS Platform Integration
 *
 * Handles:
 *  - webOS remote control key codes (Arrows 37-40, OK 13, Back 461, Exit 1001, Colour buttons)
 *  - Magic Remote pointer auto-hide
 *  - Visual focus class management (.tv-focused)
 *  - App lifecycle (visibility / suspend / resume)
 */
(function () {
    'use strict';

    var WEBOS = {
        LEFT:   37,
        UP:     38,
        RIGHT:  39,
        DOWN:   40,
        ENTER:  13,
        BACK:   461,  // Back / Return button on remote
        EXIT:   1001, // EXIT hard-key
        RED:    403,  // Colour button A
        GREEN:  404,  // Colour button B
        YELLOW: 405,  // Colour button C
        BLUE:   406,  // Colour button D
    };

    // Keep track of focused element and apply .tv-focused class
    function applyFocusClass(el) {
        document.querySelectorAll('.tv-focused').forEach(function (node) {
            if (node !== el) node.classList.remove('tv-focused');
        });
        if (el && el !== document.body) {
            el.classList.add('tv-focused');
        }
    }

    document.addEventListener('focusin', function (e) {
        applyFocusClass(e.target);
    });

    document.addEventListener('focusout', function (e) {
        if (e.target) e.target.classList.remove('tv-focused');
    });

    // Intercept remote keys at window level
    window.addEventListener('keydown', function (e) {
        var code = e.keyCode || e.which;

        switch (code) {
            // Back / Return → dispatch Escape for app handler
            case WEBOS.BACK:
                e.preventDefault();
                e.stopImmediatePropagation();
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
                    bubbles: true, cancelable: true
                }));
                break;

            // EXIT key → platform back or window close
            case WEBOS.EXIT:
                e.preventDefault();
                if (window.webOS && typeof webOS.platformBack === 'function') {
                    webOS.platformBack();
                } else if (window.close) {
                    window.close();
                }
                break;

            // Red button → Disconnect
            case WEBOS.RED:
                e.preventDefault();
                var btnDisc = document.getElementById('btn-disconnect');
                if (btnDisc) btnDisc.click();
                break;

            // Green button → Toggle Audio
            case WEBOS.GREEN:
                e.preventDefault();
                var btnAud = document.getElementById('btn-audio');
                if (btnAud) btnAud.click();
                break;

            // Yellow button → Fit
            case WEBOS.YELLOW:
                e.preventDefault();
                var btnFit = document.getElementById('btn-fit');
                if (btnFit) btnFit.click();
                break;

            // Blue button → Fullscreen
            case WEBOS.BLUE:
                e.preventDefault();
                var btnFs = document.getElementById('btn-fullscreen');
                if (btnFs) btnFs.click();
                break;
        }
    }, true);

    // Magic Remote pointer: auto-hide cursor after 3s or when arrow keys are pressed
    var _cursorTimer = null;
    function showCursor() {
        document.documentElement.style.cursor = '';
        clearTimeout(_cursorTimer);
        _cursorTimer = setTimeout(hideCursor, 3000);
    }
    function hideCursor() {
        document.documentElement.style.cursor = 'none';
    }

    document.addEventListener('mousemove', showCursor, { passive: true });
    window.addEventListener('keydown', function (e) {
        var code = e.keyCode || e.which;
        // If an arrow key or Enter was pressed, hide mouse cursor so TV D-Pad focus is obvious
        if (code >= 37 && code <= 40 || code === 13) {
            hideCursor();
        }
    }, { passive: true });
    hideCursor();

    // webOS App lifecycle
    if (window.webOS) {
        webOS.onVisible = function () {
            console.log('[webOS] App visible');
        };
        webOS.onHidden = function () {
            console.log('[webOS] App hidden');
        };
    }

    console.log('[webOS] Platform script initialized');
})();
