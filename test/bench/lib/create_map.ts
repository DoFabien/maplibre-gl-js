import {Map} from '../../../src/ui/map.ts';

function mapErrorEventToError(event: any): Error {
    if (event?.error instanceof Error) return event.error;
    if (event instanceof Error) return event;
    if (event?.error) return new Error(String(event.error));

    const type = event?.type ? ` type=${event.type}` : '';
    const message = event?.message ? ` message=${event.message}` : '';
    return new Error(`Map error event without error payload.${type}${message}`);
}

const createMap = (options: any): Promise<Map> => {
    return new Promise((resolve, reject) => {
        if (options) {
            options.stubRender = options.stubRender == null ? true : options.stubRender;
            options.showMap = options.showMap == null ? false : options.showMap;
        }

        const container = document.createElement('div');
        container.style.width = `${options.width || 512}px`;
        container.style.height = `${options.height || 512}px`;
        container.style.margin = '0 auto';
        container.style.display = 'block';

        if (!options.showMap) {
            container.style.visibility = 'hidden';
        }
        document.body.appendChild(container);

        const map = new Map(Object.assign({
            container,
            style: 'https://tiles.openfreemap.org/styles/liberty'
        }, options));

        map.on(options.idle ? 'idle' : 'load', () => {
            if (options.stubRender) {
                // If there's a pending rerender, cancel it.
                if (map._frameRequest) {
                    map._frameRequest.abort();
                    map._frameRequest = null;
                }
            }
            resolve(map);
        });
        map.on('error', (e) => reject(mapErrorEventToError(e)));
        map.on('remove', () => container.remove());
    });
};

export default createMap;
