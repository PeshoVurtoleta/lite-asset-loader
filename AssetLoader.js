/**
 * lite-asset-loader — Production Asset Loading Manager
 *
 * Queues and loads assets (images, audio, fonts, JSON, scripts, CSS, video,
 * blobs, generic fetch) with concurrency control, retry logic with exponential
 * backoff, per-asset timeouts, and granular progress tracking.
 *
 * DUAL-MODE COMPATIBILITY:
 *   Supports both EventEmitter and Promise interfaces, making it compatible
 *   with loaders that expect either:
 *     • EventEmitter: pass the AssetLoader instance directly
 *     • Promise: pass the return value of .start()
 *
 * EVENTS:
 *   "progress"  → (loaded, total)       asset finished (success or final fail)
 *   "complete"  → ()                    all assets done
 *   "error"     → (error, entry)        per-asset failure (after all retries)
 *   "asset"     → (url, result, entry)  per-asset success (with loaded object)
 *
 * ASSET TYPES (auto-detected from extension, or set manually):
 *   image, audio, video, font, json, script, css, blob, fetch
 */

export class AssetLoader {

    // ═══════════════════════════════════════════
    //  Configuration
    // ═══════════════════════════════════════════

    static DEFAULTS = {
        concurrency: 4,
        retries:     2,
        retryDelay:  1000,
        timeout:     30000,
        crossOrigin: "anonymous",
    };

    static TYPE_MAP = {
        png: "image", jpg: "image", jpeg: "image", gif: "image",
        webp: "image", avif: "image", svg: "image", ico: "image", bmp: "image",
        mp3: "audio", ogg: "audio", wav: "audio", aac: "audio",
        flac: "audio", m4a: "audio", opus: "audio",
        mp4: "video", webm: "video", ogv: "video", mov: "video",
        woff: "font", woff2: "font", ttf: "font", otf: "font", eot: "font",
        json: "json",
        js: "script", mjs: "script",
        css: "css",
    };


    // ═══════════════════════════════════════════
    //  Constructor
    // ═══════════════════════════════════════════

    constructor(options = {}) {
        const d = AssetLoader.DEFAULTS;

        this._concurrency  = options.concurrency ?? d.concurrency;
        this._maxRetries   = options.retries     ?? d.retries;
        this._retryDelay   = options.retryDelay  ?? d.retryDelay;
        this._timeout      = options.timeout     ?? d.timeout;
        this._crossOrigin  = options.crossOrigin || d.crossOrigin;

        this._queue     = [];
        this._results   = new Map();
        this._errors    = new Map();

        this._completed = 0;
        this._active    = 0;
        this._started   = false;
        this._finished  = false;
        this._aborted   = false;

        this._listeners = { progress: [], complete: [], error: [], asset: [] };
        this._abortController = null;
        this._promiseResolve = null;
        this._promiseReject  = null;
    }


    // ═══════════════════════════════════════════
    //  Queue Methods
    // ═══════════════════════════════════════════

    add(url, type, meta = {}) {
        if (this._started) {
            console.warn("AssetLoader: cannot add() after start(). Asset ignored:", url);
            return this;
        }

        if (!type) type = this._detectType(url);

        this._queue.push({
            url, type, meta,
            _retries: 0, _processing: false, _done: false,
        });

        return this;
    }

    addBatch(items) {
        for (const item of items) {
            if (typeof item === "string") {
                this.add(item);
            } else {
                this.add(item.url, item.type, item.meta || {});
            }
        }
        return this;
    }

    addImage(url, meta = {}) { return this.add(url, "image", meta); }
    addAudio(url, meta = {}) { return this.add(url, "audio", meta); }
    addVideo(url, meta = {}) { return this.add(url, "video", meta); }
    addJSON(url, meta = {})  { return this.add(url, "json", meta); }
    addScript(url, meta = {}) { return this.add(url, "script", meta); }
    addCSS(url, meta = {})   { return this.add(url, "css", meta); }
    addBlob(url, meta = {})  { return this.add(url, "blob", meta); }

    addFont(url, family, descriptors = {}) {
        return this.add(url, "font", { family, descriptors });
    }


    // ═══════════════════════════════════════════
    //  Control
    // ═══════════════════════════════════════════

    start() {
        if (this._started) {
            console.warn("AssetLoader: start() already called.");
            return Promise.resolve(this._results);
        }
        this._started = true;
        this._aborted = false;
        this._abortController = new AbortController();

        if (this._queue.length === 0) {
            this._finish();
            return Promise.resolve(this._results);
        }

        const promise = new Promise((resolve, reject) => {
            this._promiseResolve = resolve;
            this._promiseReject  = reject;
        });

        this._processQueue();
        return promise;
    }

    destroy() {
        this._aborted  = true;
        this._finished = true;

        if (this._abortController) {
            this._abortController.abort();
            this._abortController = null;
        }

        for (const key of Object.keys(this._listeners)) {
            this._listeners[key].length = 0;
        }

        if (this._promiseReject) {
            this._promiseReject(new Error("AssetLoader destroyed"));
            this._promiseResolve = null;
            this._promiseReject  = null;
        }
    }

    reset() {
        if (this._started && !this._finished) this.destroy();

        this._results.clear();
        this._errors.clear();
        this._completed = 0;
        this._active    = 0;
        this._started   = false;
        this._finished  = false;
        this._aborted   = false;

        for (const key of Object.keys(this._listeners)) {
            if (!this._listeners[key]) this._listeners[key] = [];
        }

        for (const entry of this._queue) {
            entry._retries = 0;
            entry._processing = false;
            entry._done = false;
        }

        this._promiseResolve = null;
        this._promiseReject  = null;
        this._abortController = null;

        return this;
    }


    // ═══════════════════════════════════════════
    //  EventEmitter Interface
    // ═══════════════════════════════════════════

    on(event, callback) {
        if (this._listeners[event]) this._listeners[event].push(callback);
        return this;
    }

    off(event, callback) {
        if (this._listeners[event]) {
            this._listeners[event] = this._listeners[event].filter(fn => fn !== callback);
        }
        return this;
    }

    once(event, callback) {
        const wrapper = (...args) => {
            this.off(event, wrapper);
            callback(...args);
        };
        return this.on(event, wrapper);
    }


    // ═══════════════════════════════════════════
    //  Accessors
    // ═══════════════════════════════════════════

    get loaded()    { return this._results.size; }
    get total()     { return this._queue.length; }
    get failed()    { return this._errors.size; }
    get completed() { return this._completed; }
    get started()   { return this._started; }
    get finished()  { return this._finished; }

    get progress() {
        return this._queue.length === 0 ? 1 : this._completed / this._queue.length;
    }

    get(url)      { return this._results.get(url) ?? null; }
    getAll()      { return new Map(this._results); }
    getErrors()   { return new Map(this._errors); }

    getManifest() {
        return this._queue.map(e => ({
            url: e.url, type: e.type, meta: { ...e.meta },
        }));
    }


    // ═══════════════════════════════════════════
    //  Queue Processor
    // ═══════════════════════════════════════════

    /** @private */
    _processQueue() {
        if (this._aborted) return;

        while (
            this._active < this._concurrency &&
            this._queue.some(e => !e._processing && !e._done)
        ) {
            const entry = this._queue.find(e => !e._processing && !e._done);
            if (!entry) break;

            entry._processing = true;
            this._active++;
            this._loadEntry(entry);
        }
    }

    /** @private */
    async _loadEntry(entry) {
        if (this._aborted) return;

        try {
            const result = await this._loadByType(entry);
            if (this._aborted) return;

            this._results.set(entry.url, result);
            entry._done = true;
            entry._processing = false;
            this._active--;
            this._completed++;

            this._emit("asset", entry.url, result, entry);
            this._emit("progress", this._completed, this._queue.length);
            this._checkCompletion();

        } catch (err) {
            if (this._aborted) return;

            entry._retries++;

            if (entry._retries <= this._maxRetries) {
                entry._processing = false;
                this._active--;

                const delay = this._retryDelay * Math.pow(2, entry._retries - 1);
                await this._sleep(delay);
                if (this._aborted) return;

                entry._processing = true;
                this._active++;
                return this._loadEntry(entry);

            } else {
                const error = new Error(
                    `Failed to load ${entry.type}: ${entry.url} (${err.message})`
                );
                this._errors.set(entry.url, error);
                entry._done = true;
                entry._processing = false;
                this._active--;
                this._completed++;

                this._emit("error", error, entry);
                this._emit("progress", this._completed, this._queue.length);
                this._checkCompletion();
            }
        }
    }

    /** @private */
    _checkCompletion() {
        if (this._completed >= this._queue.length) {
            this._finish();
        } else {
            this._processQueue();
        }
    }


    // ═══════════════════════════════════════════
    //  Type-Specific Loaders
    // ═══════════════════════════════════════════

    /** @private */
    _loadByType(entry) {
        switch (entry.type) {
            case "image":  return this._loadImage(entry);
            case "audio":  return this._loadAudio(entry);
            case "video":  return this._loadVideo(entry);
            case "font":   return this._loadFont(entry);
            case "json":   return this._loadJSON(entry);
            case "script": return this._loadScript(entry);
            case "css":    return this._loadCSS(entry);
            case "blob":   return this._loadBlob(entry);
            default:       return this._loadFetch(entry);
        }
    }

    /**
     * Image loader using img.decode() for off-thread decoding.
     *
     * Setting src then calling decode() directly bypasses the onload event
     * entirely — the browser decodes off-thread and resolves when the image
     * is paint-ready. This avoids the 30-50ms synchronous decode stall that
     * happens when onload fires while the image is still compressed in memory.
     *
     * Falls back to onload/onerror for browsers without decode() support.
     * decode() failure still resolves (the image may be usable for progressive JPEGs).
     * @private
     */
    _loadImage(entry) {
        return this._withTimeout(new Promise((resolve, reject) => {
            const img = new Image();
            if (this._crossOrigin) img.crossOrigin = this._crossOrigin;

            img.src = entry.url;

            if ("decode" in img) {
                img.decode()
                    .then(() => resolve(img))
                    .catch(() => {
                        // decode() failed but image may still be usable
                        // (e.g. broken progressive JPEG). Check natural dimensions.
                        if (img.naturalWidth > 0) {
                            resolve(img);
                        } else {
                            reject(new Error("Image decode failed"));
                        }
                    });
            } else {
                img.onload  = () => resolve(img);
                img.onerror = () => reject(new Error("Image load failed"));
            }
        }));
    }

    /** @private */
    _loadAudio(entry) {
        return this._withTimeout(new Promise((resolve, reject) => {
            const audio = new Audio();
            if (this._crossOrigin) audio.crossOrigin = this._crossOrigin;
            audio.preload = "auto";

            const onReady = () => { cleanup(); resolve(audio); };
            const onError = () => { cleanup(); reject(new Error("Audio load failed")); };
            const cleanup = () => {
                audio.removeEventListener("canplaythrough", onReady);
                audio.removeEventListener("error", onError);
            };

            audio.addEventListener("canplaythrough", onReady, { once: true });
            audio.addEventListener("error", onError, { once: true });
            audio.src = entry.url;
            audio.load();
        }));
    }

    /** @private */
    _loadVideo(entry) {
        return this._withTimeout(new Promise((resolve, reject) => {
            const video = document.createElement("video");
            if (this._crossOrigin) video.crossOrigin = this._crossOrigin;
            video.preload = "auto";
            video.muted = true;

            const onReady = () => { cleanup(); resolve(video); };
            const onError = () => { cleanup(); reject(new Error("Video load failed")); };
            const cleanup = () => {
                video.removeEventListener("canplaythrough", onReady);
                video.removeEventListener("error", onError);
            };

            video.addEventListener("canplaythrough", onReady, { once: true });
            video.addEventListener("error", onError, { once: true });
            video.src = entry.url;
            video.load();
        }));
    }

    /** @private */
    _loadFont(entry) {
        const family = entry.meta?.family;
        if (!family) {
            return Promise.reject(
                new Error("Font requires meta.family — use addFont(url, family)")
            );
        }

        const descriptors = entry.meta.descriptors || {};

        return this._withTimeout(new Promise((resolve, reject) => {
            if (typeof FontFace !== "undefined") {
                const face = new FontFace(family, `url(${entry.url})`, descriptors);
                face.load()
                    .then(loaded => {
                        document.fonts.add(loaded);
                        resolve(loaded);
                    })
                    .catch(() => reject(new Error("FontFace load failed")));
            } else {
                const link = document.createElement("link");
                link.rel = "preload";
                link.as = "font";
                link.type = this._fontMimeType(entry.url);
                link.crossOrigin = this._crossOrigin;
                link.href = entry.url;
                document.head.appendChild(link);

                document.fonts.load(`1em "${family}"`)
                    .then(fonts => resolve(fonts))
                    .catch(() => reject(new Error("document.fonts.load failed")));
            }
        }));
    }

    /** @private */
    _loadJSON(entry) {
        return this._withTimeout(
            fetch(entry.url, { signal: this._abortController?.signal })
                .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
        );
    }

    /** @private */
    _loadScript(entry) {
        return this._withTimeout(new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.type = "text/javascript";
            script.async = true;
            script.onload  = () => resolve(script);
            script.onerror = () => reject(new Error("Script load failed"));
            script.src = entry.url;
            document.head.appendChild(script);
        }));
    }

    /** @private */
    _loadCSS(entry) {
        return this._withTimeout(new Promise((resolve, reject) => {
            const link = document.createElement("link");
            link.rel = "stylesheet";
            link.type = "text/css";
            link.onload  = () => resolve(link);
            link.onerror = () => reject(new Error("CSS load failed"));
            link.href = entry.url;
            document.head.appendChild(link);
        }));
    }

    /** @private */
    _loadBlob(entry) {
        return this._withTimeout(
            fetch(entry.url, { signal: this._abortController?.signal })
                .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.blob(); })
        );
    }

    /** @private */
    _loadFetch(entry) {
        return this._withTimeout(
            fetch(entry.url, { signal: this._abortController?.signal })
                .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.text(); })
        );
    }


    // ═══════════════════════════════════════════
    //  Helpers
    // ═══════════════════════════════════════════

    /** @private */
    _emit(event, ...args) {
        const list = this._listeners[event];
        if (!list) return;
        for (const cb of list) {
            try { cb(...args); }
            catch (e) { console.error(`AssetLoader [${event}] listener error:`, e); }
        }
    }

    /** @private */
    _finish() {
        if (this._finished) return;
        this._finished = true;
        this._emit("complete");

        if (this._promiseResolve) {
            this._promiseResolve(this._results);
            this._promiseResolve = null;
            this._promiseReject  = null;
        }
    }

    /** @private Wraps a promise with a per-asset timeout. Timer is cleared on settle. */
    _withTimeout(promise) {
        if (!this._timeout || this._timeout <= 0) return promise;

        let timer;
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(
                () => reject(new Error(`Timeout after ${this._timeout}ms`)),
                this._timeout
            );
        });

        return Promise.race([promise, timeoutPromise]).finally(() => {
            clearTimeout(timer);
        });
    }

    /**
     * Abort-aware sleep for retry backoff.
     * Resolves after ms, but if the AbortController fires first,
     * the timer is cleared immediately (no leaked timer after destroy).
     * @private
     */
    _sleep(ms) {
        return new Promise(resolve => {
            const timer = setTimeout(resolve, ms);

            // If abort fires during sleep, clear the timer and resolve immediately.
            // The caller checks _aborted after await _sleep().
            this._abortController?.signal.addEventListener('abort', () => {
                clearTimeout(timer);
                resolve();
            }, { once: true });
        });
    }

    /** @private Auto-detect asset type from URL file extension */
    _detectType(url) {
        try {
            const clean = url.split("?")[0].split("#")[0];
            const ext = clean.split(".").pop().toLowerCase();
            return AssetLoader.TYPE_MAP[ext] || "fetch";
        } catch {
            return "fetch";
        }
    }

    /** @private Map font file extension to MIME type */
    _fontMimeType(url) {
        const ext = url.split("?")[0].split(".").pop().toLowerCase();
        return {
            woff2: "font/woff2", woff: "font/woff",
            ttf: "font/ttf", otf: "font/otf",
            eot: "application/vnd.ms-fontobject",
        }[ext] || "font/woff2";
    }
}

export default AssetLoader;
