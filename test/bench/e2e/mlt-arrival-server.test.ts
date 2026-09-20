import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, expect} from 'vitest';
import {arrivalServer, arrivalTiles} from './mlt-arrival-server.ts';

test('holds real tile responses until each explicit release and preserves their bytes', async () => {
    const output = mkdtempSync(join(tmpdir(), 'mlt-arrival-server-'));
    const server = await arrivalServer(output, false);
    try {
        server.start();
        let completed = 0;
        const responses = arrivalTiles.map(async tile => {
            const response = await fetch(`${server.origin}/tiles/mlt/${tile}.mlt?arrival=1`);
            assert.equal(response.status, 200);
            const bytes = Buffer.from(await response.arrayBuffer()); completed++;
            return bytes;
        });
        const started = performance.now();
        while (server.waiting().length !== 4) {
            assert.ok(performance.now() - started < 5000);
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.equal(completed, 0); assert.deepEqual(server.waiting(), arrivalTiles);
        assert.throws(() => server.release('unknown'), /No held response/);
        for (const [index, tile] of arrivalTiles.entries()) {
            server.time((index + 1) * 500); server.release(tile);
            assert.deepEqual(await responses[index], readFileSync(`test/integration/assets/tiles/mlt/gl-js/${tile}.mlt`));
            assert.equal(completed, index + 1); assert.equal(server.waiting().length, 3 - index);
            assert.throws(() => server.release(tile), /No held response/);
        }
        assert.equal(server.trace().length, 12);
        assert.deepEqual(server.trace().filter(event => event.type === 'released').map(event => event.time), [500, 1000, 1500, 2000]);
        assert.ok(!server.trace().some(event => event.type === 'aborted'));
        expect(completed).toBe(4);
    } finally { await server.close(); rmSync(output, {recursive: true}); }
});
