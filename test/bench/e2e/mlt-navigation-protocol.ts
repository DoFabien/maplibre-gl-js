import type {NavigationPose, NavigationPass} from './mlt-navigation-page.ts';
import {percentile} from '../lib/mlt_benchmark_statistics.ts';

export type NavigationSummary = {
    durationMs: number; motionMs: number; finalSettleMs: number; rafIntervals: number;
    rafP50Ms: number; rafP95Ms: number; rafP99Ms: number; rafMaxMs: number; rafOver33ms: number; rafOver50ms: number;
    longTasks: number; longTaskOverlapMs: number; pendingSourceMs: number; observedRenderMs: number;
    pendingSourceFraction: number; tileLoadsCompleted: number; tileLoadsUnmatched: number;
    tileLoadP50Ms: number | null; tileLoadP95Ms: number | null;
};
export type TileArrivals = {
    completed: {tile: string; started: number; loaded: number; nextRender: number}[];
    unmatched: number;
};

/** Converts an XYZ tile-space position to longitude/latitude without rounding. */
export function coordinate(x: number, y: number, z = 13): [number, number] {
    return [x / 2 ** z * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) * 180 / Math.PI];
}

/** Keeps every requested view inside the real contiguous Dortmund corpus; the final two steps exercise overzoom. */
export const navigationRoute: NavigationPose[] = [
    {name: 'home', center: coordinate(4264.8, 2724), zoom: 13.6, pitch: 0, bearing: 0, duration: 0},
    {name: 'east', center: coordinate(4265.8, 2724.05), zoom: 13.6, pitch: 0, bearing: 0, duration: 2200},
    {name: 'east-end', center: coordinate(4267.1, 2724), zoom: 13.6, pitch: 0, bearing: 0, duration: 2200},
    {name: 'zoom-out', center: coordinate(4266.4, 2724), zoom: 12.6, pitch: 0, bearing: 0, duration: 1800},
    {name: 'west', center: coordinate(4262, 2724), zoom: 12.6, pitch: 0, bearing: 0, duration: 2200},
    {name: 'regional', center: coordinate(4261.6, 2724), zoom: 11.6, pitch: 0, bearing: 0, duration: 1800},
    {name: 'return', center: coordinate(4261.6, 2724), zoom: 12.6, pitch: 0, bearing: 0, duration: 1800},
    {name: 'return-pan', center: coordinate(4264.8, 2724), zoom: 12.6, pitch: 0, bearing: 0, duration: 1800},
    {name: 'close', center: coordinate(4264.8, 2724), zoom: 13.6, pitch: 0, bearing: 0, duration: 2200},
    {name: 'overzoom-pitch', center: coordinate(4264.8, 2724), zoom: 14.4, pitch: 30, bearing: 25, duration: 2000},
    {name: 'home-restored', center: coordinate(4264.8, 2724), zoom: 13.6, pitch: 0, bearing: 0, duration: 1500}
];

/** Aggregates only scheduling intervals wholly inside camera-motion windows; none are GPU or presented-frame times. */
export function summarizePass(pass: NavigationPass): NavigationSummary {
    const intervals = pass.raf.slice(1).flatMap((frame, index) => {
        const previous = pass.raf[index];
        return pass.windows.some(window => previous.t >= window.start && frame.t <= window.end) ? [frame.t - previous.t] : [];
    }).sort((a, b) => a - b);
    const motionMs = pass.windows.reduce((sum, window) => sum + window.end - window.start, 0);
    const longTasks = pass.longTasks.map(task => ({...task, overlap: pass.windows.reduce((sum, window) =>
        sum + Math.max(0, Math.min(task.start + task.duration, window.end) - Math.max(task.start, window.start)), 0)})).filter(task => task.overlap > 0);
    let pendingMs = 0; let observedMs = 0;
    for (let i = 1; i < pass.frames.length; i++) {
        const previous = pass.frames[i - 1]; const frame = pass.frames[i];
        const overlap = pass.windows.reduce((sum, window) => sum + Math.max(0, Math.min(frame.t, window.end) - Math.max(previous.t, window.start)), 0);
        observedMs += overlap; if (!previous.loaded) pendingMs += overlap;
    }
    if (!intervals.length || !observedMs) throw new Error('No observed navigation frames');
    const arrivals = tileArrivals(pass); const latencies = arrivals.completed.map(arrival => arrival.nextRender - arrival.started).sort((a, b) => a - b);
    return {durationMs: pass.finished - pass.started, motionMs, finalSettleMs: pass.finished - pass.stopped,
        rafIntervals: intervals.length, rafP50Ms: percentile(intervals, 0.5), rafP95Ms: percentile(intervals, 0.95),
        rafP99Ms: percentile(intervals, 0.99), rafMaxMs: intervals.at(-1), rafOver33ms: intervals.filter(value => value > 1000 / 30).length,
        rafOver50ms: intervals.filter(value => value > 50).length,
        longTasks: longTasks.length, longTaskOverlapMs: longTasks.reduce((sum, task) => sum + task.overlap, 0),
        pendingSourceMs: pendingMs, observedRenderMs: observedMs, pendingSourceFraction: pendingMs / observedMs,
        tileLoadsCompleted: latencies.length, tileLoadsUnmatched: arrivals.unmatched,
        tileLoadP50Ms: latencies.length ? percentile(latencies, 0.5) : null,
        tileLoadP95Ms: latencies.length ? percentile(latencies, 0.95) : null};
}

/** Pairs public tile-load events, including overzoom preparation; next render is a submission proxy, not proof of visible pixels. */
export function tileArrivals(pass: NavigationPass): TileArrivals {
    const pending = new Map<string, number[]>();
    const completed: {tile: string; started: number; loaded: number; nextRender: number}[] = [];
    let unmatched = 0;
    for (const event of pass.data) {
        if (!event.tile) continue;
        const key = `${event.overscaledZ}:${event.tile}`;
        const queue = pending.get(key) ?? [];
        if (event.kind === 'dataloading') { queue.push(event.t); pending.set(key, queue); continue; }
        if (event.kind !== 'sourcedata' || !queue.length) continue;
        const started = queue.shift();
        const rendered = pass.frames.find(frame => frame.t >= event.t);
        if (rendered) completed.push({tile: event.tile, started, loaded: event.t, nextRender: rendered.t});
        else unmatched++;
    }
    return {completed, unmatched: unmatched + [...pending.values()].reduce((sum, values) => sum + values.length, 0)};
}
