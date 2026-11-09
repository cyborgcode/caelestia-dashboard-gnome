import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Dashboard} from './dashboard.js';

// The clock's dropdown already handles opening, closing, input grabs and blocking banners, so the
// dashboard is that same menu with its content swapped. It keeps GNOME's own shape and animation.
export default class CaelestiaDashboardExtension extends Extension {
    enable() {
        const dateMenu = this._dateMenu = Main.panel.statusArea.dateMenu;
        const {menu, _messageList: messageList, _clock: wallClock} = dateMenu;

        // Built first, so that a failure here leaves the clock's own dropdown untouched
        this._dashboard = new Dashboard(messageList._messageView._mediaSource, wallClock);

        // The date menu keeps using its own calendar and list, so they stay around but hidden
        this._originalContent = messageList.get_parent().get_parent();
        this._originalContent.hide();
        menu.box.add_child(this._dashboard);

        // GNOME draws its menus through an offscreen image all the time, so any small change inside, like
        // the bongo cat's paw, would redraw the whole dashboard. Using the image only while the menu fades
        // in and out keeps GNOME's animation and lets a small change redraw only what changed.
        menu._boxPointer.set_offscreen_redirect(Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY);

        this._dashboard.prepareInBackground(menu);
    }

    disable() {
        const {menu} = this._dateMenu;

        menu.close();
        menu._boxPointer.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);

        this._dashboard.destroy();
        this._originalContent.show();

        this._dateMenu = null;
        this._dashboard = null;
        this._originalContent = null;
    }
}
