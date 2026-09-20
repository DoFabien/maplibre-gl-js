import type * as MapLibreGL from '../../../dist/maplibre-gl';
import type {ScenarioWindow} from './mlt-lifecycle-page.ts';
import type {MotionSnapshot, Pose} from './mlt-motion-page.ts';

export type HistoryFrame = {
    time: number; phase: string; moving: boolean; loaded: boolean; tilesLoaded: boolean;
    sourcesLoaded: Record<string, boolean>; clockTime: number; frozen: boolean; clamped: boolean;
    snapshot: MotionSnapshot; pixels: number[];
};
export type HistoryEvent = {frame: number; type: string; source?: string; kind?: string; tile?: string; error?: string};
export type HistoryState = {
    pending: number; renders: number; idle: boolean; moving: boolean; tilesLoaded: boolean; events: HistoryEvent[];
    barriers: {frame: number; time: number; sourcesLoaded: Record<string, boolean>; initializing?: string[]}[];
};
export type HistoryDisposal = {pendingAfterRemove: number; canvases: number; clockRestored: boolean; schedulerRestored: boolean};
export type WarmWindow = ScenarioWindow & {mltWarm?: {
    prepare(stage: 'world' | 'configure' | 'excursion' | 'return', options: {blend?: boolean; startZoom?: number; terrain: boolean}): void;
    begin(method: 'easeTo' | 'flyTo', target: MapLibreGL.CameraOptions): void;
    step(time: number, phase: string): Promise<HistoryFrame>;
    state(): HistoryState;
    dispose(): HistoryDisposal;
}};

/** Holds the browser frame scheduler, not the renderer: every callback and camera animation still runs through MapLibre's real code. */
export async function installWarmClock(origin: string): Promise<void> {
    const gl: typeof MapLibreGL = await import(`${origin}/dist/maplibre-gl.mjs`);
    const scenario = (window as WarmWindow).mltScenario;
    const map = scenario.getMap();
    const canvas = map.getCanvas();
    if (!map.loaded() || map.isMoving()) throw new Error('History must begin at a loaded idle pose');
    const request = window.requestAnimationFrame;
    const cancel = window.cancelAnimationFrame;
    const pending = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    let renders = 0;
    let time = 0;
    let phase = 'initial';
    let idle = false;
    let started = false;
    const initializing = new Set<string>();
    let captured: HistoryFrame;
    const events: HistoryEvent[] = [];
    const barriers: HistoryState['barriers'] = [];
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
        captured = {time, phase, moving: map.isMoving(), loaded: map.loaded(), tilesLoaded: map.areTilesLoaded(),
            clockTime: gl.now(), frozen: gl.isTimeFrozen(), clamped: map.getCenterClampedToGround(),
            sourcesLoaded: Object.fromEntries(Object.keys(map.getStyle().sources).map(id => [id, map.isSourceLoaded(id)])),
            snapshot: {...scenario.geographySnapshot(), camera: pose()}, pixels: Array.from(pixels)};
    }

    function onEvent(event: MapLibreGL.MapLibreEvent & Partial<Omit<MapLibreGL.MapSourceDataEvent, 'type'>> & {error?: Error}): void {
        const coord = event.coord;
        events.push({frame: renders, type: event.type, ...(event.error ? {error: event.error.message} : {}),
            ...(event.sourceId ? {source: event.sourceId, kind: event.sourceDataType,
            ...(coord ? {tile: `${coord.overscaledZ}/${coord.wrap}/${coord.canonical.z}/${coord.canonical.x}/${coord.canonical.y}`} : {})} : {})});
        if (event.type === 'idle') idle = true;
    }

    /** Waits for public source readiness without drawing another frame or advancing logical time. */
    async function resources(after = false): Promise<void> {
        const started = performance.now();
        const before = renders;
        function ready(): boolean {
            return Object.keys(map.getStyle().sources).every(id => initializing.has(id) ? !after || map.getSource(id).loaded() : map.isSourceLoaded(id));
        }
        while (!ready()) {
            if (performance.now() - started > 20000) throw new Error(`Resources did not finish: ${JSON.stringify({renders, phase,
                initializing: [...initializing], sources: Object.fromEntries(Object.keys(map.getStyle().sources).map(id => [id,
                    {tiles: map.isSourceLoaded(id), source: map.getSource(id).loaded()}])), events: events.slice(-12)})}`);
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (renders !== before) throw new Error('An unscheduled render crossed a resource barrier');
        barriers.push({frame: renders, time, ...(initializing.size ? {initializing: [...initializing]} : {}),
            sourcesLoaded: Object.fromEntries(Object.keys(map.getStyle().sources).map(id => [id, map.isSourceLoaded(id)]))});
    }

    /** Warms and revisits real source caches through camera/projection APIs; never reloads or replaces a vector source. */
    function prepare(stage: 'world' | 'configure' | 'excursion' | 'return', options: {blend?: boolean; startZoom?: number; terrain: boolean}): void {
        if (started || pending.size || map.isMoving() || !map.loaded()) throw new Error('Preparation requires a loaded idle pose');
        idle = false;
        const camera = {center: [13.5, 35] as [number, number], zoom: options.startZoom ?? 2.5, pitch: 20, bearing: 15};
        if (stage === 'world') {
            map.setProjection({type: 'mercator'});
            map.jumpTo({...camera, zoom: 2.5});
        }
        if (stage === 'configure') {
            map.setProjection({type: options.blend ? ['interpolate', ['linear'], ['zoom'], 2.5, 'mercator', 3.5, 'vertical-perspective'] : 'globe'});
            if (options.terrain) {
                initializing.add('dem-world');
                map.addSource('dem-world', {type: 'raster-dem', encoding: 'mapbox', tileSize: 256, maxzoom: 0,
                    tiles: [`${origin}/dem-world/0-0-0.png?generation=0`]});
                map.setTerrain({source: 'dem-world', exaggeration: 1});
            }
            map.jumpTo(camera);
        }
        if (stage === 'excursion') map.jumpTo({center: [-73, 38], zoom: options.startZoom === 3.5 ? 2.5 : 3.5, pitch: 25, bearing: -25});
        if (stage === 'return') map.jumpTo(camera);
        map.triggerRepaint();
    }

    function begin(method: 'easeTo' | 'flyTo', target: MapLibreGL.CameraOptions): void {
        if (started || !renders || pending.size || map.isMoving() || !map.loaded()) throw new Error('Animation requires its completed warm preparation');
        started = true;
        idle = false;
        map[method]({...target, duration: 2000, essential: true});
    }

    async function step(timestamp: number, label: string): Promise<HistoryFrame> {
        if (!Number.isFinite(timestamp) || timestamp < time || timestamp > 2000) throw new Error('Invalid history timestamp');
        await resources();
        const initializedBeforeDraw = [...initializing].filter(id => map.getSource(id).loaded());
        const callbacks = [...pending.values()];
        if (callbacks.length < 1 || callbacks.length > 1 + initializing.size) throw new Error(`Unexpected browser callbacks: ${callbacks.length}`);
        pending.clear();
        time = timestamp; phase = label;
        gl.setNow(1000000 + timestamp);
        const before = renders;
        for (const callback of callbacks) callback(1000000 + timestamp);
        for (const id of initializedBeforeDraw) initializing.delete(id);
        if (renders !== before + 1) throw new Error('Expected exactly one render per clock step');
        await resources(true);
        return captured;
    }

    const types = ['movestart', 'move', 'moveend', 'zoomstart', 'zoomend', 'rotatestart', 'rotateend', 'pitchstart', 'pitchend', 'idle',
        'sourcedataloading', 'sourcedata', 'sourcedataabort', 'error'] as const;
    for (const type of types) map.on(type, onEvent);
    map.on('render', onRender);
    function dispose(): HistoryDisposal {
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
    (window as WarmWindow).mltWarm = {prepare, begin, step,
        state: () => ({pending: pending.size, renders, idle, moving: map.isMoving(), tilesLoaded: map.areTilesLoaded(), events: [...events], barriers: [...barriers]}), dispose};
}
