'use strict';
/**
 * Waze Cards - the switch and settings for the wazecard service.
 *
 * The kit saves the settings in this app's data/settings.json; the wazecard service (root, on the
 * head unit) reads that file and follows it within a couple of seconds. This app draws nothing on the
 * cluster itself: it is the place in iDrive to change what the service does.
 */
const mgu = require('./kit/mgu');

const MODE = { cards: 'cards over the cluster', map: "Waze's map in the cluster's map area" };

mgu.run({
    async start(ctx) {
        const { ui, settings } = ctx;
        const show = () => {
            const info = settings.get('enabled') === false
                ? 'Off: nothing is drawn on the cluster'
                : `On: ${MODE[settings.get('mode')] || MODE.cards}, while Waze guides on the central screen`;
            ui.text('MENU_INFO', info);
        };
        settings.onChange(show);
        ui.onVisible((name, on) => { if (name === 'MAIN' && on) show(); });
        show();
    },
});
