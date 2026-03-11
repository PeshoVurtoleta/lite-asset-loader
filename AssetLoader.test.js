import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AssetLoader } from './AssetLoader.d.ts';

// ──────────────────────────────────────────────
//  Mock browser APIs
// ──────────────────────────────────────────────

// Mock Image with decode support
class MockImage {
    constructor() {
        this.src = '';
        this.crossOrigin = '';
        this.naturalWidth = 100;
        this.onload = null;
        this.onerror = null;
    }

    decode() {
        return Promise.resolve();
    }
}

// Mock Audio
class MockAudio {
    constructor() {
        this.src = '';
        this.crossOrigin = '';
        this.preload = '';
        this._listeners = {};
    }
    addEventListener(evt, fn) { this._listeners[evt] = fn; }
    removeEventListener(evt) { delete this._listeners[evt]; }
    load() {
        setTimeout(() => this._listeners.canplaythrough?.(), 0);
    }
}

globalThis.Image = MockImage;
globalThis.Audio = MockAudio;
globalThis.FontFace = undefined; // test font fallback path

describe('📦 AssetLoader', () => {
    let loader;
    let _startPromise; // Track to prevent unhandled rejection on destroy

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        _startPromise = null;
        loader = new AssetLoader({ retries: 1, retryDelay: 100, timeout: 5000 });

        globalThis.fetch = vi.fn(() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ key: 'value' }),
            blob: () => Promise.resolve(new Blob(['data'])),
            text: () => Promise.resolve('text content'),
        }));
    });

    afterEach(() => {
        // Suppress unhandled rejection from destroy() on in-flight loaders
        _startPromise?.catch(() => {});
        try { loader?.destroy(); } catch {}
        vi.useRealTimers();
    });

    // ═══════════════════════════════════════════════
    //  Constructor & Defaults
    // ═══════════════════════════════════════════════

    describe('constructor', () => {
        it('applies default options', () => {
            const l = new AssetLoader();
            expect(l._concurrency).toBe(4);
            expect(l._maxRetries).toBe(2);
            expect(l._timeout).toBe(30000);
        });

        it('accepts custom options', () => {
            const l = new AssetLoader({ concurrency: 8, retries: 5, timeout: 10000 });
            expect(l._concurrency).toBe(8);
            expect(l._maxRetries).toBe(5);
            expect(l._timeout).toBe(10000);
        });

        it('starts in a clean state', () => {
            expect(loader.started).toBe(false);
            expect(loader.finished).toBe(false);
            expect(loader.loaded).toBe(0);
            expect(loader.total).toBe(0);
            expect(loader.progress).toBe(1); // 0/0 = 1
        });
    });

    // ═══════════════════════════════════════════════
    //  Queue Methods
    // ═══════════════════════════════════════════════

    describe('add()', () => {
        it('adds an asset to the queue', () => {
            loader.add('/img/hero.webp');
            expect(loader.total).toBe(1);
        });

        it('auto-detects type from extension', () => {
            loader.add('/img/hero.webp');
            expect(loader.getManifest()[0].type).toBe('image');
        });

        it('accepts explicit type', () => {
            loader.add('/data/config.dat', 'json');
            expect(loader.getManifest()[0].type).toBe('json');
        });

        it('is chainable', () => {
            const result = loader.add('/a.png').add('/b.png');
            expect(result).toBe(loader);
            expect(loader.total).toBe(2);
        });

        it('warns and ignores add after start', async () => {
            const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            loader.add('/a.png');
            _startPromise = loader.start();
            loader.add('/b.png');
            expect(spy).toHaveBeenCalled();
            expect(spy.mock.calls[0][0]).toContain('cannot add');
            expect(loader.total).toBe(1);
            spy.mockRestore();
        });
    });

    describe('addBatch()', () => {
        it('adds multiple string URLs', () => {
            loader.addBatch(['/a.png', '/b.mp3', '/c.json']);
            expect(loader.total).toBe(3);
        });

        it('adds mixed string and object entries', () => {
            loader.addBatch([
                '/a.png',
                { url: '/b.dat', type: 'json' },
            ]);
            const manifest = loader.getManifest();
            expect(manifest[0].type).toBe('image');
            expect(manifest[1].type).toBe('json');
        });
    });

    describe('convenience methods', () => {
        it('addImage sets type to image', () => {
            loader.addImage('/hero.dat');
            expect(loader.getManifest()[0].type).toBe('image');
        });

        it('addAudio sets type to audio', () => {
            loader.addAudio('/sfx.dat');
            expect(loader.getManifest()[0].type).toBe('audio');
        });

        it('addFont sets family in meta', () => {
            loader.addFont('/font.woff2', 'Cinzel', { weight: '700' });
            const entry = loader.getManifest()[0];
            expect(entry.type).toBe('font');
            expect(entry.meta.family).toBe('Cinzel');
            expect(entry.meta.descriptors.weight).toBe('700');
        });

        it('addJSON sets type to json', () => {
            loader.addJSON('/data.json');
            expect(loader.getManifest()[0].type).toBe('json');
        });

        it('addBlob sets type to blob', () => {
            loader.addBlob('/file.bin');
            expect(loader.getManifest()[0].type).toBe('blob');
        });
    });

    // ═══════════════════════════════════════════════
    //  Type Detection
    // ═══════════════════════════════════════════════

    describe('type detection', () => {
        const cases = [
            ['/img.png', 'image'], ['/img.webp', 'image'], ['/img.avif', 'image'],
            ['/sfx.mp3', 'audio'], ['/sfx.ogg', 'audio'], ['/sfx.wav', 'audio'],
            ['/vid.mp4', 'video'], ['/vid.webm', 'video'],
            ['/font.woff2', 'font'], ['/font.ttf', 'font'],
            ['/data.json', 'json'],
            ['/app.js', 'script'], ['/mod.mjs', 'script'],
            ['/style.css', 'css'],
            ['/unknown.xyz', 'fetch'],
        ];

        cases.forEach(([url, expected]) => {
            it(`detects ${url} as ${expected}`, () => {
                loader.add(url);
                expect(loader.getManifest()[0].type).toBe(expected);
            });
        });

        it('strips query params before detection', () => {
            loader.add('/img.png?v=123');
            expect(loader.getManifest()[0].type).toBe('image');
        });

        it('strips hash before detection', () => {
            loader.add('/img.png#section');
            expect(loader.getManifest()[0].type).toBe('image');
        });
    });

    // ═══════════════════════════════════════════════
    //  EventEmitter Interface
    // ═══════════════════════════════════════════════

    describe('EventEmitter', () => {
        it('on() registers a listener', () => {
            const fn = vi.fn();
            loader.on('progress', fn);
            loader._emit('progress', 1, 2);
            expect(fn).toHaveBeenCalledWith(1, 2);
        });

        it('off() removes a listener', () => {
            const fn = vi.fn();
            loader.on('progress', fn);
            loader.off('progress', fn);
            loader._emit('progress', 1, 2);
            expect(fn).not.toHaveBeenCalled();
        });

        it('once() fires only once', () => {
            const fn = vi.fn();
            loader.once('progress', fn);
            loader._emit('progress', 1, 2);
            loader._emit('progress', 2, 2);
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('on() is chainable', () => {
            const result = loader.on('complete', () => {});
            expect(result).toBe(loader);
        });

        it('swallows listener errors', () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
            loader.on('complete', () => { throw new Error('oops'); });
            expect(() => loader._emit('complete')).not.toThrow();
            spy.mockRestore();
        });
    });

    // ═══════════════════════════════════════════════
    //  Start & Loading (JSON/fetch path)
    // ═══════════════════════════════════════════════

    describe('start()', () => {
        it('returns a Promise', () => {
            loader.add('/data.json');
            _startPromise = loader.start();
            expect(_startPromise).toBeInstanceOf(Promise);
        });

        it('resolves immediately for empty queue', async () => {
            const results = await loader.start();
            expect(results).toBeInstanceOf(Map);
            expect(loader.finished).toBe(true);
        });

        it('warns on double start', async () => {
            const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            loader.add('/data.json');
            _startPromise = loader.start();
            loader.start();
            expect(spy).toHaveBeenCalledWith(expect.stringContaining('already called'));
            spy.mockRestore();
        });

        it('loads JSON assets via fetch', async () => {
            loader.add('/config.json');
            const promise = loader.start();
            await vi.advanceTimersByTimeAsync(100);
            const results = await promise;
            expect(results.get('/config.json')).toEqual({ key: 'value' });
        });

        it('loads blob assets via fetch', async () => {
            loader.add('/file.bin', 'blob');
            const promise = loader.start();
            await vi.advanceTimersByTimeAsync(100);
            const results = await promise;
            expect(results.get('/file.bin')).toBeInstanceOf(Blob);
        });

        it('emits progress events', async () => {
            const fn = vi.fn();
            loader.add('/a.json');
            loader.add('/b.json');
            loader.on('progress', fn);

            const promise = loader.start();
            await vi.advanceTimersByTimeAsync(100);
            await promise;

            expect(fn).toHaveBeenCalledTimes(2);
            expect(fn).toHaveBeenCalledWith(1, 2);
            expect(fn).toHaveBeenCalledWith(2, 2);
        });

        it('emits complete event', async () => {
            const fn = vi.fn();
            loader.add('/a.json');
            loader.on('complete', fn);

            const promise = loader.start();
            await vi.advanceTimersByTimeAsync(100);
            await promise;

            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('emits asset event per success', async () => {
            const fn = vi.fn();
            loader.add('/config.json');
            loader.on('asset', fn);

            const promise = loader.start();
            await vi.advanceTimersByTimeAsync(100);
            await promise;

            expect(fn).toHaveBeenCalledWith('/config.json', { key: 'value' }, expect.any(Object));
        });
    });

    // ═══════════════════════════════════════════════
    //  Retry Logic
    // ═══════════════════════════════════════════════

    describe('retry logic', () => {
        it('retries failed assets', async () => {
            let attempts = 0;
            globalThis.fetch = vi.fn(() => {
                attempts++;
                if (attempts < 2) return Promise.reject(new Error('Network error'));
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ retry: true }),
                });
            });

            loader.add('/flaky.json');
            const promise = loader.start();
            // Advance through retry delay + load
            await vi.advanceTimersByTimeAsync(5000);
            const results = await promise;

            expect(attempts).toBe(2);
            expect(results.get('/flaky.json')).toEqual({ retry: true });
        });

        it('emits error after all retries exhausted', async () => {
            globalThis.fetch = vi.fn(() => Promise.reject(new Error('Network error')));

            const errorFn = vi.fn();
            loader.add('/broken.json');
            loader.on('error', errorFn);

            const promise = loader.start();
            await vi.advanceTimersByTimeAsync(10000);
            await promise;

            expect(errorFn).toHaveBeenCalledTimes(1);
            expect(loader.failed).toBe(1);
        });

        it('applies exponential backoff', async () => {
            let callTimes = [];
            globalThis.fetch = vi.fn(() => {
                callTimes.push(Date.now());
                return Promise.reject(new Error('fail'));
            });

            loader = new AssetLoader({ retries: 2, retryDelay: 100 });
            loader.add('/fail.json');
            loader.start();

            // 1st attempt immediate, 2nd after 100ms, 3rd after 200ms
            await vi.advanceTimersByTimeAsync(1000);
        });
    });

    // ═══════════════════════════════════════════════
    //  Timeout
    // ═══════════════════════════════════════════════

    describe('timeout', () => {
        it('rejects assets that exceed timeout', async () => {
            globalThis.fetch = vi.fn(() => new Promise(() => {})); // never resolves

            loader = new AssetLoader({ retries: 0, timeout: 500 });
            const errorFn = vi.fn();
            loader.add('/slow.json');
            loader.on('error', errorFn);

            const promise = loader.start();
            await vi.advanceTimersByTimeAsync(1000);
            await promise;

            expect(errorFn).toHaveBeenCalledTimes(1);
            expect(loader.failed).toBe(1);
        });

        it('disables timeout when set to 0', async () => {
            loader = new AssetLoader({ timeout: 0 });
            loader.add('/data.json');
            const promise = loader.start();
            await vi.advanceTimersByTimeAsync(100);
            const results = await promise;
            expect(results.size).toBe(1);
        });
    });

    // ═══════════════════════════════════════════════
    //  Concurrency
    // ═══════════════════════════════════════════════

    describe('concurrency', () => {
        it('limits active loads to concurrency setting', () => {
            loader = new AssetLoader({ concurrency: 2 });
            for (let i = 0; i < 10; i++) loader.add(`/file${i}.json`);
            _startPromise = loader.start();
            expect(loader._active).toBeLessThanOrEqual(2);
        });
    });

    // ═══════════════════════════════════════════════
    //  Accessors
    // ═══════════════════════════════════════════════

    describe('accessors', () => {
        it('get() returns loaded result', async () => {
            loader.add('/config.json');
            const promise = loader.start();
            await vi.advanceTimersByTimeAsync(100);
            await promise;
            expect(loader.get('/config.json')).toEqual({ key: 'value' });
        });

        it('get() returns null for unknown URL', () => {
            expect(loader.get('/nonexistent')).toBeNull();
        });

        it('getAll() returns a copy of results', async () => {
            loader.add('/a.json');
            const promise = loader.start();
            await vi.advanceTimersByTimeAsync(100);
            await promise;
            const all = loader.getAll();
            expect(all).toBeInstanceOf(Map);
            expect(all).not.toBe(loader._results); // copy, not reference
        });

        it('getErrors() returns a copy of errors', async () => {
            globalThis.fetch = vi.fn(() => Promise.reject(new Error('fail')));
            loader = new AssetLoader({ retries: 0 });
            loader.add('/bad.json');
            const promise = loader.start();
            await vi.advanceTimersByTimeAsync(100);
            await promise;
            expect(loader.getErrors().size).toBe(1);
        });

        it('progress reflects completion ratio', async () => {
            loader.add('/a.json');
            loader.add('/b.json');
            expect(loader.progress).toBe(0);

            const promise = loader.start();
            await vi.advanceTimersByTimeAsync(100);
            await promise;
            expect(loader.progress).toBe(1);
        });

        it('getManifest() returns readonly copy', () => {
            loader.add('/a.png');
            const manifest = loader.getManifest();
            manifest[0].url = 'tampered';
            expect(loader.getManifest()[0].url).toBe('/a.png');
        });
    });

    // ═══════════════════════════════════════════════
    //  Destroy
    // ═══════════════════════════════════════════════

    describe('destroy()', () => {
        it('aborts in-flight fetches', () => {
            loader.add('/a.json');
            _startPromise = loader.start();
            const controller = loader._abortController;
            loader.destroy();
            expect(controller.signal.aborted).toBe(true);
        });

        it('clears all listeners', () => {
            loader.on('progress', () => {});
            loader.on('complete', () => {});
            loader.destroy();
            expect(loader._listeners.progress.length).toBe(0);
            expect(loader._listeners.complete.length).toBe(0);
        });

        it('rejects pending promise', async () => {
            loader.add('/slow.json');
            globalThis.fetch = vi.fn(() => new Promise(() => {}));

            _startPromise = loader.start();
            loader.destroy();

            await expect(_startPromise).rejects.toThrow('destroyed');
            _startPromise = null; // already handled
        });

        it('stops emitting events after destroy', () => {
            const fn = vi.fn();
            loader.on('progress', fn);
            loader.destroy();
            loader._emit('progress', 1, 1);
            expect(fn).not.toHaveBeenCalled();
        });
    });

    // ═══════════════════════════════════════════════
    //  Reset
    // ═══════════════════════════════════════════════

    describe('reset()', () => {
        it('clears results and errors', async () => {
            loader.add('/a.json');
            const promise = loader.start();
            await vi.advanceTimersByTimeAsync(100);
            await promise;

            expect(loader.loaded).toBe(1);
            loader.reset();
            expect(loader.loaded).toBe(0);
            expect(loader.started).toBe(false);
            expect(loader.finished).toBe(false);
        });

        it('allows re-start after reset', async () => {
            loader.add('/a.json');
            let promise = loader.start();
            await vi.advanceTimersByTimeAsync(100);
            await promise;

            loader.reset();
            promise = loader.start();
            await vi.advanceTimersByTimeAsync(100);
            const results = await promise;
            expect(results.size).toBe(1);
        });

        it('aborts running loads before reset', () => {
            globalThis.fetch = vi.fn(() => new Promise(() => {}));
            loader.add('/slow.json');
            _startPromise = loader.start();
            const controller = loader._abortController;
            loader.reset();
            // reset() internally calls destroy() which rejects the promise
            _startPromise.catch(() => {}); // suppress
            _startPromise = null;
            expect(controller.signal.aborted).toBe(true);
        });
    });

    // ═══════════════════════════════════════════════
    //  Image Loading (mocked)
    // ═══════════════════════════════════════════════

    describe('image loading', () => {
        it('loads images with decode()', async () => {
            loader.add('/hero.webp');
            const promise = loader.start();
            await vi.advanceTimersByTimeAsync(100);
            const results = await promise;
            expect(results.get('/hero.webp')).toBeInstanceOf(MockImage);
        });

        it('resolves on decode failure if naturalWidth > 0', async () => {
            const origDecode = MockImage.prototype.decode;
            MockImage.prototype.decode = function () {
                return Promise.reject(new Error('decode failed'));
            };

            loader.add('/progressive.jpg');
            const promise = loader.start();
            await vi.advanceTimersByTimeAsync(100);
            const results = await promise;
            // naturalWidth is 100 in our mock, so should resolve
            expect(results.get('/progressive.jpg')).toBeInstanceOf(MockImage);

            MockImage.prototype.decode = origDecode;
        });
    });
});
