import type * as MapLibreGL from '../../../dist/maplibre-gl';
import type {ScenarioWindow} from './mlt-lifecycle-page.ts';
import type {MotionSnapshot, Pose} from './mlt-motion-page.ts';

export type ArrivalFrame = {
    arrivals: string[]; time: number; phase: string; moving: boolean; loaded: boolean; tilesLoaded: boolean;
    sourcesLoaded: Record<string, boolean>; clockTime: number; frozen: boolean; clamped: boolean;
    snapshot: MotionSnapshot; pixels: number[];
};
export type ArrivalEvent = {frame: number; time: number; type: string; source?: string; kind?: string; tile?: string; error?: string};
export type ArrivalState = {
    pending: number; renders: number; idle: boolean; moving: boolean; tilesLoaded: boolean; events: ArrivalEvent[];
    barriers: {frame: number; time: number; sourcesLoaded: Record<string, boolean>}[];
};
export type ArrivalDisposal = {pendingAfterRemove: number; canvases: number; clockRestored: boolean; schedulerRestored: boolean};
export type ArrivalWindow = ScenarioWindow & {mltArrival?: {
    begin(encoding: 'mvt' | 'mlt'): void;
    advance(time: number): void;
    delivered(): string[];
    step(time: number, phase: string): Promise<ArrivalFrame>;
    state(): ArrivalState;
    dispose(): ArrivalDisposal;
}};

/** Holds the browser frame scheduler, not the renderer: every callback and camera animation still runs through MapLibre's real code. */
export async function installArrivalClock(origin: string): Promise<void> {
    const gl: typeof MapLibreGL = await import(`${origin}/dist/maplibre-gl.mjs`);
    const scenario = (window as ArrivalWindow).mltScenario;
    const map = scenario.getMap();
    const canvas = map.getCanvas();
    if (!map.loaded() || map.isMoving()) throw new Error('Arrival must begin at a loaded idle pose');
    const request = window.requestAnimationFrame;
    const cancel = window.cancelAnimationFrame;
    const pending = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    let renders = 0;
    let time = 0;
    let phase = 'initial';
    let idle = false;
    let captured: ArrivalFrame;
    const delivered = new Set<string>();
    const events: ArrivalEvent[] = [];
    const barriers: ArrivalState['barriers'] = [];
    window.requestAnimationFrame = callback => { const id = ++nextId; pending.set(id, callback); return id; };
    window.cancelAnimationFrame = id => { pending.delete(id); };
    gl.setNow(1000000);

    function pose(): Pose {
        return {center: map.getCenter().toArray(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(),
            roll: map.getRoll(), elevation: map.getCenterElevation()};
    }

    function onRender(): void {
        const context = canvas.getContext('webgl2');
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        context.readPixels(0, 0, canvas.width, canvas.height, context.RGBA, context.UNSIGNED_BYTE, pixels);
        renders++;
        const snapshot = scenario.geographySnapshot();
        captured = {arrivals: [...delivered].sort(), time, phase, moving: map.isMoving(), loaded: map.loaded(), tilesLoaded: map.areTilesLoaded(),
            clockTime: gl.now(), frozen: gl.isTimeFrozen(), clamped: map.getCenterClampedToGround(),
            sourcesLoaded: Object.fromEntries(Object.keys(map.getStyle().sources).map(id => [id, map.isSourceLoaded(id)])),
            snapshot: {...snapshot, camera: pose(),
                queries: {...snapshot.queries, source: {...snapshot.queries.source,
                    arrival: ['building', 'road'].flatMap(sourceLayer => map.querySourceFeatures('arrival', {sourceLayer})).map(feature => feature.toJSON())}}}, pixels: Array.from(pixels)};
    }

    function onEvent(event: MapLibreGL.MapLibreEvent & Partial<Omit<MapLibreGL.MapSourceDataEvent, 'type'>> & {error?: Error}): void {
        const coord = event.coord;
        if (event.sourceId === 'arrival' && event.type === 'sourcedata' && coord) {
            delivered.add(`${coord.canonical.z}-${coord.canonical.x}-${coord.canonical.y}`);
        }
        events.push({frame: renders, time: gl.now() - 1000000, type: event.type, ...(event.error ? {error: event.error.message} : {}),
            ...(event.sourceId ? {source: event.sourceId, kind: event.sourceDataType,
            ...(coord ? {tile: `${coord.overscaledZ}/${coord.wrap}/${coord.canonical.z}/${coord.canonical.x}/${coord.canonical.y}`} : {})} : {})});
        if (event.type === 'idle') idle = true;
    }

    /** Waits for public source readiness without drawing another frame or advancing logical time. */
    async function resources(): Promise<void> {
        const started = performance.now();
        const before = renders;
        function ready(): boolean {
            return Object.keys(map.getStyle().sources).every(id => id === 'arrival' || map.isSourceLoaded(id));
        }
        while (!ready()) {
            if (performance.now() - started > 20000) throw new Error('Resources did not finish with rendering held');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (renders !== before) throw new Error('An unscheduled render crossed a resource barrier');
        barriers.push({frame: renders, time, sourcesLoaded: Object.fromEntries(Object.keys(map.getStyle().sources).map(id => [id, map.isSourceLoaded(id)]))});
    }

    /** Adds an independently loading four-tile vector source while the existing corpus stays warm and selected. */
    function begin(encoding: 'mvt' | 'mlt'): void {
        if (renders || pending.size || map.isMoving()) throw new Error('Arrivals must start once at a fresh idle pose');
        const corpus = map.getStyle().sources.corpus;
        if (corpus.type !== 'vector') throw new Error('Expected a vector corpus');
        map.addSource('arrival', {...corpus, encoding, tiles: [`${origin}/tiles/${encoding}/{z}-{x}-{y}.${encoding}?arrival=1`]});
        map.addLayer({id: 'arrival-buildings', type: 'fill', source: 'arrival', 'source-layer': 'building', paint: {'fill-color': '#df2688'}});
        map.addLayer({id: 'arrival-roads', type: 'line', source: 'arrival', 'source-layer': 'road', paint: {'line-color': '#6824db', 'line-width': 3}});
        idle = false;
        map.easeTo({bearing: 20, pitch: 25, duration: 2000, essential: true});
    }

    /** Aligns server delivery and MapLibre's clock without drawing or advancing the camera. */
    function advance(timestamp: number): void {
        if (!Number.isFinite(timestamp) || timestamp < time || timestamp > 2000) throw new Error('Invalid arrival timestamp');
        time = timestamp; gl.setNow(1000000 + timestamp);
    }

    async function step(timestamp: number, label: string): Promise<ArrivalFrame> {
        advance(timestamp);
        await resources();
        const callbacks = [...pending.values()];
        if (callbacks.length < 1 || callbacks.length > (renders ? 1 : 2)) throw new Error(`Unexpected browser callbacks: ${callbacks.length}`);
        pending.clear();
        phase = label;
        const before = renders;
        for (const callback of callbacks) callback(1000000 + timestamp);
        if (renders !== before + 1) throw new Error('Expected exactly one render per clock step');
        await resources();
        return captured;
    }

    const types = ['movestart', 'move', 'moveend', 'zoomstart', 'zoomend', 'rotatestart', 'rotateend', 'pitchstart', 'pitchend', 'idle',
        'sourcedataloading', 'sourcedata', 'sourcedataabort', 'error'] as const;
    for (const type of types) map.on(type, onEvent);
    map.on('render', onRender);
    function dispose(): ArrivalDisposal {
        map.stop();
        for (const type of types) map.off(type, onEvent);
        map.off('render', onRender);
        scenario.destroy();
        const pendingAfterRemove = pending.size;
        pending.clear();
        window.requestAnimationFrame = request;
        window.cancelAnimationFrame = cancel;
        gl.restoreNow();
        return {pendingAfterRemove, canvases: document.querySelectorAll('canvas').length, clockRestored: !gl.isTimeFrozen(),
            schedulerRestored: window.requestAnimationFrame === request && window.cancelAnimationFrame === cancel};
    }
    (window as ArrivalWindow).mltArrival = {begin, advance, step, delivered: () => [...delivered].sort(),
        state: () => ({pending: pending.size, renders, idle, moving: map.isMoving(), tilesLoaded: map.areTilesLoaded(), events: [...events], barriers: [...barriers]}), dispose};
}
