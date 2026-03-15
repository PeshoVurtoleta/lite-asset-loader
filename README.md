# lite-asset-loader

[![npm version](https://img.shields.io/npm/v/lite-asset-loader.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/lite-asset-loader)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/lite-asset-loader?style=for-the-badge)](https://bundlephobia.com/result?p=lite-asset-loader)
[![npm downloads](https://img.shields.io/npm/dm/lite-asset-loader?style=for-the-badge&color=blue)](https://www.npmjs.com/package/lite-asset-loader)
[![npm total downloads](https://img.shields.io/npm/dt/lite-asset-loader?style=for-the-badge&color=blue)](https://www.npmjs.com/package/lite-asset-loader)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

A production-grade asset loading manager with concurrency control, retry logic with exponential backoff, per-asset timeouts, and granular progress tracking.

Loads images, audio, video, fonts, JSON, scripts, CSS, blobs, and generic fetches — all through a single, chainable API with both Promise and EventEmitter interfaces.

## Features

- **9 asset types** — images, audio, video, fonts, JSON, scripts, CSS, blobs, generic fetch
- **Concurrency control** — configurable simultaneous load limit (default: 4)
- **Retry with exponential backoff** — automatic retries with doubling delay
- **Per-asset timeout** — configurable timeout prevents stuck loads
- **`img.decode()` off-thread** — images are paint-ready when resolved (no first-paint stall)
- **FontFace API** — fonts are registered and usable immediately
- **AbortController** — `destroy()` cancels all in-flight fetches instantly
- **Dual interface** — works as both a Promise and an EventEmitter
- **Chainable API** — `add().add().addFont().start()`
- **Progress tracking** — loaded, total, failed, progress ratio, per-asset events
- **Asset retrieval** — `get(url)` returns the loaded object (Image, Audio, JSON, etc.)
- **Zero dependencies**

## Installation

```bash
npm install lite-asset-loader
```

## Quick Start

```javascript
import { AssetLoader } from 'lite-asset-loader';

const assets = new AssetLoader();

const results = await assets
    .addImage('/img/hero.webp')
    .addImage('/img/bg.jpg')
    .addAudio('/sfx/click.mp3')
    .addJSON('/data/config.json')
    .addFont('/fonts/cinzel.woff2', 'Cinzel')
    .start();

const heroImg = assets.get('/img/hero.webp');  // HTMLImageElement
const config  = assets.get('/data/config.json'); // parsed object
```

## Usage with Progress Tracking

```javascript
const assets = new AssetLoader({ concurrency: 6, retries: 3 });

assets.add('/img/a.webp');
assets.add('/img/b.webp');
assets.addFont('/fonts/cinzel.woff2', 'Cinzel');

assets.on('progress', (loaded, total) => {
    progressBar.style.width = `${(loaded / total) * 100}%`;
});

assets.on('error', (err, entry) => {
    console.warn(`Failed: ${entry.url}`, err.message);
});

assets.on('complete', () => {
    startGame();
});

assets.start();
```

## Options

```javascript
const assets = new AssetLoader({
    concurrency: 4,       // Max simultaneous loads (default: 4)
    retries: 2,           // Retry attempts per failed asset (default: 2)
    retryDelay: 1000,     // Base delay between retries in ms, doubles each retry (default: 1000)
    timeout: 30000,       // Per-asset timeout in ms, 0 to disable (default: 30000)
    crossOrigin: 'anonymous', // crossOrigin attribute for images/audio/video
});
```

## API

### Queue Methods

All queue methods are chainable and return `this`.

| Method | Description |
|--------|-------------|
| `.add(url, type?, meta?)` | Add an asset. Type auto-detected from extension. |
| `.addBatch(items)` | Add multiple assets (strings or objects). |
| `.addImage(url)` | Add an image. |
| `.addAudio(url)` | Add audio (HTMLAudioElement). |
| `.addVideo(url)` | Add video. |
| `.addFont(url, family, descriptors?)` | Add a font (registered via FontFace API). |
| `.addJSON(url)` | Add JSON (parsed automatically). |
| `.addScript(url)` | Add a script (injected into `<head>`). |
| `.addCSS(url)` | Add a stylesheet (injected into `<head>`). |
| `.addBlob(url)` | Add a binary blob. |

### Control

| Method | Returns | Description |
|--------|---------|-------------|
| `.start()` | `Promise<Map>` | Start loading. Resolves with Map of url → result. |
| `.destroy()` | `void` | Abort everything, cancel fetches, clear listeners. |
| `.reset()` | `this` | Reset for replay. Keeps queue, clears results. |

### Events

```javascript
assets.on('progress', (loaded, total) => { });
assets.on('complete', () => { });
assets.on('error', (error, entry) => { });
assets.on('asset', (url, result, entry) => { });
```

### Accessors

| Property/Method | Type | Description |
|----------------|------|-------------|
| `.loaded` | `number` | Successfully loaded count |
| `.total` | `number` | Total queued count |
| `.failed` | `number` | Failed count (after all retries) |
| `.completed` | `number` | Done count (success + failure) |
| `.progress` | `number` | Ratio 0–1 |
| `.get(url)` | `any` | Get a loaded result by URL |
| `.getAll()` | `Map` | All results |
| `.getErrors()` | `Map` | All errors |
| `.getManifest()` | `Array` | Queue manifest (readonly copy) |

## Using with Howler.js

`addAudio()` creates an `HTMLAudioElement`, which is perfect for vanilla JavaScript audio. However, **Howler.js uses the Web Audio API internally** and doesn't accept HTMLAudioElements.

If you're using Howler.js, load audio as blobs and create Blob URLs:

```javascript
// ✅ Correct for Howler.js
assets.addBlob('/audio/hit.wav');

const results = await assets.start();
const blob = assets.get('/audio/hit.wav');
const blobUrl = URL.createObjectURL(blob);

const sound = new Howl({ src: [blobUrl], format: ['wav'] });
```

```javascript
// ❌ Wrong for Howler.js (creates HTMLAudioElement)
assets.addAudio('/audio/hit.wav');
```

## Type Auto-Detection

The loader detects asset types from file extensions. Query parameters and hashes are stripped before detection.

| Extensions | Type |
|-----------|------|
| png, jpg, jpeg, gif, webp, avif, svg, ico, bmp | `image` |
| mp3, ogg, wav, aac, flac, m4a, opus | `audio` |
| mp4, webm, ogv, mov | `video` |
| woff, woff2, ttf, otf, eot | `font` |
| json | `json` |
| js, mjs | `script` |
| css | `css` |
| *(anything else)* | `fetch` |

Override or extend: `AssetLoader.TYPE_MAP.myext = "image";`

## TypeScript

```typescript
import { AssetLoader, type AssetEntry } from 'lite-asset-loader';

const assets = new AssetLoader({ concurrency: 8 });

assets.on('asset', (url: string, result: any, entry: AssetEntry) => {
    console.log(`Loaded ${entry.type}: ${url}`);
});

const results = await assets.addImage('/hero.webp').start();
```

## License

MIT
