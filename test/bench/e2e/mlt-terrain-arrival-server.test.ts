import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, expect} from 'vitest';
import {terrainArrivalServer, terrainTiles, type TerrainScene} from './mlt-terrain-arrival-server.ts';

test.each([
    {scene: 'local-orbit', encoding: 'mvt'}, {scene: 'local-orbit', encoding: 'mlt'},
    {scene: 'globe-flight', encoding: 'mvt'}, {scene: 'globe-flight', encoding: 'mlt'}
] as Array<{scene: TerrainScene; encoding: 'mvt' | 'mlt'}>)('holds and delivers real vector/DEM bytes for $scene / $encoding', async ({scene, encoding}) => {
    const output = mkdtempSync(join(tmpdir(), 'mlt-terrain-arrival-server-'));
    const server = await terrainArrivalServer(output, false);
    const tiles = terrainTiles(scene);
    try {
        server.start(scene); let completed = 0;
        const responses = tiles.map(async tile => {
            const [kind, id] = tile.split(':'); const dem = scene === 'globe-flight' ? 'dem-world' : 'dem-local';
            const path = kind === 'vector' ? `tiles/${encoding}/${id}.${encoding}` : `${dem}/${id}.png`;
            const response = await fetch(`${kind === 'vector' ? server.vectorOrigin : server.demOrigin}/${path}?terrain-arrival=1`);
            assert.equal(response.status, 200); const bytes = Buffer.from(await response.arrayBuffer());
            const expected = kind === 'vector' ? `test/integration/assets/tiles/${encoding === 'mlt' ? 'mlt/gl-js/' : ''}${id}.${encoding}` : `${output}/${dem}-${id}.png`;
            assert.deepEqual(bytes, readFileSync(expected)); completed++; return bytes;
        });
        const started = performance.now();
        while (server.waiting().length !== tiles.length) {
            assert.ok(performance.now() - started < 5000); await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.equal(completed, 0); assert.deepEqual(server.waiting(), [...tiles].sort());
        assert.throws(() => server.release('unknown'), /No closed gate/);
        expect((await fetch(`${server.demOrigin}/dem-world/12-2200-1343.png?terrain-arrival=1`)).status).toBe(400);
        for (let index = tiles.length - 1; index >= 0; index--) {
            server.time((tiles.length - index) * 250); server.release(tiles[index]); await responses[index];
            assert.equal(completed, tiles.length - index); assert.equal(server.waiting().length, index);
            assert.throws(() => server.release(tiles[index]), /No closed gate/);
        }
        assert.equal(server.trace().length, tiles.length * 3);
        assert.deepEqual(server.trace().filter(event => event.type === 'released').map(event => event.tile), [...tiles].reverse());
        assert.ok(!server.trace().some(event => event.type === 'aborted'));
    } finally { await server.close(); rmSync(output, {recursive: true}); }
});

test('gates repeated physical-tile requests, tracks cancellation, and serves later requests after release', async () => {
    const output = mkdtempSync(join(tmpdir(), 'mlt-terrain-arrival-repeat-'));
    const server = await terrainArrivalServer(output, false);
    try {
        server.start('globe-flight'); const controller = new AbortController();
        const url = `${server.vectorOrigin}/tiles/mlt/0-0-0.mlt?terrain-arrival=1`;
        const cancelled = fetch(url, {signal: controller.signal}).catch(error => error.name);
        const kept = fetch(url);
        await until(() => server.trace().filter(event => event.type === 'requested').length === 2);
        assert.deepEqual(server.waiting(), ['vector:0-0-0']);
        controller.abort(); assert.equal(await cancelled, 'AbortError');
        await until(() => server.trace().some(event => event.type === 'aborted'));
        server.time(500); server.release('vector:0-0-0');
        const bytes = Buffer.from(await (await kept).arrayBuffer());
        assert.deepEqual(bytes, readFileSync('test/integration/assets/tiles/mlt/gl-js/0-0-0.mlt'));
        assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), bytes);
        await until(() => server.active() === 0);
        assert.equal(server.trace().filter(event => event.type === 'requested').length, 3);
        assert.equal(server.trace().filter(event => event.type === 'released').length, 1);
        assert.equal(server.trace().filter(event => event.type === 'completed').length, 2);
        assert.equal(server.trace().filter(event => event.type === 'aborted').length, 1);
        assert.ok(server.trace().filter(event => event.type === 'completed').every(event => event.time === 500));
        expect(server.waiting()).toEqual([]);
    } finally { await server.close(); rmSync(output, {recursive: true}); }
});

async function until(condition: () => boolean): Promise<void> {
    const start = performance.now();
    while (!condition()) {
        assert.ok(performance.now() - start < 5000); await new Promise(resolve => setTimeout(resolve, 5));
    }
}
