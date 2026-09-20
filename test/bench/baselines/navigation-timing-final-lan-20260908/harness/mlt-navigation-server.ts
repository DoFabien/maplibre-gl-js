import assert from 'node:assert/strict';
import {createServer, type ServerResponse} from 'node:http';
import {readFileSync, readdirSync} from 'node:fs';
import type {AddressInfo} from 'node:net';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';

export type NavigationNetwork = {name: string; latencyMs: number; bytesPerSecond: number};
export type TrafficEntry = {path: string; requested: number; firstByte?: number; ended?: number; payloadBytes: number; sentBytes: number; aborted: boolean};
type File = {bytes: Buffer; mime: string; compressed: boolean; measured: boolean};
type Pending = {response: ServerResponse; file: File; entry: TrafficEntry; offset: number; ready: number};

/** Serves gzip assets through one shared downlink budget; this is a bounded network model, not a live Internet trace. */
export async function navigationServer(fixtures: string, bundle: string, network: NavigationNetwork) {
    const manifest = JSON.parse(readFileSync(`${fixtures}/manifest.json`, 'utf8'));
    const files = new Map<string, File>();
    const hashes: Record<string, string> = {};
    const traffic: TrafficEntry[] = [];
    const misses: string[] = [];
    const pending: Pending[] = [];
    function add(url: string, path: string, mime: string, measured = false, compressed = false): void {
        const raw = readFileSync(path); hashes[path] = createHash('sha256').update(raw).digest('hex');
        files.set(url, {bytes: compressed ? gzipSync(raw) : raw, mime, compressed, measured});
    }
    add('/', 'test/bench/e2e/index.html', 'text/html');
    for (const file of ['maplibre-gl.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs', 'maplibre-gl.css']) {
        add(`/dist/${file}`, `${bundle}/${file}`, file.endsWith('.css') ? 'text/css' : 'text/javascript');
    }
    for (const tile of manifest.tiles) for (const encoding of ['mvt', 'mlt']) {
        assert.equal(createHash('sha256').update(readFileSync(tile[encoding].path)).digest('hex'), tile[encoding].sha256);
        add(`/tiles/${encoding}/${tile.name}.${encoding}`, tile[encoding].path, 'application/octet-stream', true, true);
    }
    const font = 'Open Sans Semibold,Arial Unicode MS Bold';
    for (const file of readdirSync(`test/integration/assets/glyphs/${font}`)) {
        add(`/glyphs/${font}/${file}`, `test/integration/assets/glyphs/${font}/${file}`, 'application/octet-stream', true, true);
    }
    for (const extension of ['json', 'png']) add(`/sprites/sprite.${extension}`, `test/integration/assets/sprites/sprite.${extension}`,
        extension === 'json' ? 'application/json' : 'image/png', true, extension === 'json');

    /** Spends at most one tick of bandwidth, with round-robin chunks across ready responses and no idle-time credit. */
    function pump(): void {
        let budget = Math.floor(network.bytesPerSecond / 100);
        let examined = 0;
        while (pending.length && budget > 0 && examined < pending.length) {
            const task = pending.shift();
            if (task.response.destroyed) continue;
            if (task.ready > performance.now()) { pending.push(task); examined++; continue; }
            const length = Math.min(budget, 16384, task.file.bytes.length - task.offset);
            task.entry.firstByte ??= performance.now();
            task.response.write(task.file.bytes.subarray(task.offset, task.offset + length));
            task.offset += length; task.entry.sentBytes += length; budget -= length; examined = 0;
            if (task.offset === task.file.bytes.length) task.response.end();
            else pending.push(task);
        }
    }
    const interval = network.bytesPerSecond ? setInterval(pump, 10) : undefined;
    const server = createServer((request, response) => {
        const path = decodeURI(new URL(request.url, 'http://localhost').pathname);
        const file = files.get(path);
        if (!file) { if (path !== '/favicon.ico') misses.push(path); response.writeHead(path === '/favicon.ico' ? 204 : 404); response.end(); return; }
        response.writeHead(200, {'Content-Type': file.mime, 'Content-Length': file.bytes.length,
            'Cache-Control': file.measured ? 'public, max-age=31536000, immutable' : 'no-store',
            ...(file.compressed ? {'Content-Encoding': 'gzip', Vary: 'Accept-Encoding'} : {}),
            'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'"});
        if (!file.measured) { response.end(file.bytes); return; }
        const entry: TrafficEntry = {path, requested: performance.now(), payloadBytes: file.bytes.length, sentBytes: 0, aborted: false};
        traffic.push(entry);
        response.on('finish', () => { entry.ended = performance.now(); });
        response.on('close', () => { if (!response.writableFinished) { entry.aborted = true; entry.ended = performance.now(); } });
        if (network.bytesPerSecond) pending.push({response, entry, file, offset: 0, ready: performance.now() + network.latencyMs});
        else { entry.firstByte = performance.now(); entry.sentBytes = file.bytes.length; response.end(file.bytes); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hashes, traffic, misses,
        close: async () => { clearInterval(interval); for (const task of pending) task.response.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }};
}
