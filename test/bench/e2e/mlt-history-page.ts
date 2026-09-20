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
    barriers: {frame: number; time: number; sourcesLoaded: Record<string, boolean>}[];
};
export type HistoryDisposal = {pendingAfterRemove: number; canvases: number; clockRestored: boolean; schedulerRestored: boolean};
export type HistoryWindow = ScenarioWindow & {mltHistory?: {
    begin(method: 'easeTo' | 'flyTo', target: MapLibreGL.CameraOptions): void;
    step(time: number, phase: string): Promise<HistoryFrame>;
    state(): HistoryState;
    dispose(): HistoryDisposal;
}};

/** Holds the browser frame scheduler, not the renderer: every callback and camera animation still runs through MapLibre's real code. */
export async function installHistoryClock(origin: string): Promise<void> {
    const gl: typeof MapLibreGL = await import(`${origin}/dist/maplibre-gl.mjs`);
    const scenario = (window as HistoryWindow).mltScenario;
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
    async function resources(): Promise<void> {
        const started = performance.now();
        const before = renders;
        function ready(): boolean { return map.areTilesLoaded() && Object.keys(map.getStyle().sources).every(id => map.isSourceLoaded(id)); }
        while (!ready()) {
            if (performance.now() - started > 20000) throw new Error('Resources did not finish with rendering held');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (renders !== before) throw new Error('An unscheduled render crossed a resource barrier');
        barriers.push({frame: renders, time, sourcesLoaded: Object.fromEntries(Object.keys(map.getStyle().sources).map(id => [id, map.isSourceLoaded(id)]))});
    }

    function begin(method: 'easeTo' | 'flyTo', target: MapLibreGL.CameraOptions): void {
        if (renders || pending.size || map.isMoving()) throw new Error('History must start once on a fresh idle map');
        idle = false;
        map[method]({...target, duration: 2000, essential: true});
    }

    async function step(timestamp: number, label: string): Promise<HistoryFrame> {
        if (!Number.isFinite(timestamp) || timestamp < time || timestamp > 2000) throw new Error('Invalid history timestamp');
        await resources();
        const callbacks = [...pending.values()];
        if (callbacks.length !== 1) throw new Error(`Expected one pending browser callback, got ${callbacks.length}`);
        pending.clear();
        time = timestamp; phase = label;
        gl.setNow(1000000 + timestamp);
        const before = renders;
        callbacks[0](1000000 + timestamp);
        if (renders !== before + 1) throw new Error('Expected exactly one render per clock step');
        await resources();
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
    (window as HistoryWindow).mltHistory = {begin, step,
        state: () => ({pending: pending.size, renders, idle, moving: map.isMoving(), tilesLoaded: map.areTilesLoaded(), events: [...events], barriers: [...barriers]}), dispose};
}
