import {MltTileData, equalMltPayload, mltPayloadKey} from './mlt_tile_data.ts';

import type {IActor} from '../util/actor.ts';

export type MltParentReference = {id: number; data: MltTileData};
type ActorParents = {keys: Map<string, {id: number; data: WeakRef<MltTileData>}>; ids: Map<number, WeakRef<MltTileData>>};

/**
 * Source-owned weak directory: live tiles own parent data, never this lookup cache.
 * In-flight callers retain their candidate strongly, so eviction/abort cannot invalidate an omitted payload.
 * Actor-scoped version IDs prevent mixing versions across workers; exact content can share decode data across actors.
 */
export class MltParentRegistry {
    private actors = new WeakMap<IActor, ActorParents>();
    private contents = new Map<string, WeakRef<MltTileData>>();

    get(actor: IActor, key: string): MltParentReference | undefined {
        const candidate = this.actors.get(actor)?.keys.get(key);
        const data = candidate?.data.deref();
        return data ? {id: candidate.id, data} : undefined;
    }

    receive(actor: IActor, key: string, id: number, rawData?: ArrayBuffer, retained?: MltParentReference): MltParentReference {
        let owner = this.actors.get(actor);
        if (!owner) { owner = {keys: new Map(), ids: new Map()}; this.actors.set(actor, owner); }
        let data = id === retained?.id ? retained.data : owner.ids.get(id)?.deref();
        if (data && rawData && !equalMltPayload(data.rawData, rawData)) throw new Error('MLT parent version changed its payload');
        if (!data) {
            if (!rawData) throw new Error('Missing retained MLT parent payload');
            const contentKey = mltPayloadKey(rawData);
            const shared = this.contents.get(contentKey)?.deref();
            data = shared && equalMltPayload(shared.rawData, rawData) ? shared : new MltTileData(rawData);
            boundedSet(this.contents, contentKey, new WeakRef(data));
        }
        const weak = new WeakRef(data);
        boundedSet(owner.ids, id, weak); boundedSet(owner.keys, key, {id, data: weak});
        return {id, data};
    }

    clear(): void { this.actors = new WeakMap(); this.contents.clear(); }
}

/** Bounds dead weak-reference metadata without retaining or evicting live parent data. */
function boundedSet<K, V>(map: Map<K, V>, key: K, value: V): void {
    map.delete(key); map.set(key, value);
    if (map.size > 256) map.delete(map.keys().next().value);
}
