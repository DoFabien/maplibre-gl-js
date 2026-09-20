import type * as MapLibreGL from '../../../dist/maplibre-gl';

export type Scenario = 'base' | 'symbols' | 'styles' | 'geography';

export type GeographyAction = {
    camera?: 'home' | 'pitched' | 'world' | 'rotated';
    projection?: 'mercator' | 'globe' | 'blend';
    terrain?: null | {source: 'dem-local' | 'dem-world'; exaggeration: number};
    removeDEM?: boolean;
    reloadDEM?: boolean;
};

export type GeographySnapshot = {
    camera: {center: number[]; zoom: number; pitch: number; bearing: number};
    projection: MapLibreGL.ProjectionSpecification;
    globeness: number;
    terrain: MapLibreGL.TerrainSpecification | null;
    elevations: (number | null)[];
    vectorSourcesPreserved: boolean[];
    selectedState: Record<string, unknown>;
    symbolSelectedState: Record<string, unknown>;
    layerCounts: Record<string, number>;
    queries: {source: Record<string, GeoJSON.Feature[]>; rendered: GeoJSON.Feature[]};
};

export type StyleMutation = 'direct' | 'direct-restore' | 'diff' | 'restore' | 'assets' | 'rebuild' | 'encoding' | 'empty';
export type StyleMutationResult = {operation: StyleMutation; sourcePreserved: boolean; sourcePresent: boolean; encoding?: 'mvt' | 'mlt'};

export type CycleResult = {
    timings: Record<string, number>;
    frameIntervals: number[];
    longTasks: number[];
    renderEvents: number;
    sourceResults: number;
    renderedResults: number;
    jsonCharacters: number;
};

export type Checkpoint = {
    sourceCount: number;
    renderedCount: number;
    sourceHash: string;
    renderedHash: string;
    sourceAttributesHash: string;
    renderedAttributesHash: string;
    selectedId: string | number;
    selectedState: Record<string, unknown>;
    sourceJSONKeys: string[];
    renderedJSONKeys: string[];
    symbolSelectedId?: string | number;
    symbolSelectedState?: Record<string, unknown>;
    renderedLayerCounts?: Record<string, number>;
    camera: {center: number[]; zoom: number; pitch: number; bearing: number};
};

export type QuerySample = {queryMs: number; materializeMs: number; stringifyMs: number; count: number; characters: number};

export type RenderObservation = {
    camera: {center: number[]; zoom: number; pitch: number; bearing: number; bounds: number[][]; projectedHome: number[]};
    pixels: number[];
};

export type ScenarioWindow = Window & {
    mltScenario?: {
        getMap(): MapLibreGL.Map;
        getGlobeTransition(): number;
        cycle(animated: boolean): Promise<CycleResult>;
        checkpoint(): Promise<Checkpoint>;
        select(active: boolean): Promise<void>;
        selectSymbol(active: boolean): Promise<void>;
        mutateStyle(operation: StyleMutation): Promise<StyleMutationResult>;
        reload(): Promise<void>;
        visit(index: number): Promise<void>;
        queryJSON(): {source: GeoJSON.Feature[]; rendered: GeoJSON.Feature[]};
        queryBatch(iterations: number): QuerySample[];
        removeSource(): Promise<void>;
        restoreSource(): Promise<void>;
        observeRender(): Promise<RenderObservation>;
        visitWithReadback(index: number): Promise<RenderObservation>;
        isolateLayers(ids: string[]): Promise<void>;
        geography(action: GeographyAction): Promise<void>;
        geographySnapshot(): GeographySnapshot;
        destroy(): void;
    };
};

/** Installs a public-API-only scenario; Puppeteer serializes this entire function into the page. */
export async function installScenario(options: {encoding: 'mvt' | 'mlt'; origin: string; bundle?: string; scenario?: Scenario; interactive?: boolean}): Promise<{
    renderer: string;
    version: string;
    loadMs: number;
    pixelRatio: number;
    devicePixelRatio: number;
    canvas: {width: number; height: number};
}> {
    const gl: typeof MapLibreGL = await import(`${options.origin}/${options.bundle ?? 'dist'}/maplibre-gl.mjs`);
    gl.setWorkerCount(1);
    const home = coordinate(8803, 5375);
    const homeCamera = {center: home, zoom: 14.5, pitch: 0, bearing: 0};
    const cameras = [
        {center: coordinate(8802.75, 5374.75), zoom: 15.25, pitch: 35, bearing: 20},
        {center: coordinate(8803.25, 5375.25), zoom: 15.75, pitch: 45, bearing: -20},
        homeCamera
    ];
    const sourceLayers = ['building', 'road', 'poi_label'];
    const symbols = options.scenario === 'symbols' || options.scenario === 'styles' || options.scenario === 'geography';
    if (symbols) sourceLayers.push('road_label');
    const sourceId = 'corpus';
    let generation = 0;
    const layers: MapLibreGL.LayerSpecification[] = [
        {id: 'land', type: 'fill', source: sourceId, 'source-layer': 'landuse', paint: {'fill-color': '#cdddc2'}},
        {id: 'water', type: 'fill', source: sourceId, 'source-layer': 'water', paint: {'fill-color': '#98c3d9'}},
        {id: 'buildings', type: 'fill', source: sourceId, 'source-layer': 'building', paint: {
            'fill-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#ff2244', '#c5b9ad']
        }},
        {id: 'roads', type: 'line', source: sourceId, 'source-layer': 'road',
            filter: ['all', ['==', ['geometry-type'], 'LineString'], ['>=', ['zoom'], 14]],
            paint: {'line-color': '#faf8f0', 'line-width': ['match', ['get', 'class'], 'main', 4, 2]}},
        {id: 'density', type: 'heatmap', source: sourceId, 'source-layer': 'poi_label', paint: {
            'heatmap-radius': 12, 'heatmap-weight': 0.15, 'heatmap-opacity': 0.3
        }},
        {id: 'pois', type: 'circle', source: sourceId, 'source-layer': 'poi_label', paint: {
            'circle-radius': ['case', ['==', ['get', 'scalerank'], 1], 3, 2], 'circle-color': '#284a67'
        }}
    ];
    if (symbols) layers.push(
        {id: 'street-labels', type: 'symbol', source: sourceId, 'source-layer': 'road_label',
            filter: ['all', ['==', ['geometry-type'], 'LineString'], ['has', 'name']],
            layout: {
                'symbol-placement': 'line', 'symbol-spacing': 250, 'text-field': ['get', 'name'],
                'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'], 'text-size': 12,
                'text-rotation-alignment': 'map', 'text-pitch-alignment': 'map'
            }, paint: {'text-color': '#414141', 'text-halo-color': '#ffffff', 'text-halo-width': 1}},
        {id: 'poi-labels', type: 'symbol', source: sourceId, 'source-layer': 'poi_label',
            filter: ['all', ['has', 'name'], ['<=', ['get', 'localrank'], 5]],
            layout: {
                'text-field': ['get', 'name'], 'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
                'text-size': ['case', ['==', ['get', 'scalerank'], 1], 14, 12],
                'text-offset': [0, 1], 'text-anchor': 'top', 'text-max-width': 10,
                'icon-image': ['match', ['get', 'maki'], 'cafe', 'fav-cafe-18', 'rail-metro', 'fav-rail-metro-18', 'fav-marker-18'],
                'icon-size': 0.8, 'symbol-sort-key': ['get', 'localrank']
            }, paint: {
                'text-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#ff2244', '#163d66'],
                'text-halo-color': '#ffffff', 'text-halo-width': 1,
                'icon-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0.75]
            }}
    );
    const started = performance.now();
    const map = new gl.Map({
        container: 'map', ...homeCamera, attributionControl: false, fadeDuration: 0,
        renderWorldCopies: false, pixelRatio: 1, interactive: options.interactive ?? false,
        ...(symbols ? {localIdeographFontFamily: false as const} : {}),
        style: style()
    });
    const errors: string[] = [];
    map.on('error', event => errors.push(event.error.message));
    await settle();
    let globeness = 0;
    let demGeneration = 0;
    const vectorSources = [map.getSource(sourceId), map.getSource('world')];
    if (options.scenario === 'geography') {
        await settle(() => map.addLayer({id: 'projection-observer', type: 'custom', renderingMode: '2d',
            render(_context, input) { globeness = input.defaultProjectionData.projectionTransition; }}));
    }
    assertCamera(homeCamera);
    const loadMs = performance.now() - started;
    const context = map.getCanvas().getContext('webgl2');
    const debug = context.getExtension('WEBGL_debug_renderer_info');
    const renderer = debug ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL) : context.getParameter(context.RENDERER);
    const candidates = map.queryRenderedFeatures(undefined, {layers: ['buildings']});
    const selectedId = candidates.map(feature => feature.id).filter(id => typeof id === 'number' && Number.isSafeInteger(id))
        .sort((a: number, b: number) => a - b)[0];
    if (selectedId === undefined) throw new Error('No visible building with a safe feature ID');
    const target = {source: sourceId, sourceLayer: 'building', id: selectedId};
    const symbolSelectedId = symbols ? map.queryRenderedFeatures(undefined, {layers: ['poi-labels']})
        .map(feature => feature.id).filter(id => typeof id === 'number' && Number.isSafeInteger(id))
        .sort((a: number, b: number) => a - b)[0] : undefined;
    if (symbols && symbolSelectedId === undefined) throw new Error('No visible POI symbol with a safe feature ID');
    const symbolTarget = {source: sourceId, sourceLayer: 'poi_label', id: symbolSelectedId};

    /** Converts fractional slippy-map coordinates, keeping the trajectory inside the four-tile corpus. */
    function coordinate(x: number, y: number): [number, number] {
        return [x / 16384 * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 16384))) * 180 / Math.PI];
    }

    /** The API-driven benchmark rejects camera drift; real mouse/trackpad gestures are outside this workload. */
    function assertCamera(expected: typeof homeCamera): void {
        const center = map.getCenter();
        const actual = [center.lng, center.lat, map.getZoom(), map.getPitch(), map.getBearing()];
        const values = [...expected.center, expected.zoom, expected.pitch, expected.bearing];
        if (actual.some((value, index) => Math.abs(value - values[index]) > 1e-9)) {
            throw new Error(`Unexpected camera: ${JSON.stringify({actual, expected: values})}`);
        }
    }

    function tileUrl(encoding = options.encoding): string {
        return `${options.origin}/tiles/${encoding}/{z}-{x}-{y}.${encoding}?generation=${generation}`;
    }

    function source(encoding = options.encoding): MapLibreGL.VectorSourceSpecification {
        const westSouth = coordinate(8802, 5376);
        const eastNorth = coordinate(8804, 5374);
        return {
            type: 'vector', encoding, tiles: [tileUrl(encoding)], minzoom: 14, maxzoom: 14,
            bounds: [westSouth[0], westSouth[1], eastNorth[0], eastNorth[1]], promoteId: 'osm_id'
        };
    }

    /** Authored styles share immutable fixtures; variants force fresh property bindings and symbol layout. */
    function style(variant = false, alternateAssets = false, encoding = options.encoding): MapLibreGL.StyleSpecification {
        const result: MapLibreGL.StyleSpecification = {
            version: 8, transition: {duration: 0, delay: 0}, sources: {[sourceId]: source(encoding)},
            ...(symbols ? {
                glyphs: `${options.origin}/${alternateAssets ? 'glyphs-alt' : 'glyphs'}/{fontstack}/{range}.pbf`,
                sprite: `${options.origin}/${alternateAssets ? 'sprites-alt' : 'sprites'}/sprite`
            } : {}),
            layers: [{id: 'background', type: 'background', paint: {'background-color': '#f1eee8'}}, ...structuredClone(layers)]
        };
        if (options.scenario === 'geography') {
            result.projection = {type: 'mercator'};
            result.sources.world = {type: 'vector', encoding: options.encoding, maxzoom: 0,
                tiles: [`${options.origin}/tiles/${options.encoding}/0-0-0.${options.encoding}`]};
            result.layers.push(
                {id: 'world-land', type: 'fill', source: 'world', 'source-layer': 'landcover', maxzoom: 8, paint: {'fill-color': '#a1bd87'}},
                {id: 'world-water', type: 'fill', source: 'world', 'source-layer': 'water', maxzoom: 8, paint: {'fill-color': '#8ab7d1'}},
                {id: 'world-admin', type: 'line', source: 'world', 'source-layer': 'admin', maxzoom: 8,
                    filter: ['==', ['get', 'admin_level'], 2], paint: {'line-color': '#53646d', 'line-width': 1}}
            );
        }
        if (!variant) return result;
        const road = result.layers.find(layer => layer.id === 'roads') as MapLibreGL.LineLayerSpecification;
        road.paint['line-color'] = '#825e36';
        const poi = result.layers.find(layer => layer.id === 'poi-labels') as MapLibreGL.SymbolLayerSpecification;
        poi.layout['text-field'] = ['coalesce', ['get', 'name_en'], ['get', 'name']];
        poi.layout['text-size'] = 15;
        poi.filter = ['all', ['has', 'name'], ['<=', ['get', 'localrank'], 2]];
        return result;
    }

    /** Uses only public setters and source object identity to distinguish diff updates from source replacement. */
    async function mutateStyle(operation: StyleMutation): Promise<StyleMutationResult> {
        if (options.scenario !== 'styles') throw new Error('Style mutations require the styles scenario');
        const previousSource = map.getSource(sourceId);
        const previousStates = previousSource ? [map.getFeatureState(target), map.getFeatureState(symbolTarget)] : [{}, {}];
        const expectedCamera = {center: map.getCenter().toArray(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing()};
        const encoding = operation === 'encoding' ? (options.encoding === 'mlt' ? 'mvt' : 'mlt') : options.encoding;
        const next = style(operation === 'direct' || operation === 'diff', operation === 'assets', encoding);
        if (operation === 'empty') {
            next.sources = {};
            next.layers = next.layers.filter(layer => layer.id === 'background');
        }
        await settle(() => {
            if (operation !== 'direct' && operation !== 'direct-restore') {
                map.setStyle(next, {diff: operation !== 'rebuild'});
                return;
            }
            const road = next.layers.find(layer => layer.id === 'roads') as MapLibreGL.LineLayerSpecification;
            const poi = next.layers.find(layer => layer.id === 'poi-labels') as MapLibreGL.SymbolLayerSpecification;
            map.setPaintProperty(road.id, 'line-color', road.paint['line-color']);
            map.setLayoutProperty(poi.id, 'text-field', poi.layout['text-field']);
            map.setLayoutProperty(poi.id, 'text-size', poi.layout['text-size']);
            map.setFilter(poi.id, poi.filter);
        });
        assertCamera(expectedCamera);
        const currentSource = map.getSource(sourceId);
        const actualEncoding = (map.getStyle().sources[sourceId] as MapLibreGL.VectorSourceSpecification | undefined)?.encoding;
        if (currentSource && actualEncoding !== encoding) throw new Error(`${operation} did not apply encoding ${encoding}`);
        const sourcePreserved = !!previousSource && previousSource === currentSource;
        const mustPreserve = ['direct', 'direct-restore', 'diff', 'assets'].includes(operation);
        if (mustPreserve && !sourcePreserved) throw new Error(`${operation} unexpectedly replaced the source`);
        if (['rebuild', 'encoding', 'empty'].includes(operation) && sourcePreserved) throw new Error(`${operation} retained the old source`);
        const states = currentSource ? [map.getFeatureState(target), map.getFeatureState(symbolTarget)] : [{}, {}];
        if (JSON.stringify(states) !== JSON.stringify(sourcePreserved ? previousStates : [{}, {}])) {
            throw new Error(`${operation} violated feature-state lifecycle: ${JSON.stringify(states)}`);
        }
        if (!currentSource && map.queryRenderedFeatures().length) throw new Error('Features survived removal of all style sources');
        return {operation, sourcePreserved, sourcePresent: !!currentSource, ...(currentSource ? {encoding} : {})};
    }

    /** Waits for a new idle event after every mutation, with an explicit timeout and error checks. */
    async function settle(action?: () => void): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                map.off('idle', done);
                reject(new Error(`Map did not settle: ${errors.join('; ')}`));
            }, 15000);
            function done(): void {
                clearTimeout(timer);
                resolve();
            }
            map.once('idle', done);
            action?.();
            map.triggerRepaint();
        });
        if (errors.length) throw new Error(errors.join('; '));
    }

    async function select(active: boolean): Promise<void> {
        await settle(() => active ? map.setFeatureState(target, {selected: true}) : map.removeFeatureState(target));
        if (Boolean(map.getFeatureState(target).selected) !== active) throw new Error('Feature-state update lost');
    }

    async function selectSymbol(active: boolean): Promise<void> {
        if (!symbols) throw new Error('Symbol selection requires the symbols scenario');
        await settle(() => active ? map.setFeatureState(symbolTarget, {selected: true}) : map.removeFeatureState(symbolTarget));
        if (Boolean(map.getFeatureState(symbolTarget).selected) !== active) throw new Error('Symbol feature-state update lost');
    }

    async function removeSource(): Promise<void> {
        await settle(() => {
            for (const layer of [...layers].reverse()) map.removeLayer(layer.id);
            map.removeSource(sourceId);
        });
        if (map.getSource(sourceId)) throw new Error('Source was not removed');
        if (map.queryRenderedFeatures().length) throw new Error('Rendered features survive source removal');
    }

    async function restoreSource(): Promise<void> {
        generation++;
        await settle(() => {
            map.addSource(sourceId, source());
            for (const layer of layers) map.addLayer(layer);
        });
        if (Object.keys(map.getFeatureState(target)).length) throw new Error('Removed source retained feature-state');
        if (symbols && Object.keys(map.getFeatureState(symbolTarget)).length) throw new Error('Removed source retained symbol feature-state');
    }

    async function reload(): Promise<void> {
        generation++;
        await settle(() => (map.getSource(sourceId) as MapLibreGL.VectorTileSource).setTiles([tileUrl()]));
    }

    async function visit(index: number): Promise<void> {
        await settle(() => map.jumpTo(cameras[index]));
        assertCamera(cameras[index]);
    }

    /** Materializes only public query results, including geometry; no result arrays survive the call. */
    function query(result: CycleResult): void {
        let start = performance.now();
        const sourceFeatures = sourceLayers.flatMap(sourceLayer => map.querySourceFeatures(sourceId, {sourceLayer}));
        result.sourceResults += sourceFeatures.length;
        result.jsonCharacters += JSON.stringify(sourceFeatures.map(feature => feature.toJSON())).length;
        result.timings.sourceJSONMs += performance.now() - start;
        start = performance.now();
        const rendered = map.queryRenderedFeatures();
        result.renderedResults += rendered.length;
        result.jsonCharacters += JSON.stringify(rendered.map(feature => feature.toJSON())).length;
        result.timings.renderedJSONMs += performance.now() - start;
    }

    /** RAF intervals cover camera animations only, not GC, screenshots, queries or source reloads. */
    async function motion(camera: typeof homeCamera, result: CycleResult, animated: boolean): Promise<void> {
        let previous: number;
        let frame: number;
        const observer = new PerformanceObserver(entries => result.longTasks.push(...entries.getEntries().map(entry => entry.duration)));
        function tick(now: number): void {
            if (previous !== undefined) result.frameIntervals.push(now - previous);
            previous = now;
            frame = requestAnimationFrame(tick);
        }
        function rendered(): void { result.renderEvents++; }
        if (animated) {
            observer.observe({type: 'longtask'});
            frame = requestAnimationFrame(tick);
            map.on('render', rendered);
        }
        const start = performance.now();
        try {
            await settle(() => map.easeTo({...camera, duration: animated ? 300 : 0, essential: true}));
            result.timings.motionMs += performance.now() - start;
            assertCamera(camera);
        } finally {
            cancelAnimationFrame(frame);
            map.off('render', rendered);
            result.longTasks.push(...observer.takeRecords().map(entry => entry.duration));
            observer.disconnect();
        }
    }

    async function cycle(animated: boolean): Promise<CycleResult> {
        const result: CycleResult = {
            timings: {motionMs: 0, sourceJSONMs: 0, renderedJSONMs: 0, stateMs: 0, reloadMs: 0, replaceMs: 0},
            frameIntervals: [], longTasks: [], renderEvents: 0, sourceResults: 0, renderedResults: 0, jsonCharacters: 0
        };
        for (const camera of cameras) {
            await motion(camera, result, animated);
            query(result);
        }
        let start = performance.now();
        await select(true);
        if (symbols) await selectSymbol(true);
        result.timings.stateMs = performance.now() - start;
        start = performance.now();
        await reload();
        result.timings.reloadMs = performance.now() - start;
        if (map.getFeatureState(target).selected !== true) throw new Error('Reload lost feature-state');
        if (symbols && map.getFeatureState(symbolTarget).selected !== true) throw new Error('Reload lost symbol feature-state');
        start = performance.now();
        await removeSource();
        await restoreSource();
        result.timings.replaceMs = performance.now() - start;
        return result;
    }

    /** Canonical signatures compare values and geometries, ignoring property and feature iteration order. */
    async function signature(features: MapLibreGL.GeoJSONFeature[], includeGeometry = true): Promise<string> {
        function canonical(_key: string, value: unknown): unknown {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
            return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
        }
        const rows = features.map(feature => JSON.stringify({
            ...feature.toJSON(), geometry: includeGeometry ? feature.geometry : {type: feature.geometry.type}
        }, canonical)).sort();
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows)));
        return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    }

    async function checkpoint(): Promise<Checkpoint> {
        const present = !!map.getSource(sourceId);
        const sourceFeatures = present ? sourceLayers.flatMap(sourceLayer => map.querySourceFeatures(sourceId, {sourceLayer})) : [];
        const rendered = map.queryRenderedFeatures();
        const center = map.getCenter();
        function round(value: number): number { return Math.round(value * 1e9) / 1e9; }
        if ((!sourceFeatures.length || !rendered.length) && (present || options.scenario !== 'styles')) throw new Error('Empty checkpoint');
        const renderedLayerCounts = Object.fromEntries(layers.map(layer => [layer.id, rendered.filter(feature => feature.layer.id === layer.id).length]));
        if (symbols && present && (!renderedLayerCounts['poi-labels'] || !renderedLayerCounts['street-labels'])) {
            throw new Error(`Symbol layers must both be exercised: ${JSON.stringify(renderedLayerCounts)}`);
        }
        return {
            camera: {center: [round(center.lng), round(center.lat)], zoom: round(map.getZoom()),
                pitch: round(map.getPitch()), bearing: round(map.getBearing())},
            sourceCount: sourceFeatures.length, renderedCount: rendered.length,
            sourceHash: await signature(sourceFeatures), renderedHash: await signature(rendered), selectedId,
            sourceAttributesHash: await signature(sourceFeatures, false), renderedAttributesHash: await signature(rendered, false),
            selectedState: present ? map.getFeatureState(target) : {},
            ...(symbols ? {symbolSelectedId, symbolSelectedState: present ? map.getFeatureState(symbolTarget) : {}, renderedLayerCounts} : {}),
            sourceJSONKeys: sourceFeatures.length ? Object.keys(sourceFeatures[0].toJSON()).sort() : [],
            renderedJSONKeys: rendered.length ? Object.keys(rendered[0].toJSON()).sort() : []
        };
    }

    function queryJSON(): {source: GeoJSON.Feature[]; rendered: GeoJSON.Feature[]} {
        return {
            source: map.getSource(sourceId) ? sourceLayers.flatMap(sourceLayer => map.querySourceFeatures(sourceId, {sourceLayer})).map(feature => feature.toJSON()) : [],
            rendered: map.queryRenderedFeatures().map(feature => feature.toJSON())
        };
    }

    /** Separates public rendered-query evaluation, lazy GeoJSON materialization and JSON serialization at a fixed camera. */
    function queryBatch(iterations: number): QuerySample[] {
        const samples: QuerySample[] = [];
        for (let index = 0; index < iterations; index++) {
            const start = performance.now();
            const features = map.queryRenderedFeatures();
            const queried = performance.now();
            const json = features.map(feature => feature.toJSON());
            const materialized = performance.now();
            const characters = JSON.stringify(json).length;
            samples.push({queryMs: queried - start, materializeMs: materialized - queried,
                stringifyMs: performance.now() - materialized, count: features.length, characters});
        }
        return samples;
    }

    function destroy(): void {
        map.remove();
        delete (window as ScenarioWindow).mltScenario;
    }

    function readDrawingBuffer(): number[] {
        const rgba = new Uint8Array(800 * 600 * 4);
        context.readPixels(0, 0, 800, 600, context.RGBA, context.UNSIGNED_BYTE, rgba);
        const error = context.getError();
        if (error !== context.NO_ERROR) throw new Error(`Diagnostic readPixels error ${error}`);
        return Array.from(rgba);
    }

    function renderObservation(pixels: number[]): RenderObservation {
        const projected = map.project(home);
        return {pixels, camera: {center: map.getCenter().toArray(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(),
            bounds: map.getBounds().toArray(), projectedHome: [projected.x, projected.y]}};
    }

    /** Reads the last WebGL frame leading to idle, without requesting a subsequent repaint. */
    async function visitWithReadback(index: number): Promise<RenderObservation> {
        let pixels: number[];
        let error: Error;
        function read(): void {
            try { pixels = readDrawingBuffer(); } catch (caught) { error = caught as Error; }
        }
        map.on('render', read);
        try { await visit(index); } finally { map.off('render', read); }
        if (error) throw error;
        if (!pixels) throw new Error('No frame before idle');
        return renderObservation(pixels);
    }

    /** Reads a requested fresh WebGL frame, before browser screenshot compositing. */
    async function observeRender(): Promise<RenderObservation> {
        const pixels = await new Promise<number[]>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('No diagnostic render event')), 15000);
            map.once('render', () => {
                clearTimeout(timer);
                try { resolve(readDrawingBuffer()); } catch (error) { reject(error); }
            });
            map.triggerRepaint();
        });
        return renderObservation(pixels);
    }

    /** Layer ablation is diagnostic-only; it deliberately changes the displayed workload and is not a parity pass. */
    async function isolateLayers(ids: string[]): Promise<void> {
        await settle(() => {
            for (const layer of map.getStyle().layers) map.setLayoutProperty(layer.id, 'visibility', ids.includes(layer.id) ? 'visible' : 'none');
        });
    }

    /** Keeps vector source identity/state intact while changing projection, DEM lifetime and camera through public APIs. */
    async function geography(action: GeographyAction): Promise<void> {
        if (options.scenario !== 'geography') throw new Error('Geography action requires its dedicated scenario');
        const poses = {home: homeCamera, pitched: cameras[0],
            world: {center: [13.5, 35] as [number, number], zoom: 2.5, pitch: 20, bearing: 15},
            rotated: {center: [-73, 38] as [number, number], zoom: 2.5, pitch: 25, bearing: -25}};
        const expectedCamera = action.camera ? poses[action.camera] : {
            center: map.getCenter().toArray(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing()
        };
        await settle(() => {
            if (action.projection) map.setProjection({type: action.projection === 'blend' ? ['mercator', 'vertical-perspective', 0.5] : action.projection});
            if (action.terrain) {
                const id = action.terrain.source;
                if (!map.getSource(id)) map.addSource(id, id === 'dem-local' ? {
                    type: 'raster-dem', encoding: 'mapbox', tileSize: 256, minzoom: 12, maxzoom: 12,
                    tiles: [demURL(id)], bounds: [...coordinate(8800, 5380), ...coordinate(8808, 5372)]
                } : {type: 'raster-dem', encoding: 'mapbox', tileSize: 256, maxzoom: 0, tiles: [demURL(id)]});
            }
            if ('terrain' in action) map.setTerrain(action.terrain);
            if (action.reloadDEM) {
                const terrain = map.getTerrain();
                if (!terrain) throw new Error('No active DEM to reload');
                demGeneration++;
                (map.getSource(terrain.source) as MapLibreGL.RasterDEMTileSource).setTiles([demURL(terrain.source)]);
            }
            if (action.removeDEM) {
                if (map.getTerrain()) throw new Error('Disable terrain before removing its DEM');
                for (const id of ['dem-local', 'dem-world']) if (map.getSource(id)) map.removeSource(id);
            }
            if (action.camera) map.jumpTo(poses[action.camera]);
        });
        assertCamera(expectedCamera);
    }

    function demURL(id: string): string { return `${options.origin}/${id}/{z}-{x}-{y}.png?generation=${demGeneration}`; }

    /** Captures real projection uniforms and non-flat elevations alongside complete public GeoJSON responses. */
    function geographySnapshot(): GeographySnapshot {
        const rendered = map.queryRenderedFeatures();
        const terrain = map.getTerrain();
        const probes = terrain?.source === 'dem-world' ? [[13.5, 35], [-73, 38], [100, -20]] as [number, number][] :
            [home, coordinate(8802.6, 5374.6), coordinate(8803.4, 5375.4)];
        return {
            camera: {center: map.getCenter().toArray(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing()},
            projection: map.getProjection(), globeness, terrain,
            elevations: probes.map(point => map.queryTerrainElevation(point)),
            vectorSourcesPreserved: [map.getSource(sourceId) === vectorSources[0], map.getSource('world') === vectorSources[1]],
            selectedState: map.getFeatureState(target), symbolSelectedState: map.getFeatureState(symbolTarget),
            layerCounts: Object.fromEntries([...layers.map(layer => layer.id), 'world-land', 'world-water', 'world-admin']
                .map(id => [id, rendered.filter(feature => feature.layer.id === id).length])),
            queries: {source: {
                corpus: sourceLayers.flatMap(sourceLayer => map.querySourceFeatures(sourceId, {sourceLayer})).map(feature => feature.toJSON()),
                world: ['landcover', 'water', 'admin'].flatMap(sourceLayer => map.querySourceFeatures('world', {sourceLayer})).map(feature => feature.toJSON())
            }, rendered: rendered.map(feature => feature.toJSON())}
        };
    }

    (window as ScenarioWindow).mltScenario = {getMap: () => map, getGlobeTransition: () => globeness, cycle, checkpoint, queryJSON, queryBatch, select, selectSymbol, mutateStyle, reload, visit, removeSource, restoreSource, observeRender, visitWithReadback, isolateLayers, geography, geographySnapshot, destroy};
    return {renderer, version: gl.getVersion(), loadMs, pixelRatio: map.getPixelRatio(), devicePixelRatio: window.devicePixelRatio,
        canvas: {width: map.getCanvas().width, height: map.getCanvas().height}};
}
