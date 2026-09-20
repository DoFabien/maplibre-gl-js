import assert from 'node:assert/strict';
import {createServer, request as forwardRequest} from 'node:http';
import type {IncomingMessage, ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {localServer} from './mlt-geography.ts';

export type TerrainScene = 'local-orbit' | 'globe-flight';
export type TerrainDelivery = {time: number; type: 'requested' | 'released' | 'completed' | 'aborted'; tile: string; request?: number};

export function terrainTiles(scene: TerrainScene): string[] {
    if (scene === 'globe-flight') return ['vector:0-0-0', 'dem:0-0-0'];
    return ['vector:14-8802-5374', 'dem:12-2200-1343', 'vector:14-8802-5375', 'dem:12-2200-1344',
        'vector:14-8803-5374', 'dem:12-2201-1343', 'vector:14-8803-5375', 'dem:12-2201-1344'];
}

/**
 * Gates physical resources across repeated requests; MapLibre still performs HTTP, image/worker decoding and native cancellation.
 * Separate asset/vector/DEM origins prevent held HTTP/1 connections from starving unrelated requests at browser connection limits.
 */
export async function terrainArrivalServer(output: string, strict: boolean): Promise<{
    origin: string; vectorOrigin: string; demOrigin: string;
    manifest: Awaited<ReturnType<typeof localServer>>['manifest']; requests: Record<string, number>;
    start(scene: TerrainScene): void; time(value: number): void; waiting(): string[]; active(): number;
    trace(): TerrainDelivery[]; release(tile: string): void; close(): Promise<void>;
}> {
    const backend = await localServer(output, strict);
    const pending = new Map<number, {tile: string; request: IncomingMessage; response: ServerResponse}>();
    const opened = new Set<string>();
    let allowed: string[] = []; let time = 0; let nextRequest = 0; let active = 0; let trace: TerrainDelivery[] = [];
    let origin: string; let vectorOrigin: string; let demOrigin: string;
    function forward(request: IncomingMessage, response: ServerResponse, tile?: string, requestId?: number): void {
        const upstream = forwardRequest(new URL(request.url, backend.origin), {method: request.method}, result => {
            response.writeHead(result.statusCode, {...result.headers, 'access-control-allow-origin': origin,
                'content-security-policy': `default-src 'self'; script-src 'self' 'unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: ${demOrigin}; connect-src 'self' ${vectorOrigin} ${demOrigin}`});
            result.pipe(response);
        });
        upstream.on('error', error => response.destroy(error));
        if (tile) {
            active++;
            response.on('finish', () => trace.push({time, type: 'completed', tile, request: requestId}));
            response.on('close', () => {
                active--;
                if (!response.writableFinished) trace.push({time, type: 'aborted', tile, request: requestId});
            });
        }
        request.pipe(upstream);
    }
    function controlled(request: IncomingMessage, response: ServerResponse): void {
        const url = new URL(request.url, backend.origin);
        if (url.searchParams.get('terrain-arrival') !== '1') { forward(request, response); return; }
        const vector = /^\/tiles\/(mvt|mlt)\/(\d+-\d+-\d+)\.(mvt|mlt)$/.exec(url.pathname);
        const dem = /^\/dem-(local|world)\/(\d+-\d+-\d+)\.png$/.exec(url.pathname);
        const tile = vector && vector[1] === vector[3] ? `vector:${vector[2]}` :
            dem && (dem[1] === 'world') === (dem[2] === '0-0-0') ? `dem:${dem[2]}` : undefined;
        if (!allowed.includes(tile)) {
            response.writeHead(400); response.end('Unexpected controlled terrain resource'); return;
        }
        const requestId = ++nextRequest; trace.push({time, type: 'requested', tile, request: requestId});
        if (opened.has(tile)) { forward(request, response, tile, requestId); return; }
        pending.set(requestId, {tile, request, response});
        response.on('close', () => {
            if (!pending.has(requestId)) return;
            pending.delete(requestId); trace.push({time, type: 'aborted', tile, request: requestId});
        });
    }
    const server = createServer((request, response) => forward(request, response));
    const vectorServer = createServer(controlled); const demServer = createServer(controlled);
    for (const item of [server, vectorServer, demServer]) await new Promise<void>(resolve => item.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vectorOrigin = `http://127.0.0.1:${(vectorServer.address() as AddressInfo).port}`;
    demOrigin = `http://127.0.0.1:${(demServer.address() as AddressInfo).port}`;
    return {origin, vectorOrigin, demOrigin, manifest: backend.manifest, requests: backend.requests,
        start(scene: TerrainScene) { assert.equal(pending.size, 0); assert.equal(active, 0); opened.clear(); allowed = terrainTiles(scene); time = 0; nextRequest = 0; trace = []; },
        time(value: number) { assert.ok(Number.isFinite(value) && value >= time); time = value; },
        waiting: () => [...new Set([...pending.values()].map(value => value.tile))].sort(), active: () => active, trace: () => [...trace],
        release(tile: string) {
            assert.ok(allowed.includes(tile) && !opened.has(tile), `No closed gate for ${tile}`);
            opened.add(tile); trace.push({time, type: 'released', tile});
            for (const [id, held] of pending) {
                if (held.tile !== tile) continue;
                pending.delete(id); forward(held.request, held.response, tile, id);
            }
        },
        async close() {
            for (const {response} of pending.values()) response.destroy();
            pending.clear();
            for (const item of [server, vectorServer, demServer]) await new Promise<void>(resolve => item.close(() => resolve()));
            await backend.close();
        }};
}
