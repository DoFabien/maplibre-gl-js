import type * as MapLibreGL from '../../../dist/maplibre-gl';
import type {GeographyAction, GeographySnapshot, ScenarioWindow} from './mlt-lifecycle-page.ts';

export type Pose = {center: [number, number]; zoom: number; pitch: number; bearing: number; roll: number; elevation: number};
export type MotionSnapshot = Omit<GeographySnapshot, 'camera'> & {camera: Pose};
export type Frame = {time: number; camera: Pose; globeness: number; moving: boolean; loaded: boolean};
export type CapturedFrame = {snapshot: MotionSnapshot; pixels: number[]};
export type MotionSpec = {method: 'gesture' | 'easeTo' | 'flyTo'; target?: MapLibreGL.CameraOptions; axis?: 'zoom' | 'bearing'};
export type MotionTrace = {
    events: {type: string; time: number; original?: string; trusted?: boolean}[];
    frames: Frame[];
    samples: (CapturedFrame & {frame: number; landmark: number; progress: number})[];
    transients: (CapturedFrame & {frame: number; landmark: number; progress: number})[];
    final: CapturedFrame;
};
export type MotionWindow = ScenarioWindow & {motionHarness?: {
    prepare(action: GeographyAction, blend: boolean, camera?: MapLibreGL.CameraOptions): Promise<void>;
    pose(): Pose;
    begin(spec: MotionSpec): void;
    end(): Promise<MotionTrace>;
    replay(camera: Pose): Promise<CapturedFrame>;
    dispose(): void;
}};

/** Observes native input and real render events; only setup and reference replays explicitly request a repaint. */
export function installMotionObserver(): void {
    const scenario = (window as MotionWindow).mltScenario;
    const map = scenario.getMap();
    const canvas = map.getCanvas();
    let active: {spec: MotionSpec; start: Pose; started: number; ended: boolean; moved: boolean; idle: boolean;
        trace: MotionTrace; resolve: (trace: MotionTrace) => void; reject: (error: Error) => void; promise: Promise<MotionTrace>; timer: ReturnType<typeof setTimeout>} | undefined;

    function pose(): Pose {
        return {center: map.getCenter().toArray(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(),
            roll: map.getRoll(), elevation: map.getCenterElevation()};
    }

    /** Reads the just-drawn buffer in render, before compositor presentation can discard it. */
    function capture(): CapturedFrame {
        const gl = canvas.getContext('webgl2');
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return {snapshot: {...scenario.geographySnapshot(), camera: pose()}, pixels: Array.from(pixels)};
    }

    function onRender(): void {
        if (!active) return;
        const motion = active;
        const camera = pose();
        const frame = {time: performance.now() - motion.started, camera, globeness: scenario.getGlobeTransition(), moving: map.isMoving(), loaded: map.loaded()};
        motion.trace.frames.push(frame);
        if (!frame.moving && motion.moved) motion.trace.final = capture();
        const {axis, target} = motion.spec;
        if (!axis || motion.trace.samples.length >= 3) return;
        const progress = (camera[axis] - motion.start[axis]) / (target[axis] - motion.start[axis]);
        const landmark = [0.25, 0.5, 0.75][motion.trace.samples.length];
        if (progress < landmark || progress >= 1) return;
        if (!frame.loaded) {
            if (!motion.trace.transients.some(sample => sample.landmark === landmark)) {
                motion.trace.transients.push({...capture(), frame: motion.trace.frames.length - 1, landmark, progress});
            }
            return;
        }
        motion.trace.samples.push({...capture(), frame: motion.trace.frames.length - 1, landmark, progress});
    }

    function complete(): void {
        if (!active?.ended || !active.idle || !active.trace.final || map.isMoving() || !map.loaded()) return;
        const motion = active;
        active = undefined;
        clearTimeout(motion.timer);
        motion.resolve(motion.trace);
    }

    function onMapEvent(event: MapLibreGL.MapLibreEvent & {originalEvent?: Event}): void {
        if (!active) return;
        active.trace.events.push({type: event.type, time: performance.now() - active.started,
            ...(event.originalEvent ? {original: event.originalEvent.type, trusted: event.originalEvent.isTrusted} : {})});
        if (event.type === 'movestart') { active.moved = true; active.idle = false; }
        if (event.type === 'idle' && active.moved) { active.idle = true; complete(); }
    }

    function onInput(event: Event): void {
        if (!active) return;
        active.trace.events.push({type: `input:${event.type}`, time: performance.now() - active.started, trusted: event.isTrusted});
    }

    function begin(spec: MotionSpec): void {
        if (active) throw new Error('A motion is already active');
        let resolve: (trace: MotionTrace) => void;
        let reject: (error: Error) => void;
        const promise = new Promise<MotionTrace>((res, rej) => { resolve = res; reject = rej; });
        void promise.catch(() => {});
        const timer = setTimeout(() => reject(new Error('Motion did not finish at idle')), 20000);
        active = {spec, start: pose(), started: performance.now(), ended: false, moved: false, idle: false,
            trace: {events: [], frames: [], samples: [], transients: [], final: undefined}, resolve, reject, promise, timer};
        if (spec.method !== 'gesture') map[spec.method]({...spec.target, duration: 2000, essential: true});
    }

    async function end(): Promise<MotionTrace> {
        if (!active) throw new Error('No active motion');
        const promise = active.promise;
        active.ended = true;
        complete();
        return promise;
    }

    function idleAfter(action: () => void): Promise<void> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { map.off('idle', done); reject(new Error('Setup/replay did not settle')); }, 20000);
            function done(): void { clearTimeout(timer); resolve(); }
            map.once('idle', done);
            action();
            map.triggerRepaint();
        });
    }

    async function prepare(action: GeographyAction, blend: boolean, camera?: MapLibreGL.CameraOptions): Promise<void> {
        map.setCenterClampedToGround(true);
        await scenario.geography({terrain: null, removeDEM: true, camera: 'home', projection: 'mercator'});
        await scenario.geography(action);
        if (blend) await idleAfter(() => map.setProjection({type: ['interpolate', ['linear'], ['zoom'], 2.5, 'mercator', 3.5, 'vertical-perspective']}));
        if (camera) await idleAfter(() => map.jumpTo(camera));
    }

    /** Locks the reference elevation to the observed pose; the original gesture/animation keeps normal terrain clamping. */
    async function replay(camera: Pose): Promise<CapturedFrame> {
        let result: CapturedFrame;
        function read(): void { result = capture(); }
        map.setCenterClampedToGround(false);
        map.on('render', read);
        try { await idleAfter(() => map.jumpTo(camera)); } finally { map.off('render', read); }
        if (!result) throw new Error('Reference did not render');
        return result;
    }

    const eventTypes = ['movestart', 'move', 'moveend', 'zoomstart', 'zoom', 'zoomend', 'dragstart', 'drag', 'dragend', 'rotatestart', 'rotate', 'rotateend', 'pitchstart', 'pitch', 'pitchend', 'idle'] as const;
    const inputTypes = ['mousedown', 'mousemove', 'mouseup', 'wheel', 'keydown', 'keyup'] as const;
    for (const type of eventTypes) map.on(type, onMapEvent);
    for (const type of inputTypes) canvas.addEventListener(type, onInput, true);
    map.on('render', onRender);
    function dispose(): void {
        if (active) { clearTimeout(active.timer); active.reject(new Error('Motion observer disposed')); active = undefined; }
        for (const type of eventTypes) map.off(type, onMapEvent);
        for (const type of inputTypes) canvas.removeEventListener(type, onInput, true);
        map.off('render', onRender);
    }
    (window as MotionWindow).motionHarness = {prepare, pose, begin, end, replay, dispose};
}
