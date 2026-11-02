import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';

import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Dashboard, PanelEar} from './dashboard.js';
import {addPanelEarPath} from './widgets.js';

// Opening glides on Caelestia's effects curve: it starts no faster than it has to and doesn't overshoot,
// since overshooting would pull the menu away from the bar. The fade is over well before the slide, so
// the menu is solid for most of the way. Closing moves straight away and speeds up gently as the menu
// disappears behind the bar. Durations are in milliseconds and curves are cubic Béziers.
const OPEN_MOTION = {duration: 400, curve: [0.34, 0.8, 0.34, 1], fadeDuration: 150};
const CLOSE_MOTION = {duration: 200, curve: [0.3, 0.15, 0.75, 0.6], fadeDuration: 200};

// The clock's dropdown already handles opening, closing, input grabs and blocking banners, so the
// dashboard is that same menu with its content swapped. It and Quick Settings both hang from the top
// bar, sliding out from behind it.
export default class CaelestiaDashboardExtension extends Extension {
    enable() {
        const dateMenu = this._dateMenu = Main.panel.statusArea.dateMenu;
        const {menu, _messageList: messageList, _clock: wallClock} = dateMenu;

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

        this._injections = new InjectionManager();
        this._slides = new Map();
        this._hangFromTopBar(menu);
        this._dashboard.prepareInBackground(menu);

        // Quick Settings sits in the top right corner, so its only ear is on its left. The popup's own
        // drawing area, which spans the whole popup, draws it.
        const quickMenu = this._quickMenu = Main.panel.statusArea.quickSettings.menu;
        quickMenu.actor.add_style_class_name('cd-quick');
        const quickBorder = quickMenu._boxPointer._border;
        quickBorder.add_style_class_name('cd-quick-ear');
        quickBorder.connectObject('repaint', area => {
            const cr = area.get_context();
            const node = area.get_theme_node();
            // The popup's own drawing leaves its outline behind as the current path
            cr.newPath();
            cr.setSourceColor(node.get_foreground_color());
            addPanelEarPath(cr, 0, node.get_length('-cd-ear-size'), Clutter.ActorAlign.END);
            cr.fill();
            cr.$dispose();
        }, this);
        quickBorder.queue_repaint();
        this._hangFromTopBar(quickMenu);
    }

    // Moves a menu flush against the bottom of the top bar and makes it slide out from behind the bar.
    // Sliding moves one cached image of the menu rather than redrawing all of it every frame. Once it
    // has settled, the image goes away so a small change only redraws what changed.
    _hangFromTopBar(menu) {
        const boxPointer = menu._boxPointer;
        const {uiGroup, panelBox} = Main.layoutManager;

        boxPointer.add_style_class_name('cd-popup');

        // Opening raises the menu above everything, so it has to go back behind the top bar each time
        menu.connectObject('open-state-changed', (_, isOpen) => {
            if (isOpen)
                uiGroup.set_child_below_sibling(menu.actor, panelBox);
        }, this);

        const settle = () => boxPointer.set_offscreen_redirect(Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY);

        this._injections.overrideMethod(boxPointer, 'open', open => (animate, onComplete) => {
            // Opening again while it's still closing carries on from where it has got to
            const wasSliding = this._slides.has(boxPointer);
            const {translation_y: y, opacity} = boxPointer;

            this._stopSlide(boxPointer);
            boxPointer.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
            open.call(boxPointer, PopupAnimation.NONE, onComplete);

            if (!animate) {
                boxPointer.set({translation_y: 0, opacity: 255});
                settle();
                return;
            }

            const [, height] = boxPointer.get_preferred_height(-1);
            boxPointer.set(wasSliding ? {translation_y: y, opacity} : {translation_y: -height, opacity: 0});
            this._slide(boxPointer, 0, 255, OPEN_MOTION, settle);
        });
        this._injections.overrideMethod(boxPointer, 'close', close => (animate, onComplete) => {
            // Closing without saying how, as clicking a notification or a link does, slides away too.
            // Only an explicit NONE closes on the spot, and so does a menu that isn't on screen. Quick
            // Settings hides a wrapper around its popup, so the popup itself can be visible but unmapped.
            if ((!animate && animate !== undefined) || !boxPointer.mapped) {
                this._stopSlide(boxPointer);
                close.call(boxPointer, PopupAnimation.NONE, onComplete);
                return;
            }

            boxPointer._muteInput = true;
            boxPointer._muteKeys = true;
            boxPointer.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);

            const [, height] = boxPointer.get_preferred_height(-1);
            this._slide(boxPointer, -height, 0, CLOSE_MOTION,
                () => close.call(boxPointer, PopupAnimation.NONE, onComplete));
        });
    }

    // Slides from wherever the popup is now, on a timeline of its own rather than with ease(), so that
    // each frame can land on a whole pixel of the screen. Otherwise the slow end of the slide smears the
    // text across fractions of a pixel, which shows most with fractional scaling.
    _slide(boxPointer, toY, toOpacity, {duration, curve, fadeDuration}, onComplete) {
        this._stopSlide(boxPointer);

        const fromY = boxPointer.translation_y;
        const fromOpacity = boxPointer.opacity;
        const time = adjustAnimationTime(duration);
        if (time === 0) {
            boxPointer.set({translation_y: toY, opacity: toOpacity});
            onComplete();
            return;
        }

        const scale = global.display.get_monitor_scale(Main.layoutManager.findIndexForActor(boxPointer));
        const fadeTime = time * fadeDuration / duration;
        const timeline = new Clutter.Timeline({actor: boxPointer, duration: time});
        timeline.set_cubic_bezier_progress(
            new Graphene.Point({x: curve[0], y: curve[1]}),
            new Graphene.Point({x: curve[2], y: curve[3]}));

        timeline.connect('new-frame', () => {
            const y = fromY + (toY - fromY) * timeline.get_progress();
            const fade = Math.min(timeline.get_elapsed_time() / fadeTime, 1);
            boxPointer.translation_y = Math.round(y * scale) / scale;
            boxPointer.opacity = fromOpacity + (toOpacity - fromOpacity) * fade;
        });
        timeline.connect('stopped', (_, isFinished) => {
            if (this._slides.get(boxPointer) === timeline)
                this._slides.delete(boxPointer);
            if (!isFinished)
                return;

            boxPointer.set({translation_y: toY, opacity: toOpacity});
            onComplete();
        });

        this._slides.set(boxPointer, timeline);
        timeline.start();
    }

    _stopSlide(boxPointer) {
        this._slides.get(boxPointer)?.stop();
    }

    _releaseFromTopBar(menu) {
        const boxPointer = menu._boxPointer;
        const {uiGroup, panelBox} = Main.layoutManager;

        menu.disconnectObject(this);
        boxPointer.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
        boxPointer.remove_style_class_name('cd-popup');
        uiGroup.set_child_above_sibling(menu.actor, panelBox);
    }

    disable() {
        const {menu} = this._dateMenu;
        const quickMenu = this._quickMenu;

        menu.close(PopupAnimation.NONE);
        quickMenu.close(PopupAnimation.NONE);
        this._injections.clear();
        this._releaseFromTopBar(menu);
        this._releaseFromTopBar(quickMenu);

        const quickBorder = quickMenu._boxPointer._border;
        quickBorder.disconnectObject(this);
        quickBorder.remove_style_class_name('cd-quick-ear');
        quickBorder.queue_repaint();
        quickMenu.actor.remove_style_class_name('cd-quick');

        this._dashboard.destroy();
        this._ears.forEach(ear => ear.destroy());
        menu.box.orientation = Clutter.Orientation.VERTICAL;
        this._originalContent.show();

        this._dateMenu = null;
        this._quickMenu = null;
        this._dashboard = null;
        this._ears = null;
        this._originalContent = null;
        this._injections = null;
        this._slides = null;
    }
}
