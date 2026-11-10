import GLib from 'gi://GLib';

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

// How often the pointer is checked while it's over an icon, in milliseconds
const POLL_INTERVAL = 20;
// Moving less than this between checks, in pixels, counts as stopping
const SETTLE_DISTANCE = 3;
// After this long on an icon, its menu opens even if the pointer is still moving, in milliseconds
const MAX_DELAY = 150;

function isPointerOver(actor, x, y) {
    const [left, top] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return x >= left && x < left + width && y >= top && y < top + height;
}

// While a top-bar menu is open, GNOME opens the menu of every icon the pointer enters, so sweeping
// from the clock to Quick Settings flashes each menu on the way. This waits until the pointer stops
// on an icon. Moving between menus with the keyboard still switches straight away.
export class MenuSwitchDelay {
    constructor(manager) {
        this._manager = manager;
        this._injections = new InjectionManager();

        const delay = this;
        this._injections.overrideMethod(manager, '_changeMenu', changeMenu => function (menu) {
            // GNOME also switches when the keyboard moves focus onto another icon
            const focus = global.stage.get_key_focus();
            const fromKeyboard = !!focus && !!menu.sourceActor?.contains(focus);
            if (this.activeMenu && !fromKeyboard) {
                delay._waitForPointer(menu, () => changeMenu.call(this, menu));
            } else {
                delay._cancel();
                changeMenu.call(this, menu);
            }
        });
    }

    _waitForPointer(menu, switchMenu) {
        // An icon is made of several actors, and the pointer entering each one says so again
        if (this._pendingMenu === menu)
            return;

        this._cancel();
        this._pendingMenu = menu;

        let [lastX, lastY] = global.get_pointer();
        let waited = 0;
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL, () => {
            const [x, y] = global.get_pointer();
            waited += POLL_INTERVAL;

            const source = menu.sourceActor;
            if (!this._manager.activeMenu || !source?.mapped || !isPointerOver(source, x, y)) {
                this._clearPending();
                return GLib.SOURCE_REMOVE;
            }

            if (Math.hypot(x - lastX, y - lastY) > SETTLE_DISTANCE && waited < MAX_DELAY) {
                [lastX, lastY] = [x, y];
                return GLib.SOURCE_CONTINUE;
            }

            this._clearPending();
            switchMenu();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearPending() {
        delete this._pollId;
        delete this._pendingMenu;
    }

    _cancel() {
        if (this._pollId)
            GLib.source_remove(this._pollId);
        this._clearPending();
    }

    destroy() {
        this._cancel();
        this._injections.clear();
    }
}
