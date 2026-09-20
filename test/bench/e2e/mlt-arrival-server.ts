import assert from 'node:assert/strict';
import {createServer, request as forwardRequest} from 'node:http';
import type {IncomingMessage, ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {localServer} from './mlt-geography.ts';

export const arrivalTiles: string[] = ['14-8802-5374', '14-8802-5375', '14-8803-5374', '14-8803-5375'];
export type DeliveryEvent = {time: number; type: 'requested' | 'released' | 'completed' | 'aborted'; tile: string};

/** Holds real local HTTP responses, leaving MapLibre request construction, workers and parsing untouched. */
export async function arrivalServer(output: string, strict: boolean): Promise<{
    origin: string; manifest: Awaited<ReturnType<typeof localServer>>['manifest']; requests: Record<string, number>;
    start(): void; time(value: number): void; waiting(): string[]; release(tile: string): void; trace(): DeliveryEvent[]; close(): Promise<void>;
}> {
    const backend = await localServer(output, strict);
    const pending = new Map<string, {request: IncomingMessage; response: ServerResponse}>();
    let time = 0;
    let trace: DeliveryEvent[] = [];
    function forward(request: IncomingMessage, response: ServerResponse, tile?: string): void {
        const upstream = forwardRequest(new URL(request.url, backend.origin), {method: request.method}, result => {
            response.writeHead(result.statusCode, result.headers);
            result.pipe(response);
        });
        upstream.on('error', error => response.destroy(error));
        if (tile) response.on('finish', () => trace.push({time, type: 'completed', tile}));
        request.pipe(upstream);
    }
    const server = createServer((request, response) => {
        const url = new URL(request.url, backend.origin);
        if (url.searchParams.get('arrival') !== '1') { forward(request, response); return; }
        const match = /^\/tiles\/(mvt|mlt)\/(14-\d+-\d+)\.(mvt|mlt)$/.exec(url.pathname);
        if (!match || match[1] !== match[3] || !arrivalTiles.includes(match[2]) || pending.has(match[2])) {
            response.writeHead(400); response.end('Unexpected controlled tile'); return;
        }
        const tile = match[2];
        pending.set(tile, {request, response}); trace.push({time, type: 'requested', tile});
        response.on('close', () => {
            if (pending.get(tile)?.response !== response) return;
            pending.delete(tile); trace.push({time, type: 'aborted', tile});
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, manifest: backend.manifest, requests: backend.requests,
        start() { assert.equal(pending.size, 0); time = 0; trace = []; },
        time(value) { assert.ok(Number.isFinite(value) && value >= time); time = value; },
        waiting: () => [...pending.keys()].sort(), trace: () => [...trace],
        release(tile) {
            const held = pending.get(tile); assert.ok(held, `No held response for ${tile}`);
            pending.delete(tile); trace.push({time, type: 'released', tile}); forward(held.request, held.response, tile);
        },
        async close() {
            for (const {response} of pending.values()) response.destroy();
            pending.clear();
            await new Promise<void>(resolve => server.close(() => resolve()));
            await backend.close();
        }};
}
