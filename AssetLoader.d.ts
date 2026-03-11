/**
 * lite-asset-loader — Production Asset Loading Manager
 */

export interface AssetLoaderOptions {
    /** Max simultaneous loads. Default: 4 */
    concurrency?: number;
    /** Retry attempts per failed asset. Default: 2 */
    retries?: number;
    /** Base delay between retries in ms (doubled each retry). Default: 1000 */
    retryDelay?: number;
    /** Per-asset timeout in ms (0 = disabled). Default: 30000 */
    timeout?: number;
    /** crossOrigin attribute for images/audio/video. Default: "anonymous" */
    crossOrigin?: string;
}

export interface AssetEntry {
    url: string;
    type: string;
    meta: Record<string, any>;
}

export interface FontDescriptors {
    weight?: string;
    style?: string;
    display?: string;
    [key: string]: any;
}

export type AssetEvent = "progress" | "complete" | "error" | "asset";

export class AssetLoader {
    static DEFAULTS: Required<AssetLoaderOptions>;
    static TYPE_MAP: Record<string, string>;

    constructor(options?: AssetLoaderOptions);

    // ── Queue Methods ──

    /** Add a single asset. Type auto-detected from extension if omitted. Chainable. */
    add(url: string, type?: string, meta?: Record<string, any>): this;

    /** Add multiple assets (strings or {url, type?, meta?} objects). Chainable. */
    addBatch(items: Array<string | { url: string; type?: string; meta?: Record<string, any> }>): this;

    addImage(url: string, meta?: Record<string, any>): this;
    addAudio(url: string, meta?: Record<string, any>): this;
    addVideo(url: string, meta?: Record<string, any>): this;
    addJSON(url: string, meta?: Record<string, any>): this;
    addScript(url: string, meta?: Record<string, any>): this;
    addCSS(url: string, meta?: Record<string, any>): this;
    addBlob(url: string, meta?: Record<string, any>): this;
    addFont(url: string, family: string, descriptors?: FontDescriptors): this;

    // ── Control ──

    /** Start loading. Returns Promise that resolves with Map<url, result>. */
    start(): Promise<Map<string, any>>;

    /** Abort all loading, cancel fetches, clear listeners. */
    destroy(): void;

    /** Reset for replay. Clears results/errors, keeps queue. Call start() again. */
    reset(): this;

    // ── EventEmitter ──

    on(event: "progress", callback: (loaded: number, total: number) => void): this;
    on(event: "complete", callback: () => void): this;
    on(event: "error", callback: (error: Error, entry: AssetEntry) => void): this;
    on(event: "asset", callback: (url: string, result: any, entry: AssetEntry) => void): this;

    off(event: AssetEvent, callback: Function): this;
    once(event: AssetEvent, callback: Function): this;

    // ── Accessors ──

    /** Number of successfully loaded assets. */
    readonly loaded: number;
    /** Total number of queued assets. */
    readonly total: number;
    /** Number of failed assets (after all retries). */
    readonly failed: number;
    /** Number of completed assets (success + final failure). */
    readonly completed: number;
    /** Progress ratio 0–1. */
    readonly progress: number;
    /** Whether start() was called. */
    readonly started: boolean;
    /** Whether all assets are processed. */
    readonly finished: boolean;

    /** Get a loaded result by URL. Returns null if not found. */
    get(url: string): any | null;
    /** Get all results as Map<url, result>. */
    getAll(): Map<string, any>;
    /** Get all errors as Map<url, Error>. */
    getErrors(): Map<string, Error>;
    /** Get a readonly copy of the queue manifest. */
    getManifest(): AssetEntry[];
}

export default AssetLoader;
