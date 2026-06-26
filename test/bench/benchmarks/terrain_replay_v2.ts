import {type BenchmarkLike, type Measurement} from '../lib/benchmark.ts';
import createMap from '../lib/create_map.ts';
import type {Map} from '../../../src/ui/map.ts';
import type {GeoJSONSource} from '../../../src/source/geojson_source.ts';
import type {Painter, TerrainRenderStats} from '../../../src/render/painter.ts';
import type {StyleSpecification} from '@maplibre/maplibre-gl-style-spec';

const MEASUREMENT_COUNT = 10;
const DURATION = 1_000;
const FRAME_BUDGET = 1000 / 60;
const CENTER_START: [number, number] = [0.0, 0.15];
const CENTER_END: [number, number] = [0.0, -0.15];
const CLOSE_GROUND_START: [number, number] = [0.0, 0.035];
const CLOSE_GROUND_END: [number, number] = [0.0, -0.035];
const DATASET_DESCRIPTION = {
    name: 'bundled terrain replay',
    vectorTile: 'test/bench/data/785.vector.pbf',
    demTile: 'test/bench/data/terrain_dem.png',
    glyphs: 'test/integration/assets/glyphs/{fontstack}/{range}.pbf',
    note: 'This is a deterministic benchmark fixture. The same bundled vector and DEM tiles are served for all requested tile IDs, and style layers are repeated to create stable terrain render-to-texture work.'
};

type TerrainReplayWorkloadName =
    | 'terrain-hot-rtt'
    | 'terrain-cold-rtt'
    | 'terrain-dynamic-draped-source'
    | 'terrain-dynamic-symbol-source'
    | 'terrain-close-ground'
    | 'terrain-mobile-budget';

type GpuPass = 'rtt' | 'masks' | 'terrain' | 'depth' | 'coords';

type TerrainReplayWorkload = {
    name: TerrainReplayWorkloadName;
    description: string;
    centerStart: [number, number];
    centerEnd: [number, number];
    zoom: number;
    pitch: number;
    bearing: number;
    width: number;
    height: number;
    pixelRatio: number;
    styleComplexity: number;
    includeOcclusionConsumers?: boolean;
    beforeReplay?: 'release-rtt' | 'update-draped-source' | 'update-symbol-source';
};

type PassMap<T> = Record<GpuPass, T>;

type ProfilerStats = {
    rendererCpuTimes: number[];
    drawCalls: number;
    drawCallsByPass: PassMap<number>;
    uniformUploads: number;
    textureBinds: number;
    rttCacheHits: number;
    rttCacheMisses: number;
    rttPixelsRendered: number;
    rttBatchCount: number;
    rttTileBatches: number;
    rttLayerBatches: number;
    invalidationsByCause: Record<string, number>;
};

type GpuQuery = {
    label: GpuPass;
    query: WebGLQuery;
};

type TerrainReplayMapOptions = {
    terrainRenderToTextureMaxSize?: number;
};

const WORKLOADS: Record<TerrainReplayWorkloadName, TerrainReplayWorkload> = {
    'terrain-hot-rtt': {
        name: 'terrain-hot-rtt',
        description: 'Camera replay with terrain RTT cache already populated',
        centerStart: CENTER_START,
        centerEnd: CENTER_END,
        zoom: 12,
        pitch: 85,
        bearing: 180,
        width: 768,
        height: 768,
        pixelRatio: 1,
        styleComplexity: 32
    },
    'terrain-cold-rtt': {
        name: 'terrain-cold-rtt',
        description: 'Camera replay after releasing all cached terrain RTT textures',
        centerStart: CENTER_START,
        centerEnd: CENTER_END,
        zoom: 12,
        pitch: 85,
        bearing: 180,
        width: 768,
        height: 768,
        pixelRatio: 1,
        styleComplexity: 32,
        beforeReplay: 'release-rtt'
    },
    'terrain-dynamic-draped-source': {
        name: 'terrain-dynamic-draped-source',
        description: 'Draped GeoJSON source update that should legitimately invalidate RTT',
        centerStart: CENTER_START,
        centerEnd: CENTER_END,
        zoom: 12,
        pitch: 85,
        bearing: 180,
        width: 768,
        height: 768,
        pixelRatio: 1,
        styleComplexity: 32,
        beforeReplay: 'update-draped-source'
    },
    'terrain-dynamic-symbol-source': {
        name: 'terrain-dynamic-symbol-source',
        description: 'Symbol-only GeoJSON source update that should not invalidate draped RTT',
        centerStart: CENTER_START,
        centerEnd: CENTER_END,
        zoom: 12,
        pitch: 85,
        bearing: 180,
        width: 768,
        height: 768,
        pixelRatio: 1,
        styleComplexity: 32,
        beforeReplay: 'update-symbol-source'
    },
    'terrain-close-ground': {
        name: 'terrain-close-ground',
        description: 'High zoom and high pitch replay close to ground',
        centerStart: CLOSE_GROUND_START,
        centerEnd: CLOSE_GROUND_END,
        zoom: 15,
        pitch: 85,
        bearing: 180,
        width: 768,
        height: 768,
        pixelRatio: 1,
        styleComplexity: 32
    },
    'terrain-mobile-budget': {
        name: 'terrain-mobile-budget',
        description: 'Small mobile viewport with high DPR',
        centerStart: CENTER_START,
        centerEnd: CENTER_END,
        zoom: 12,
        pitch: 85,
        bearing: 180,
        width: 393,
        height: 852,
        pixelRatio: 2,
        styleComplexity: 24
    }
};

function emptyPassMap<T>(value: T): PassMap<T> {
    return {
        rtt: value,
        masks: value,
        terrain: value,
        depth: value,
        coords: value
    };
}

function nextFrame(): Promise<void> {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function onceMapEvent(map: Map, event: string): Promise<void> {
    return new Promise(resolve => map.once(event as any, () => resolve()));
}

function urlInteger(name: string, fallback: number, min: number, max: number): number {
    const value = Number(new URL(location.href).searchParams.get(name));
    if (!Number.isInteger(value)) return fallback;
    return Math.max(min, Math.min(max, value));
}

function percentile(values: number[], p: number): number | null {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const index = (sorted.length - 1) * p;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function sum(values: number[]): number {
    return values.reduce((acc, value) => acc + value, 0);
}

function summarizeTimes(values: number[]): {p50: number | null; p95: number | null; total: number; count: number} {
    return {
        p50: percentile(values, 0.5),
        p95: percentile(values, 0.95),
        total: sum(values),
        count: values.length
    };
}

function jankSum(frameTimes: number[]): number {
    let total = 0;
    for (const time of frameTimes) {
        if (time > FRAME_BUDGET) total += time - FRAME_BUDGET;
    }
    return total;
}

function makeDrapedData(sample: number): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = [];
    const wobble = (sample % 11) * 0.0008;

    for (let i = 0; i < 25; i++) {
        const col = i % 5;
        const row = Math.floor(i / 5);
        const lng = (col - 2) * 0.022 + wobble;
        const lat = (row - 2) * 0.022 - wobble;
        const size = 0.007 + (i % 3) * 0.001;
        features.push({
            type: 'Feature',
            id: `fill-${i}`,
            properties: {kind: 'draped-fill', rank: i},
            geometry: {
                type: 'Polygon',
                coordinates: [[
                    [lng - size, lat - size],
                    [lng + size, lat - size],
                    [lng + size, lat + size],
                    [lng - size, lat + size],
                    [lng - size, lat - size]
                ]]
            }
        });
        features.push({
            type: 'Feature',
            id: `line-${i}`,
            properties: {kind: 'draped-line', rank: i},
            geometry: {
                type: 'LineString',
                coordinates: [
                    [lng - size * 1.5, lat - size],
                    [lng, lat + size * 1.5],
                    [lng + size * 1.5, lat - size]
                ]
            }
        });
    }

    return {type: 'FeatureCollection', features};
}

function makeSymbolData(sample: number): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = [];
    const wobble = (sample % 13) * 0.0006;

    for (let i = 0; i < 64; i++) {
        const col = i % 8;
        const row = Math.floor(i / 8);
        features.push({
            type: 'Feature',
            id: `symbol-${i}`,
            properties: {name: `S${i}`},
            geometry: {
                type: 'Point',
                coordinates: [
                    (col - 3.5) * 0.015 + wobble,
                    (row - 3.5) * 0.015 - wobble
                ]
            }
        });
    }

    return {type: 'FeatureCollection', features};
}

class TerrainReplayProfiler {
    private map: Map;
    private painter: Painter;
    private gl: WebGL2RenderingContext;
    private ext: any;
    private restoreCallbacks: Array<() => void> = [];
    private queries: GpuQuery[] = [];
    private activePass: GpuPass | null = null;
    private invalidationCause: string | null = null;
    private previousTerrainRenderStats: TerrainRenderStats | undefined;
    stats: ProfilerStats;

    constructor(map: Map) {
        this.map = map;
        this.painter = map.painter;
        this.gl = this.painter.context.gl;
        this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
        this.reset();
    }

    install(): void {
        this.installGlCounters();
        this.installRendererCpuTimer();
        this.installPassTimers();
        this.installTerrainRenderStats();
    }

    uninstall(): void {
        for (let i = this.restoreCallbacks.length - 1; i >= 0; i--) {
            this.restoreCallbacks[i]();
        }
        this.restoreCallbacks.length = 0;
        for (const {query} of this.queries) this.gl.deleteQuery(query);
        this.queries.length = 0;
    }

    reset(): void {
        this.stats = {
            rendererCpuTimes: [],
            drawCalls: 0,
            drawCallsByPass: emptyPassMap(0),
            uniformUploads: 0,
            textureBinds: 0,
            rttCacheHits: 0,
            rttCacheMisses: 0,
            rttPixelsRendered: 0,
            rttBatchCount: 0,
            rttTileBatches: 0,
            rttLayerBatches: 0,
            invalidationsByCause: {}
        };
    }

    setInvalidationCause(cause: string | null): void {
        this.invalidationCause = cause;
    }

    gpuTimerAvailable(): boolean {
        return !!this.ext;
    }

    private installTerrainRenderStats(): void {
        this.previousTerrainRenderStats = this.painter.terrainRenderStats;
        this.painter.terrainRenderStats = {
            recordRttCacheHit: (size: number) => {
                this.stats.rttCacheHits++;
                this.previousTerrainRenderStats?.recordRttCacheHit?.(size);
            },
            recordRttCacheMiss: (size: number) => {
                this.stats.rttCacheMisses++;
                this.stats.rttPixelsRendered += size * size;
                this.previousTerrainRenderStats?.recordRttCacheMiss?.(size);
            },
            recordRttInvalidation: (objectCount: number) => {
                if (objectCount > 0) {
                    const cause = this.invalidationCause || 'renderer';
                    this.stats.invalidationsByCause[cause] = (this.stats.invalidationsByCause[cause] || 0) + objectCount;
                }
                this.previousTerrainRenderStats?.recordRttInvalidation?.(objectCount);
            },
            recordRttStack: (size: number, tileCount: number, layerCount: number) => {
                this.stats.rttBatchCount++;
                this.stats.rttTileBatches += tileCount;
                this.stats.rttLayerBatches += layerCount;
                this.previousTerrainRenderStats?.recordRttStack?.(size, tileCount, layerCount);
            }
        };
        this.restoreCallbacks.push(() => {
            this.painter.terrainRenderStats = this.previousTerrainRenderStats;
        });
    }

    private installGlCounters(): void {
        const drawMethods = ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced'];
        for (const method of drawMethods) {
            this.wrapGlMethod(method, () => {
                this.stats.drawCalls++;
                if (this.activePass) this.stats.drawCallsByPass[this.activePass]++;
            });
        }

        const uniformMethods = [
            'uniform1f', 'uniform1fv', 'uniform1i', 'uniform1iv', 'uniform2f', 'uniform2fv',
            'uniform2i', 'uniform2iv', 'uniform3f', 'uniform3fv', 'uniform3i', 'uniform3iv',
            'uniform4f', 'uniform4fv', 'uniform4i', 'uniform4iv', 'uniformMatrix2fv',
            'uniformMatrix3fv', 'uniformMatrix4fv'
        ];
        for (const method of uniformMethods) {
            this.wrapGlMethod(method, () => {
                this.stats.uniformUploads++;
            });
        }

        this.wrapGlMethod('bindTexture', () => {
            this.stats.textureBinds++;
        });
    }

    private installRendererCpuTimer(): void {
        const map = this.map as any;
        const original = map._render;
        map._render = (...args: any[]) => {
            const start = performance.now();
            try {
                return original.apply(map, args);
            } finally {
                this.stats.rendererCpuTimes.push(performance.now() - start);
            }
        };
        this.restoreCallbacks.push(() => {
            map._render = original;
        });
    }

    private installPassTimers(): void {
        const drawFunctions = this.painter.drawFunctions as any;
        this.wrapObjectMethod(drawFunctions, 'terrainDepth', 'depth');
        this.wrapObjectMethod(drawFunctions, 'terrainCoords', 'coords');
        this.wrapObjectMethod(drawFunctions, 'terrain', 'terrain');

        const originalMasks = this.painter.renderTileClippingMasks;
        this.painter.renderTileClippingMasks = (layer, tileIDs, renderToTexture) => {
            if (renderToTexture) {
                return this.timeGpu('masks', () => originalMasks.call(this.painter, layer, tileIDs, renderToTexture));
            }
            return originalMasks.call(this.painter, layer, tileIDs, renderToTexture);
        };
        this.restoreCallbacks.push(() => {
            this.painter.renderTileClippingMasks = originalMasks;
        });

        const originalRenderLayer = this.painter.renderLayer;
        this.painter.renderLayer = (painter, tileManager, layer, coords, renderOptions) => {
            if (renderOptions?.isRenderingToTexture) {
                return this.timeGpu('rtt', () => originalRenderLayer.call(this.painter, painter, tileManager, layer, coords, renderOptions));
            }
            return originalRenderLayer.call(this.painter, painter, tileManager, layer, coords, renderOptions);
        };
        this.restoreCallbacks.push(() => {
            this.painter.renderLayer = originalRenderLayer;
        });
    }

    private wrapObjectMethod(target: Record<string, any>, method: string, pass: GpuPass): void {
        const original = target[method];
        target[method] = (...args: any[]) => this.timeGpu(pass, () => original.apply(target, args));
        this.restoreCallbacks.push(() => {
            target[method] = original;
        });
    }

    private wrapGlMethod(method: string, beforeCall: () => void): void {
        const gl = this.gl as any;
        const original = gl[method];
        if (typeof original !== 'function') return;
        gl[method] = (...args: any[]) => {
            beforeCall();
            return original.apply(this.gl, args);
        };
        this.restoreCallbacks.push(() => {
            gl[method] = original;
        });
    }

    private timeGpu<T>(label: GpuPass, fn: () => T): T {
        const previousPass = this.activePass;
        this.activePass = label;

        if (!this.ext) {
            try {
                return fn();
            } finally {
                this.activePass = previousPass;
            }
        }

        const query = this.gl.createQuery();
        if (!query) {
            try {
                return fn();
            } finally {
                this.activePass = previousPass;
            }
        }
        this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
        try {
            return fn();
        } finally {
            this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
            this.queries.push({label, query});
            this.activePass = previousPass;
        }
    }

    async collectGpuTimers(): Promise<{available: boolean; disjoint: boolean; timedOut: boolean; values: PassMap<number | null>}> {
        const values = emptyPassMap<number | null>(null);
        if (!this.ext || this.queries.length === 0) {
            return {available: false, disjoint: false, timedOut: false, values};
        }

        let timedOut = true;
        let disjoint = false;
        for (let attempt = 0; attempt < 60; attempt++) {
            await nextFrame();
            disjoint = !!this.gl.getParameter(this.ext.GPU_DISJOINT_EXT);
            const available = this.queries.every(({query}) => this.gl.getQueryParameter(query, this.gl.QUERY_RESULT_AVAILABLE));
            if (available || disjoint) {
                timedOut = false;
                break;
            }
        }

        if (!timedOut && !disjoint) {
            for (const {label, query} of this.queries) {
                const nanos = this.gl.getQueryParameter(query, this.gl.QUERY_RESULT);
                values[label] = (values[label] || 0) + nanos / 1_000_000;
            }
        }

        for (const {query} of this.queries) this.gl.deleteQuery(query);
        this.queries.length = 0;

        return {available: !timedOut && !disjoint, disjoint, timedOut, values};
    }
}

class TerrainReplayV2 implements BenchmarkLike {
    private workload: TerrainReplayWorkload;
    private map: Map;
    private profiler: TerrainReplayProfiler;
    private measurementCount: number;
    private styleComplexity: number;
    private duration: number;
    private mapOptions: TerrainReplayMapOptions;

    constructor(workload: TerrainReplayWorkload, mapOptions: TerrainReplayMapOptions = {}) {
        this.workload = workload;
        this.mapOptions = mapOptions;
        this.measurementCount = urlInteger('terrainReplaySamples', MEASUREMENT_COUNT, 1, MEASUREMENT_COUNT);
        this.styleComplexity = urlInteger('terrainReplayStyleComplexity', workload.styleComplexity, 1, workload.styleComplexity);
        this.duration = urlInteger('terrainReplayDuration', DURATION, 100, DURATION);
    }

    async run(): Promise<Measurement[]> {
        await this.setup();
        try {
            const measurements: Measurement[] = [];
            for (let i = 0; i < this.measurementCount; i++) {
                measurements.push(await this.bench(i));
            }
            return measurements;
        } finally {
            this.teardown();
        }
    }

    private async setup(): Promise<void> {
        const style = buildReplayStyle(this.styleComplexity, this.workload.includeOcclusionConsumers !== false);
        style.projection = {type: 'mercator'};

        this.map = await createMap({
            center: this.workload.centerStart,
            zoom: this.workload.zoom,
            pitch: this.workload.pitch,
            bearing: this.workload.bearing,
            maxPitch: this.workload.pitch,
            width: this.workload.width,
            height: this.workload.height,
            pixelRatio: this.workload.pixelRatio,
            style,
            fadeDuration: 300,
            stubRender: false,
            showMap: true,
            idle: true,
            ...this.mapOptions,
        });

        this.map.setTerrain({source: 'dem', exaggeration: 1});
        await onceMapEvent(this.map, 'idle');

        this.profiler = new TerrainReplayProfiler(this.map);
        this.profiler.install();

        await this.playCameraReplay();
        await this.resetCamera();
    }

    private teardown(): void {
        this.profiler?.uninstall();
        this.map?.remove();
    }

    private async bench(sampleIndex: number): Promise<Measurement> {
        await this.resetCamera();
        this.profiler.reset();

        let activeInvalidationCause: string | null = null;
        try {
            activeInvalidationCause = await this.prepareWorkload(sampleIndex);
            const replay = await this.playCameraReplay();
            const gpu = await this.profiler.collectGpuTimers();
            const frameTimes = replay.frameTimes.length ? replay.frameTimes : [replay.wallTime];
            const frameSummary = summarizeTimes(frameTimes);
            const rendererSummary = summarizeTimes(this.profiler.stats.rendererCpuTimes);
            const rtt = this.collectRttStats();
            const terrain = this.collectTerrainStats();
            const sourceTiles = this.collectSourceTileStats();
            const time = frameSummary.p95 ?? replay.wallTime;

            return {
                time,
                iterations: 1,
                diagnostics: {
                    workload: this.workload.name,
                    description: this.workload.description,
                    dataset: DATASET_DESCRIPTION,
                    sampleIndex,
                    wallTimeMs: replay.wallTime,
                    cpuFrameMs: {
                        ...frameSummary,
                        jankSum: jankSum(frameTimes),
                        frameBudget: FRAME_BUDGET
                    },
                    renderer: {
                        cpuMs: rendererSummary,
                        hardwareCounters: {
                            cycles: null,
                            instructions: null,
                            unavailableReason: 'Browser benchmarks do not expose CPU PMU counters; collect cycles/instructions with an external profiler around this workload.'
                        }
                    },
                    gpuMs: {
                        ...gpu.values,
                        available: gpu.available,
                        disjoint: gpu.disjoint,
                        timedOut: gpu.timedOut
                    },
                    gl: {
                        drawCalls: this.profiler.stats.drawCalls,
                        drawCallsByPass: this.profiler.stats.drawCallsByPass,
                        uniformUploads: this.profiler.stats.uniformUploads,
                        textureBinds: this.profiler.stats.textureBinds
                    },
                    rtt,
                    terrain,
                    sourceTiles,
                    activeInvalidationCause,
                    map: {
                        width: this.workload.width,
                        height: this.workload.height,
                        pixelRatio: this.workload.pixelRatio,
                        zoom: this.workload.zoom,
                        pitch: this.workload.pitch,
                        bearing: this.workload.bearing,
                        fadeDuration: 300,
                        duration: this.duration,
                        samples: this.measurementCount,
                        styleComplexity: this.styleComplexity,
                        includeOcclusionConsumers: this.workload.includeOcclusionConsumers !== false,
                        terrainRenderToTextureMaxSize: this.mapOptions.terrainRenderToTextureMaxSize,
                    }
                }
            };
        } finally {
            this.profiler.setInvalidationCause(null);
        }
    }

    private async prepareWorkload(sampleIndex: number): Promise<string | null> {
        switch (this.workload.beforeReplay) {
            case 'release-rtt':
                this.profiler.setInvalidationCause('cold-rtt-cache-clear');
                this.map.terrain?.tileManager.releaseAllRTT();
                return 'cold-rtt-cache-clear';
            case 'update-draped-source': {
                const cause = 'draped-source-data';
                this.profiler.setInvalidationCause(cause);
                const source = this.map.getSource<GeoJSONSource>('dynamic-draped');
                await source.setData(makeDrapedData(sampleIndex + 1));
                return cause;
            }
            case 'update-symbol-source': {
                const cause = 'symbol-source-data';
                this.profiler.setInvalidationCause(cause);
                const source = this.map.getSource<GeoJSONSource>('dynamic-symbols');
                await source.setData(makeSymbolData(sampleIndex + 1));
                return cause;
            }
            default:
                return null;
        }
    }

    private async resetCamera(): Promise<void> {
        this.map.stop();
        if (this.isAtStartCamera() && this.map.loaded() && !this.map.isMoving()) return;
        const idle = onceMapEvent(this.map, 'idle');
        this.map.jumpTo({
            center: this.workload.centerStart,
            zoom: this.workload.zoom,
            pitch: this.workload.pitch,
            bearing: this.workload.bearing
        });
        await idle;
    }

    private isAtStartCamera(): boolean {
        const center = this.map.getCenter();
        return Math.abs(center.lng - this.workload.centerStart[0]) < 1e-9 &&
            Math.abs(center.lat - this.workload.centerStart[1]) < 1e-9 &&
            Math.abs(this.map.getZoom() - this.workload.zoom) < 1e-9 &&
            Math.abs(this.map.getPitch() - this.workload.pitch) < 1e-9 &&
            Math.abs(this.map.getBearing() - this.workload.bearing) < 1e-9;
    }

    private async playCameraReplay(): Promise<{frameTimes: number[]; wallTime: number}> {
        const frameTimes: number[] = [];
        let previousFrameTime: number | undefined;
        let running = true;
        const onFrame = (time: number) => {
            if (!running) return;
            if (previousFrameTime !== undefined) frameTimes.push(time - previousFrameTime);
            previousFrameTime = time;
            requestAnimationFrame(onFrame);
        };
        requestAnimationFrame(onFrame);

        const start = performance.now();
        this.map.flyTo({
            center: this.workload.centerEnd,
            zoom: this.workload.zoom,
            pitch: this.workload.pitch,
            bearing: this.workload.bearing,
            duration: this.duration,
            curve: 1,
            minZoom: this.workload.zoom,
            easing: t => t,
        });
        await onceMapEvent(this.map, 'moveend');
        running = false;
        await nextFrame();
        return {frameTimes, wallTime: performance.now() - start};
    }

    private collectRttStats(): Record<string, unknown> {
        const terrain = this.map.terrain as any;
        const terrainTiles = Object.values(terrain?.tileManager?._tiles || {}) as any[];
        let objectCount = 0;
        let memoryBytes = 0;

        for (const tile of terrainTiles) {
            for (const obj of tile.rttObjects || []) {
                if (!obj) continue;
                objectCount++;
                memoryBytes += obj.size * obj.size * 4;
            }
        }

        return {
            cacheHits: this.profiler.stats.rttCacheHits,
            cacheMisses: this.profiler.stats.rttCacheMisses,
            pixelsRendered: this.profiler.stats.rttPixelsRendered,
            invalidationsByCause: this.profiler.stats.invalidationsByCause,
            memoryBytes,
            objectCount,
            tileCount: terrainTiles.length,
            batchCount: this.profiler.stats.rttBatchCount,
            tileBatches: this.profiler.stats.rttTileBatches,
            layerBatches: this.profiler.stats.rttLayerBatches,
            rttSize: (this.map.painter.renderToTexture as any)?.rttSize ?? null
        };
    }

    private collectTerrainStats(): Record<string, unknown> {
        const terrain = this.map.terrain as any;
        if (!terrain) return {vertexCount: 0, renderableTileCount: 0};
        const tiles = terrain.tileManager.getRenderableTiles();
        let vertexCount = 0;
        for (const tile of tiles) {
            const mesh = terrain.getTerrainMesh(tile.tileID);
            for (const segment of mesh.segments.get()) {
                vertexCount += segment.vertexLength;
            }
        }
        return {
            vertexCount,
            renderableTileCount: tiles.length,
            meshSize: terrain.meshSize,
            qualityFactor: terrain.qualityFactor
        };
    }

    private collectSourceTileStats(): Record<string, unknown> {
        const counts = {};
        for (const id in this.map.style.tileManagers) {
            const tileManager = this.map.style.tileManagers[id];
            counts[id] = {
                visible: tileManager.getVisibleCoordinates().length,
                revision: tileManager.getState().revision
            };
        }
        return counts;
    }
}

function buildReplayStyle(styleComplexity: number, includeOcclusionConsumers: boolean = true): StyleSpecification {
    const layers: StyleSpecification['layers'] = [
        {id: 'background', type: 'background', paint: {'background-color': '#f0ece0'}},
    ];

    const baseLayers: StyleSpecification['layers'] = [
        {
            id: 'landuse',
            type: 'fill',
            source: 'vector',
            'source-layer': 'landuse',
            paint: {'fill-color': '#d0e0a0', 'fill-opacity': 0.6},
        },
        {
            id: 'landuse_overlay',
            type: 'fill',
            source: 'vector',
            'source-layer': 'landuse_overlay',
            paint: {'fill-color': '#c8dca0', 'fill-opacity': 0.5},
        },
        {
            id: 'water',
            type: 'fill',
            source: 'vector',
            'source-layer': 'water',
            paint: {'fill-color': '#a0c8f0'},
        },
        {
            id: 'waterway',
            type: 'line',
            source: 'vector',
            'source-layer': 'waterway',
            paint: {'line-color': '#80a8d0', 'line-width': 1.2},
        },
        {
            id: 'road_casing',
            type: 'line',
            source: 'vector',
            'source-layer': 'road',
            paint: {'line-color': '#888', 'line-width': 4, 'line-opacity': 0.6},
        },
        {
            id: 'road',
            type: 'line',
            source: 'vector',
            'source-layer': 'road',
            paint: {
                'line-color': ['match', ['get', 'class'],
                    'motorway', '#fc8',
                    'trunk', '#fc8',
                    'primary', '#fea',
                    'secondary', '#ffd',
                    '#fff',
                ],
                'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 16, 6],
            },
        },
    ];

    if (includeOcclusionConsumers) {
        baseLayers.push(
            {
                id: 'road_label',
                type: 'symbol',
                source: 'vector',
                'source-layer': 'road_label',
                layout: {
                    'symbol-placement': 'line',
                    'text-field': ['get', 'name'],
                    'text-font': ['Noto Sans Regular'],
                    'text-size': 11,
                },
                paint: {'text-color': '#333', 'text-halo-color': '#fff', 'text-halo-width': 1},
            },
            {
                id: 'poi_circle',
                type: 'circle',
                source: 'vector',
                'source-layer': 'poi_label',
                paint: {
                    'circle-radius': 3,
                    'circle-color': '#a55',
                    'circle-stroke-width': 1,
                    'circle-stroke-color': '#fff',
                },
            },
            {
                id: 'poi_label',
                type: 'symbol',
                source: 'vector',
                'source-layer': 'poi_label',
                layout: {
                    'text-field': ['get', 'name'],
                    'text-font': ['Noto Sans Regular'],
                    'text-size': 10,
                    'text-offset': [0, 0.8],
                    'text-anchor': 'top',
                },
                paint: {'text-color': '#553', 'text-halo-color': '#fff', 'text-halo-width': 1},
            },
            {
                id: 'place_label',
                type: 'symbol',
                source: 'vector',
                'source-layer': 'place_label',
                layout: {
                    'text-field': ['get', 'name'],
                    'text-font': ['Noto Sans Regular'],
                    'text-size': ['interpolate', ['linear'], ['get', 'localrank'], 1, 16, 10, 11],
                    'text-allow-overlap': false,
                },
                paint: {'text-color': '#222', 'text-halo-color': '#fff', 'text-halo-width': 1.5},
            }
        );
    }

    for (let i = 0; i < styleComplexity; i++) {
        for (const layer of baseLayers) {
            layers.push({...layer, id: `${layer.id}_${i}`} as any);
        }
    }

    layers.push(
        {
            id: 'dynamic-draped-fill',
            type: 'fill',
            source: 'dynamic-draped',
            filter: ['==', ['get', 'kind'], 'draped-fill'],
            paint: {'fill-color': '#c65f46', 'fill-opacity': 0.35},
        },
        includeOcclusionConsumers ?
            {
                id: 'dynamic-symbol-labels',
                type: 'symbol',
                source: 'dynamic-symbols',
                layout: {
                    'text-field': ['get', 'name'],
                    'text-font': ['Noto Sans Regular'],
                    'text-size': 12,
                    'text-allow-overlap': false,
                },
                paint: {'text-color': '#1b2a38', 'text-halo-color': '#ffffff', 'text-halo-width': 1},
            } :
            {
                id: 'dynamic-stack-break',
                type: 'fill-extrusion',
                source: 'dynamic-draped',
                filter: ['==', ['get', 'kind'], 'draped-fill'],
                paint: {'fill-extrusion-color': '#747474', 'fill-extrusion-height': 12, 'fill-extrusion-opacity': 0.2},
            },
        {
            id: 'dynamic-draped-line',
            type: 'line',
            source: 'dynamic-draped',
            filter: ['==', ['get', 'kind'], 'draped-line'],
            paint: {'line-color': '#374ea2', 'line-width': 2.2, 'line-opacity': 0.7},
        }
    );

    return {
        version: 8,
        glyphs: '/test/integration/assets/glyphs/{fontstack}/{range}.pbf',
        sources: {
            vector: {
                type: 'vector',
                tiles: [`${location.origin}/test/bench/data/785.vector.pbf?id={z}/{x}/{y}`],
                minzoom: 0,
                maxzoom: 14,
            },
            dem: {
                type: 'raster-dem',
                tiles: [`${location.origin}/test/bench/data/terrain_dem.png?id={z}/{x}/{y}`],
                encoding: 'terrarium',
                minzoom: 0,
                maxzoom: 14,
            },
            'dynamic-draped': {
                type: 'geojson',
                data: makeDrapedData(0),
                maxzoom: 14,
            },
            'dynamic-symbols': {
                type: 'geojson',
                data: makeSymbolData(0),
                maxzoom: 14,
            },
        },
        layers,
    };
}

function ceilingWorkload(name: TerrainReplayWorkloadName, description: string): TerrainReplayWorkload {
    return {
        ...WORKLOADS['terrain-mobile-budget'],
        name,
        description,
        includeOcclusionConsumers: false
    };
}

export class TerrainHotRtt extends TerrainReplayV2 {
    constructor() { super(WORKLOADS['terrain-hot-rtt']); }
}

export class TerrainColdRtt extends TerrainReplayV2 {
    constructor() { super(WORKLOADS['terrain-cold-rtt']); }
}

export class TerrainDynamicDrapedSource extends TerrainReplayV2 {
    constructor() { super(WORKLOADS['terrain-dynamic-draped-source']); }
}

export class TerrainDynamicSymbolSource extends TerrainReplayV2 {
    constructor() { super(WORKLOADS['terrain-dynamic-symbol-source']); }
}

export class TerrainCloseGround extends TerrainReplayV2 {
    constructor() { super(WORKLOADS['terrain-close-ground']); }
}

export class TerrainMobileBudget extends TerrainReplayV2 {
    constructor() { super(WORKLOADS['terrain-mobile-budget']); }
}

export class TerrainCeilingBaseline extends TerrainReplayV2 {
    constructor() {
        super(ceilingWorkload(
            'terrain-mobile-budget',
            'Mobile-sized terrain RTT replay using bundled benchmark vector and DEM tiles, without occlusion consumers'
        ));
    }
}

export class TerrainCeilingRtt1024 extends TerrainReplayV2 {
    constructor() {
        super(
            ceilingWorkload(
                'terrain-mobile-budget',
                'Mobile-sized terrain RTT replay capped at 1024 using bundled benchmark vector and DEM tiles, without occlusion consumers'
            ),
            {terrainRenderToTextureMaxSize: 1024}
        );
    }
}

export class TerrainCeilingRtt512 extends TerrainReplayV2 {
    constructor() {
        super(
            ceilingWorkload(
                'terrain-mobile-budget',
                'Mobile-sized terrain RTT replay capped at 512 using bundled benchmark vector and DEM tiles, without occlusion consumers'
            ),
            {terrainRenderToTextureMaxSize: 512}
        );
    }
}
