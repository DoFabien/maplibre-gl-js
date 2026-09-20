import assert from 'node:assert/strict';
import {test, expect} from 'vitest';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {navigationRoute, summarizePass, tileArrivals} from './mlt-navigation-protocol.ts';
import {navigationServer} from './mlt-navigation-server.ts';
import type {NavigationPass} from './mlt-navigation-page.ts';

test('navigation metrics exclude dwells and intersect long tasks with motion windows', () => {
    const pass: NavigationPass = {started: 0, stopped: 140, finished: 150,
        windows: [{name: 'a', start: 0, end: 40, pose: []}, {name: 'b', start: 100, end: 140, pose: []}],
        frames: [{t: 0, moving: true, loaded: false}, {t: 20, moving: true, loaded: true}, {t: 40, moving: false, loaded: true},
            {t: 100, moving: true, loaded: true}, {t: 140, moving: false, loaded: true}],
        raf: [0, 10, 20, 40, 60, 100, 120, 140].map(t => ({t, moving: true})),
        longTasks: [{start: 30, duration: 80}, {start: 45, duration: 50}], data: [], visibility: ['visible']};
    const result = summarizePass(pass);
    expect(result.rafIntervals).toBe(5); assert.equal(result.rafP50Ms, 20); assert.equal(result.rafP95Ms, 20);
    assert.equal(result.motionMs, 80); assert.equal(result.pendingSourceMs, 20); assert.equal(result.pendingSourceFraction, 0.25);
    assert.equal(result.longTasks, 1); assert.equal(result.longTaskOverlapMs, 20); assert.equal(result.finalSettleMs, 10);
    assert.throws(() => summarizePass({...pass, raf: []}), /No observed/);
});

test('the real-time route returns to the exact initial pose and spans native zooms plus overzoom', () => {
    const first = navigationRoute[0]; const last = navigationRoute.at(-1);
    expect(last.center).toEqual(first.center); assert.equal(last.zoom, first.zoom);
    assert.deepEqual([...new Set(navigationRoute.map(pose => Math.floor(pose.zoom)))].sort(), [11, 12, 13, 14]);
    assert.ok(navigationRoute.slice(1).every(pose => pose.duration >= 1500));
});

test('tile arrivals retain cancelled loads and distinguish preparations of the same overzoom parent', () => {
    const pass = {data: [
        {t: 10, kind: 'dataloading', tile: '13-1-1', overscaledZ: 13},
        {t: 20, kind: 'dataloading', tile: '13-1-1', overscaledZ: 14},
        {t: 30, kind: 'sourcedata', tile: '13-1-1', overscaledZ: 14},
        {t: 40, kind: 'sourcedata', tile: '13-1-1', overscaledZ: 13},
        {t: 50, kind: 'dataloading', tile: '13-2-1', overscaledZ: 13}],
    frames: [{t: 35}, {t: 45}]} as NavigationPass;
    expect(tileArrivals(pass)).toEqual({completed: [
        {tile: '13-1-1', started: 20, loaded: 30, nextRender: 35},
        {tile: '13-1-1', started: 10, loaded: 40, nextRender: 45}], unmatched: 1});
});

test('the server preserves decoded bytes, uses gzip/cache headers, shares bandwidth and rejects unknown assets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mlt-navigation-server-'));
    const bytes = readFileSync('test/integration/assets/tiles/14-8802-5374.mvt');
    const path = `${dir}/fixture.bin`; writeFileSync(path, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(`${dir}/manifest.json`, JSON.stringify({tiles: [{name: '14-1-1', mvt: {path, sha256}, mlt: {path, sha256}}]}));
    const network = {name: 'test', latencyMs: 40, bytesPerSecond: 1000000};
    const server = await navigationServer(dir, 'dist', network);
    try {
        const start = performance.now();
        const responses = await Promise.all(['mvt', 'mlt'].map(async encoding => {
            const response = await fetch(`${server.origin}/tiles/${encoding}/14-1-1.${encoding}`);
            assert.equal(response.headers.get('content-encoding'), 'gzip');
            assert.match(response.headers.get('cache-control'), /immutable/);
            return Buffer.from(await response.arrayBuffer());
        }));
        for (const response of responses) assert.deepEqual(response, bytes);
        const gzipBytes = gzipSync(bytes).length;
        assert.ok(performance.now() - start >= (2 * gzipBytes / network.bytesPerSecond) * 1000 + network.latencyMs - 20);
        expect(server.traffic).toHaveLength(2);
        assert.ok(server.traffic.every(entry => !entry.aborted && entry.sentBytes === gzipBytes && entry.firstByte - entry.requested >= 39));
        assert.equal((await fetch(`${server.origin}/tiles/mvt/unknown.mvt`)).status, 404);
        assert.deepEqual(server.misses, ['/tiles/mvt/unknown.mvt']);
    } finally { await server.close(); rmSync(dir, {recursive: true}); }
});
