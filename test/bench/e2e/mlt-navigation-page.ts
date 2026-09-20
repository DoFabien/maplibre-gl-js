import type * as MapLibreGL from '../../../src/index.ts';

export type NavigationPose = {name: string; center: [number, number]; zoom: number; pitch: number; bearing: number; duration: number};
export type NavigationOptions = {origin: string; encoding: 'mvt' | 'mlt'; bundle: string; route: NavigationPose[]; parity: boolean};
export type NavigationFrame = {t: number; moving: boolean; loaded: boolean};
export type NavigationPass = {
    started: number; stopped: number; finished: number; frames: NavigationFrame[]; raf: {t: number; moving: boolean}[];
    longTasks: {start: number; duration: number}[]; windows: {name: string; start: number; end: number; pose: number[]}[];
    data: {t: number; kind: string; tile?: string; overscaledZ?: number; sourceDataType?: string}[]; visibility: string[];
};
export type NavigationCheckpoint = {
    pixels: number[]; width: number; height: number; pose: number[]; rendered: GeoJSON.Feature[];
    sources: Record<string, GeoJSON.Feature[]>; labelCounts: Record<string, number>;
};
export type NavigationAPI = {
    info: {
        created: number; firstLoadedDrawMs: number; idleMs: number; renderer: string; workerCount: number;
        pixelRatio: number; canvas: number[]; version: string; errors: string[]; style: MapLibreGL.StyleSpecification;
    };
    run: () => Promise<NavigationPass>;
    checkpoint: (index: number) => Promise<NavigationCheckpoint>;
    destroy: () => void;
};
export type NavigationWindow = Window & {navigationBench: NavigationAPI};

/** Replays a real-time camera journey, retaining ordinary renderer caches and label fades without querying features. */
export async function installNavigation(options: NavigationOptions): Promise<NavigationAPI> {
    const gl: typeof MapLibreGL = await import(`${options.origin}/${options.bundle}/maplibre-gl.mjs`);
    const route = options.route; const initial = route[0];
    const errors: string[] = [];
    const font = ['Open Sans Semibold', 'Arial Unicode MS Bold'];
    const source = 'corpus';
    const text = ['coalesce', ['get', 'name:latin'], ['get', 'name'], ['get', 'ref'], ''];
    const style = {
        version: 8, glyphs: `${options.origin}/glyphs/{fontstack}/{range}.pbf`, sprite: `${options.origin}/sprites/sprite`,
        sources: {[source]: {type: 'vector', encoding: options.encoding, tiles: [`${options.origin}/tiles/${options.encoding}/{z}-{x}-{y}.${options.encoding}`], minzoom: 10, maxzoom: 13}},
        layers: [
            {id: 'background', type: 'background', paint: {'background-color': '#f3f0e9'}},
            {id: 'landcover', type: 'fill', source, 'source-layer': 'landcover', paint: {'fill-color': '#dce6ce'}},
            {id: 'landuse', type: 'fill', source, 'source-layer': 'landuse', paint: {'fill-color': '#e3e0d8'}},
            {id: 'parks', type: 'fill', source, 'source-layer': 'park', paint: {'fill-color': '#c8dfb5'}},
            {id: 'water', type: 'fill', source, 'source-layer': 'water', paint: {'fill-color': '#9dcadd'}},
            {id: 'waterways', type: 'line', source, 'source-layer': 'waterway', paint: {'line-color': '#9dcadd', 'line-width': 1.5}},
            {id: 'buildings', type: 'fill', source, 'source-layer': 'building', minzoom: 13, paint: {'fill-color': '#cfc4b5', 'fill-outline-color': '#b8aa98'}},
            {id: 'road-casing', type: 'line', source, 'source-layer': 'transportation', filter: ['!=', ['get', 'class'], 'rail'],
                paint: {'line-color': '#c9bfae', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 14, 5, 16, 10]}},
            {id: 'roads', type: 'line', source, 'source-layer': 'transportation', filter: ['!=', ['get', 'class'], 'rail'],
                paint: {'line-color': ['match', ['get', 'class'], ['motorway', 'trunk'], '#f0cc85', '#ffffff'],
                    'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 14, 3, 16, 8]}},
            {id: 'rail', type: 'line', source, 'source-layer': 'transportation', filter: ['==', ['get', 'class'], 'rail'],
                paint: {'line-color': '#8c8b88', 'line-width': 1, 'line-dasharray': [3, 2]}},
            {id: 'road-labels', type: 'symbol', source, 'source-layer': 'transportation_name',
                layout: {'symbol-placement': 'line', 'text-field': text, 'text-font': font, 'text-size': 12, 'symbol-spacing': 250},
                paint: {'text-color': '#55514b', 'text-halo-color': '#ffffff', 'text-halo-width': 1}},
            {id: 'poi-labels', type: 'symbol', source, 'source-layer': 'poi', minzoom: 12,
                layout: {'text-field': text, 'text-font': font, 'text-size': 11, 'text-anchor': 'top', 'text-offset': [0, 1],
                    'icon-image': 'fav-marker-18', 'icon-size': 0.65, 'symbol-sort-key': ['coalesce', ['get', 'rank'], 100]},
                paint: {'text-color': '#546f7c', 'text-halo-color': '#ffffff', 'text-halo-width': 1}},
            {id: 'places', type: 'symbol', source, 'source-layer': 'place',
                layout: {'text-field': text, 'text-font': font, 'text-size': ['match', ['get', 'class'], 'city', 18, 'town', 15, 12],
                    'symbol-sort-key': ['coalesce', ['get', 'rank'], 100]},
                paint: {'text-color': '#4a4742', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5}}
        ]
    } as MapLibreGL.StyleSpecification;
    const created = performance.now();
    const map = new gl.Map({container: 'map', ...initial, style, attributionControl: false, renderWorldCopies: false,
        pixelRatio: 1, interactive: false, localIdeographFontFamily: false, ...(options.parity ? {fadeDuration: 0} : {})});
    map.on('error', event => errors.push(event.error.message));
    let firstLoadedDraw: number | undefined;
    function loadedDraw(): void { if (map.loaded()) firstLoadedDraw ??= performance.now(); }
    map.on('render', loadedDraw);
    await idle();
    map.off('render', loadedDraw);
    const context = map.getCanvas().getContext('webgl2');
    const debug = context.getExtension('WEBGL_debug_renderer_info');
    const info = {created, firstLoadedDrawMs: firstLoadedDraw - created, idleMs: performance.now() - created,
        renderer: context.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : context.RENDERER),
        workerCount: gl.getWorkerCount(), pixelRatio: map.getPixelRatio(), canvas: [map.getCanvas().width, map.getCanvas().height],
        version: gl.getVersion(), errors, style};

    /** Waits for the public idle event with an explicit failure deadline; no frame is forced. */
    async function idle(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { map.off('idle', done); reject(new Error(`Navigation idle timeout: ${errors.join('; ')}`)); }, 45000);
            function done(): void { clearTimeout(timer); resolve(); }
            map.once('idle', done);
        });
        if (errors.length) throw new Error(errors.join('; '));
    }

    /** Deliberate dwell emulates a short reading pause; it never waits for tile availability mid-journey. */
    function dwell(): Promise<void> { return new Promise(resolve => setTimeout(resolve, 300)); }

    /** Preserves full observed poses so route equality is checked independently of frame scheduling. */
    function pose(): number[] { return [...map.getCenter().toArray(), map.getZoom(), map.getPitch(), map.getBearing()]; }

    /** Records RAF scheduling and render submissions, not physical display presentation or GPU execution durations. */
    async function run(): Promise<NavigationPass> {
        const result: NavigationPass = {started: performance.now(), stopped: 0, finished: 0, frames: [], raf: [], longTasks: [], windows: [], data: [], visibility: [document.visibilityState]};
        let frame: number;
        function tick(t: number): void { result.raf.push({t, moving: map.isMoving()}); frame = requestAnimationFrame(tick); }
        function render(): void { result.frames.push({t: performance.now(), moving: map.isMoving(), loaded: map.isSourceLoaded(source)}); }
        function data(event): void {
            if (event.sourceId !== source) return;
            const id = event.coord?.canonical;
            result.data.push({t: performance.now(), kind: event.type, sourceDataType: event.sourceDataType,
                tile: id ? `${id.z}-${id.x}-${id.y}` : undefined, overscaledZ: event.coord?.overscaledZ});
        }
        function visibility(): void { result.visibility.push(document.visibilityState); }
        const observer = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) result.longTasks.push({start: entry.startTime, duration: entry.duration});
        });
        observer.observe({type: 'longtask'});
        document.addEventListener('visibilitychange', visibility);
        map.on('render', render); map.on('dataloading', data); map.on('sourcedata', data);
        frame = requestAnimationFrame(tick);
        try {
            for (const target of route.slice(1)) {
                const start = performance.now();
                await new Promise<void>(resolve => {
                    map.once('moveend', () => resolve());
                    map.easeTo({...target, essential: true});
                });
                result.windows.push({name: target.name, start, end: performance.now(), pose: pose()});
                if (target === route[route.length - 1]) result.stopped = performance.now();
                else await dwell();
            }
            if (!map.loaded()) await idle();
            result.finished = performance.now();
            for (const entry of observer.takeRecords()) result.longTasks.push({start: entry.startTime, duration: entry.duration});
            if (errors.length) throw new Error(errors.join('; '));
            return result;
        } finally {
            cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener('visibilitychange', visibility);
            map.off('render', render); map.off('dataloading', data); map.off('sourcedata', data);
        }
    }

    /** Runs only in a separate correctness process, after all timing work has been excluded. */
    async function checkpoint(index: number): Promise<NavigationCheckpoint> {
        if (!options.parity) throw new Error('Queries and readback are forbidden in navigation timing sessions');
        const settled = idle(); map.jumpTo(route[index]); await settled;
        let pixels: number[];
        function read(): void {
            const bytes = new Uint8Array(context.drawingBufferWidth * context.drawingBufferHeight * 4);
            context.readPixels(0, 0, context.drawingBufferWidth, context.drawingBufferHeight, context.RGBA, context.UNSIGNED_BYTE, bytes);
            pixels = Array.from(bytes);
        }
        map.once('render', read); const repainted = idle(); map.triggerRepaint(); await repainted;
        const rendered = map.queryRenderedFeatures().map(feature => feature.toJSON());
        const sourceLayers = [...new Set(style.layers.map(layer => layer['source-layer']).filter(Boolean))];
        const sources = Object.fromEntries(sourceLayers.map(sourceLayer => [sourceLayer,
            map.querySourceFeatures(source, {sourceLayer}).map(feature => feature.toJSON())]));
        return {pixels, width: context.drawingBufferWidth, height: context.drawingBufferHeight, pose: pose(), rendered, sources,
            labelCounts: Object.fromEntries(['road-labels', 'poi-labels', 'places'].map(id => [id, map.queryRenderedFeatures(undefined, {layers: [id]}).length]))};
    }
    const api: NavigationAPI = {info, run, checkpoint, destroy: () => map.remove()};
    (window as unknown as NavigationWindow).navigationBench = api;
    return api;
}
