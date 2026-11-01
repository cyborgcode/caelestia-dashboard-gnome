import Clutter from 'gi://Clutter';

import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Dashboard, PanelEar} from './dashboard.js';

// How long the dashboard takes to slide in and out, in milliseconds
const OPEN_DURATION = 260;
const CLOSE_DURATION = 180;
const SLIDE_MODE = Clutter.AnimationMode.EASE_OUT_CUBIC;

// The clock's dropdown already handles opening, closing, input grabs and blocking banners, so the
// dashboard is that same menu with its content swapped and its animation replaced by a slide out
// from behind the top bar.
export default class CaelestiaDashboardExtension extends Extension {
    enable() {
        const dateMenu = this._dateMenu = Main.panel.statusArea.dateMenu;
        const {menu, _messageList: messageList, _clock: wallClock} = dateMenu;
        const boxPointer = menu._boxPointer;
        const {uiGroup, panelBox} = Main.layoutManager;

        // Built first, so that a failure here leaves the clock's own dropdown untouched
        this._dashboard = new Dashboard(messageList._messageView._mediaSource, wallClock);
        this._ears = [new PanelEar(Clutter.ActorAlign.END), new PanelEar(Clutter.ActorAlign.START)];

        // The date menu keeps using its own calendar and list, so they stay around but hidden
        this._originalContent = messageList.get_parent().get_parent();
        this._originalContent.hide();

        menu.box.orientation = Clutter.Orientation.HORIZONTAL;
        menu.box.add_child(this._ears[0]);
        menu.box.add_child(this._dashboard);
        menu.box.add_child(this._ears[1]);

        boxPointer.add_style_class_name('cd-popup');

        this._dashboard.prepareInBackground(menu);

        // Opening raises the menu above everything, so it has to go back behind the top bar each time
        menu.connectObject('open-state-changed', (_, isOpen) => {
            if (isOpen)
                uiGroup.set_child_below_sibling(menu.actor, panelBox);
        }, this);

        // Sliding moves one cached image of the dashboard rather than redrawing all of it every frame.
        // Once it has settled, the image goes away so a small change only redraws what changed.
        this._injections = new InjectionManager();
        this._injections.overrideMethod(boxPointer, 'open', open => (animate, onComplete) => {
            boxPointer.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
            open.call(boxPointer, PopupAnimation.NONE, onComplete);

            const [, height] = boxPointer.get_preferred_height(-1);
            boxPointer.set({translation_y: animate ? -height : 0, opacity: animate ? 0 : 255});
            boxPointer.ease({
                translation_y: 0,
                opacity: 255,
                duration: OPEN_DURATION,
                mode: SLIDE_MODE,
                onComplete: () => boxPointer.set_offscreen_redirect(Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY),
            });
        });
        this._injections.overrideMethod(boxPointer, 'close', close => (animate, onComplete) => {
            if (!animate || !boxPointer.visible) {
                close.call(boxPointer, animate, onComplete);
                return;
            }

            boxPointer._muteInput = true;
            boxPointer._muteKeys = true;
            boxPointer.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);

            const [, height] = boxPointer.get_preferred_height(-1);
            boxPointer.ease({
                translation_y: -height,
                opacity: 0,
                duration: CLOSE_DURATION,
                mode: SLIDE_MODE,
                onComplete: () => close.call(boxPointer, PopupAnimation.NONE, onComplete),
            });
        });
    }

    disable() {
        const {menu} = this._dateMenu;
        const boxPointer = menu._boxPointer;
        const {uiGroup, panelBox} = Main.layoutManager;

        menu.disconnectObject(this);
        menu.close();
        this._injections.clear();

        boxPointer.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
        boxPointer.remove_style_class_name('cd-popup');
        uiGroup.set_child_above_sibling(menu.actor, panelBox);

        this._dashboard.destroy();
        this._ears.forEach(ear => ear.destroy());
        menu.box.orientation = Clutter.Orientation.VERTICAL;
        this._originalContent.show();

        this._dateMenu = null;
        this._dashboard = null;
        this._ears = null;
        this._originalContent = null;
        this._injections = null;
    }
}
