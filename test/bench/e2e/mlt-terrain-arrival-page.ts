import type * as MapLibreGL from '../../../dist/maplibre-gl';
import type {ScenarioWindow} from './mlt-lifecycle-page.ts';
import type {ArrivalFrame, ArrivalEvent, ArrivalDisposal} from './mlt-arrival-page.ts';
import type {TerrainScene} from './mlt-terrain-arrival-server.ts';

export type TerrainArrivalFrame = ArrivalFrame & {gates: string[]};
export type TerrainArrivalState = {
    pending: number; renders: number; idle: boolean; moving: boolean; tilesLoaded: boolean; events: ArrivalEvent[];
    inflight: Array<{tile: string; resource: string}>;
    barriers: {frame: number; time: number; initializing: string[]; opened: string[];
        inflight: Array<{tile: string; resource: string}>; sourcesLoaded: Record<string, boolean>}[];
};
export type TerrainArrivalWindow = ScenarioWindow & {mltTerrainArrival?: {
    prepare(): void; begin(encoding: 'mvt' | 'mlt'): void; advance(time: number): void; allow(resource: string): void; delivered(): string[];
    step(time: number, phase: string): Promise<TerrainArrivalFrame>; state(): TerrainArrivalState; dispose(): ArrivalDisposal;
}};

/** Records every draw, including globe preparation and partially loaded terrain, with real camera and render callbacks. */
export async function installTerrainArrivalClock(options: {origin: string; vectorOrigin: string; demOrigin: string; scene: TerrainScene}): Promise<void> {
    const {origin, vectorOrigin, demOrigin, scene} = options;
    const gl: typeof MapLibreGL = await import(`${origin}/dist/maplibre-gl.mjs`);
    const scenario = (window as TerrainArrivalWindow).mltScenario; const map = scenario.getMap(); const canvas = map.getCanvas();
    if (!map.loaded() || map.isMoving()) throw new Error('Expected an initially loaded idle map');
    const request = window.requestAnimationFrame; const cancel = window.cancelAnimationFrame;
    const pending = new Map<number, FrameRequestCallback>(); const delivered = new Set<string>(); const initializing = new Set<string>();
    const inflight = new Map<string, string>(); const opened = new Set<string>();
    const events: ArrivalEvent[] = []; const barriers: TerrainArrivalState['barriers'] = [];
    const demId = scene === 'globe-flight' ? 'dem-world' : 'dem-local';
    let nextId = 0; let renders = 0; let time = 0; let phase = 'preparation'; let idle = false; let begun = false;
    let captured: TerrainArrivalFrame;
    window.requestAnimationFrame = callback => { const id = ++nextId; pending.set(id, callback); return id; };
    window.cancelAnimationFrame = id => { pending.delete(id); };
    gl.setNow(1000000);

    function sourceState(): Record<string, boolean> {
        return Object.fromEntries(Object.keys(map.getStyle().sources).map(id => [id, map.isSourceLoaded(id)]));
    }

    function coordinate(x: number, y: number): [number, number] {
        return [x / 16384 * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 16384))) * 180 / Math.PI];
    }

    function onRender(): void {
        const context = canvas.getContext('webgl2'); const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        context.readPixels(0, 0, canvas.width, canvas.height, context.RGBA, context.UNSIGNED_BYTE, pixels); renders++;
        const snapshot = scenario.geographySnapshot();
        const sourceLayers = scene === 'globe-flight' ? ['landcover', 'water', 'admin'] : ['building', 'road'];
        const arrival = map.getSource('arrival') ? sourceLayers.flatMap(sourceLayer => map.querySourceFeatures('arrival', {sourceLayer})).map(feature => feature.toJSON()) : [];
        captured = {arrivals: [...delivered].sort(), gates: [...opened].sort(), time, phase, moving: map.isMoving(), loaded: map.loaded(), tilesLoaded: map.areTilesLoaded(),
            clockTime: gl.now(), frozen: gl.isTimeFrozen(), clamped: map.getCenterClampedToGround(), sourcesLoaded: sourceState(),
            snapshot: {...snapshot, camera: {center: map.getCenter().toArray(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(),
                roll: map.getRoll(), elevation: map.getCenterElevation()}, queries: {...snapshot.queries, source: {...snapshot.queries.source, arrival}}}, pixels: Array.from(pixels)};
    }

    function onEvent(event: MapLibreGL.MapLibreEvent & Partial<Omit<MapLibreGL.MapSourceDataEvent, 'type'>> & {error?: Error}): void {
        const coord = event.coord;
        if (coord && (event.sourceId === 'arrival' || event.sourceId === demId)) {
            const maxzoom = scene === 'globe-flight' ? 0 : event.sourceId === 'arrival' ? 14 : 12;
            const z = Math.min(maxzoom, coord.canonical.z); const scale = 2 ** (coord.canonical.z - z);
            const resource = `${event.sourceId === 'arrival' ? 'vector' : 'dem'}:${z}-${Math.floor(coord.canonical.x / scale)}-${Math.floor(coord.canonical.y / scale)}`;
            const tile = `${event.sourceId}:${coord.overscaledZ}/${coord.wrap}/${coord.canonical.z}/${coord.canonical.x}/${coord.canonical.y}`;
            if (event.type === 'sourcedataloading') inflight.set(tile, resource);
            if (event.type === 'sourcedata' || event.type === 'sourcedataabort') inflight.delete(tile);
            if (event.type === 'sourcedata') delivered.add(resource);
        }
        events.push({frame: renders, time: gl.now() - 1000000, type: event.type, ...(event.error ? {error: event.error.message} : {}),
            ...(event.sourceId ? {source: event.sourceId, kind: event.sourceDataType,
            ...(coord ? {tile: `${coord.overscaledZ}/${coord.wrap}/${coord.canonical.z}/${coord.canonical.x}/${coord.canonical.y}`} : {})} : {})});
        if (event.type === 'idle') idle = true;
    }

    /** Waits only for uncontrolled resources and source metadata, never for a deliberately held tile response. */
    async function resources(after = false): Promise<void> {
        const start = performance.now(); const before = renders;
        function ready(): boolean {
            return ![...inflight.values()].some(resource => opened.has(resource)) &&
                Object.keys(map.getStyle().sources).every(id => initializing.has(id) ? !after || map.getSource(id).loaded() :
                id === 'arrival' || id === demId || map.isSourceLoaded(id));
        }
        while (!ready()) {
            if (performance.now() - start > 20000) throw new Error(`Resource barrier timed out: ${JSON.stringify({renders, phase, sources: sourceState()})}`);
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (renders !== before) throw new Error('Unscheduled render at resource barrier');
        barriers.push({frame: renders, time, initializing: [...initializing], opened: [...opened].sort(),
            inflight: [...inflight].map(([tile, resource]) => ({tile, resource})).sort((a, b) => a.tile.localeCompare(b.tile)), sourcesLoaded: sourceState()});
    }

    function prepare(): void {
        if (renders || pending.size || begun) throw new Error('Preparation may start only once');
        idle = false;
        if (scene === 'globe-flight') {
            map.setProjection({type: 'globe'});
            map.jumpTo({center: [13.5, 35], zoom: 2.5, pitch: 20, bearing: 15});
        } else map.jumpTo({center: coordinate(8803.75, 5375.75), zoom: 14.5, pitch: 45, bearing: 0});
        map.triggerRepaint();
    }

    /** Enables a fresh DEM and visible vector overlay together without replacing the warm sources or resetting terrain caches. */
    function begin(encoding: 'mvt' | 'mlt'): void {
        if (begun || !renders || pending.size || !map.loaded() || map.isMoving()) throw new Error('Expected completed preparation');
        begun = true; idle = false;
        const world = scene === 'globe-flight'; const source = map.getStyle().sources[world ? 'world' : 'corpus'];
        if (source.type !== 'vector') throw new Error('Expected vector source');
        initializing.add('arrival'); initializing.add(demId);
        map.addSource('arrival', {...source, encoding, tiles: [`${vectorOrigin}/tiles/${encoding}/{z}-{x}-{y}.${encoding}?terrain-arrival=1`]});
        map.addLayer({id: 'arrival-fill', type: 'fill', source: 'arrival', 'source-layer': world ? 'landcover' : 'building', paint: {'fill-color': '#df2688'}});
        map.addLayer({id: 'arrival-lines', type: 'line', source: 'arrival', 'source-layer': world ? 'admin' : 'road', paint: {'line-color': '#6824db', 'line-width': 3}});
        map.addSource(demId, {type: 'raster-dem', encoding: 'mapbox', tileSize: 256, maxzoom: world ? 0 : 12,
            ...(world ? {} : {minzoom: 12, bounds: [...coordinate(8800, 5380), ...coordinate(8808, 5372)]}),
            tiles: [`${demOrigin}/${demId}/{z}-{x}-{y}.png?terrain-arrival=1`]});
        map.setTerrain({source: demId, exaggeration: 1});
        if (world) map.flyTo({center: [-73, 38], zoom: 3.25, pitch: 30, bearing: -25, duration: 2000, essential: true});
        else map.easeTo({bearing: 20, pitch: 55, duration: 2000, essential: true});
    }

    function advance(timestamp: number): void {
        if (!Number.isFinite(timestamp) || timestamp < time || timestamp > 2000) throw new Error('Invalid timestamp');
        time = timestamp; gl.setNow(1000000 + time);
    }

    async function step(timestamp: number, label: string): Promise<TerrainArrivalFrame> {
        advance(timestamp); await resources();
        const initialized = [...initializing].filter(id => map.getSource(id).loaded());
        const callbacks = [...pending.values()];
        if (callbacks.length < 1 || callbacks.length > 1 + initializing.size) throw new Error(`Unexpected callbacks: ${callbacks.length}`);
        pending.clear(); phase = label; const before = renders;
        for (const callback of callbacks) callback(1000000 + time);
        for (const id of initialized) initializing.delete(id);
        if (renders !== before + 1) throw new Error('Expected exactly one real render per step');
        await resources(true); return captured;
    }

    const types = ['movestart', 'move', 'moveend', 'zoomstart', 'zoomend', 'rotatestart', 'rotateend', 'pitchstart', 'pitchend', 'idle',
        'sourcedataloading', 'sourcedata', 'sourcedataabort', 'error'] as const;
    for (const type of types) map.on(type, onEvent);
    map.on('render', onRender);
    function dispose(): ArrivalDisposal {
        map.stop(); for (const type of types) map.off(type, onEvent);
        map.off('render', onRender); scenario.destroy(); const pendingAfterRemove = pending.size; pending.clear();
        window.requestAnimationFrame = request; window.cancelAnimationFrame = cancel; gl.restoreNow();
        return {pendingAfterRemove, canvases: document.querySelectorAll('canvas').length, clockRestored: !gl.isTimeFrozen(),
            schedulerRestored: window.requestAnimationFrame === request && window.cancelAnimationFrame === cancel};
    }
    (window as TerrainArrivalWindow).mltTerrainArrival = {prepare, begin, advance, allow: resource => opened.add(resource), step, delivered: () => [...delivered].sort(),
        state: () => ({pending: pending.size, renders, idle, moving: map.isMoving(), tilesLoaded: map.areTilesLoaded(),
            inflight: [...inflight].map(([tile, resource]) => ({tile, resource})), events: [...events], barriers: [...barriers]}), dispose};
}
