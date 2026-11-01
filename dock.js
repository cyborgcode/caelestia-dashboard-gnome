import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import {formatTimeSpan} from 'resource:///org/gnome/shell/misc/dateUtils.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageList from 'resource:///org/gnome/shell/ui/messageList.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {CircleClipEffect, setStyleClass} from './widgets.js';

// Rows a collapsed group shows
const GROUP_PREVIEW_ROWS = 3;
// GNOME's own limit on a notification's action buttons
const MAX_ACTIONS = 3;
// How far a row has to be dragged to dismiss it. A fixed distance, as a share of the width of these
// wide rows would be a long way to drag.
const SWIPE_DISMISS_DISTANCE = 100;
// How long the copy button shows its confirmation, in milliseconds
const COPIED_TIME = 3000;
const ANIMATION_TIME = 220;
const ANIMATION_MODE = Clutter.AnimationMode.EASE_OUT_CUBIC;

// Runs change(), then animates the actor from its old height to its new natural one
function easeHeightChange(actor, change, onComplete) {
    if (!actor.mapped) {
        change();
        return;
    }

    // The height property can include the margins here, which would make the actor jump
    const startHeight = actor.get_allocation_box().get_height();
    actor.remove_transition('height');
    change();
    actor.height = -1;
    // The preferred height counts the margins, but the height property doesn't
    const [, naturalHeight] = actor.get_preferred_height(actor.width);
    actor.height = startHeight;
    actor.ease({
        height: naturalHeight - actor.margin_top - actor.margin_bottom,
        duration: ANIMATION_TIME,
        mode: ANIMATION_MODE,
        onComplete: () => {
            actor.height = -1;
            onComplete?.();
        },
    });
}

// Slides the actor out sideways while closing the gap it leaves, then destroys it
function removeAnimated(actor, direction = 1, delay = 0) {
    actor.remove_all_transitions();
    actor.set_height(actor.get_allocation_box().get_height());
    // The margin closes too, or the gap below the actor would vanish in one jump when it's destroyed
    actor.ease({
        height: 0,
        margin_bottom: 0,
        opacity: 0,
        translation_x: actor.width * direction,
        delay,
        duration: ANIMATION_TIME,
        mode: ANIMATION_MODE,
        onComplete: () => actor.destroy(),
    });
}

function fadeVisible(actor, visible) {
    if (actor.visible === visible && !actor.get_transition('opacity'))
        return;

    if (visible)
        actor.show();
    actor.ease({
        opacity: visible ? 255 : 0,
        duration: ANIMATION_TIME,
        mode: ANIMATION_MODE,
        onComplete: () => (actor.visible = visible),
    });
}

const TimeLabel = GObject.registerClass(
class TimeLabel extends St.Label {
    set datetime(datetime) {
        this._datetime = datetime;
        if (this.mapped)
            this._updateText();
    }

    _updateText() {
        if (this._datetime)
            this.text = formatTimeSpan(this._datetime);
    }

    vfunc_map() {
        this._updateText();
        super.vfunc_map();
    }
});

// One notification: a single "summary body" line, or a card with the full text and actions once
// its group is expanded. Clicking activates it like GNOME's own notifications, middle-clicking or
// swiping it sideways dismisses it, and right-clicking expands its group.
const NotificationRow = GObject.registerClass(
class NotificationRow extends St.Button {
    constructor(notification, group) {
        super({
            style_class: 'cd-row',
            accessible_role: Atk.Role.NOTIFICATION,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE,
            can_focus: true,
            x_expand: true,
        });

        this.notification = notification;
        this.slideDirection = 1;
        this._group = group;
        this._expanded = false;
        this._actionButtons = new Map();

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.set_child(box);

        const headline = new St.BoxLayout({style_class: 'cd-row-headline'});
        box.add_child(headline);

        this._summary = new St.Label({style_class: 'cd-row-summary'});
        headline.add_child(this._summary);

        this._preview = new St.Label({style_class: 'cd-row-preview', x_expand: true});
        headline.add_child(this._preview);

        this._time = new TimeLabel({style_class: 'cd-time'});
        headline.add_child(this._time);

        this._body = new MessageList.URLHighlighter('', true, false);
        this._body.add_style_class_name('cd-row-body');
        this._body.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        box.add_child(this._body);

        this._actions = new St.BoxLayout({style_class: 'cd-row-actions'});
        box.add_child(this._actions);

        this._actions.add_child(this._createIconButton('window-close-symbolic', 'Dismiss',
            () => this.dismiss()));
        this._copyButton = this._createIconButton('edit-copy-symbolic', 'Copy',
            () => this._copyBody());
        this._actions.add_child(this._copyButton);

        notification.actions.forEach(action => this._addAction(action));

        notification.connectObject(
            'notify::title', () => this._sync(),
            'notify::body', () => this._sync(),
            'notify::use-body-markup', () => this._sync(),
            'notify::datetime', () => {
                this._sync();
                group.sync();
            },
            'notify::gicon', () => group.sync(),
            'notify::urgency', () => group.sync(),
            'action-added', (_, action) => this._addAction(action),
            'action-removed', (_, action) => this._removeAction(action),
            'destroy', () => (this.notification = null),
            this);

        const swipe = new Clutter.PanGesture({pan_axis: Clutter.PanAxis.X});
        swipe.connect('pan-update', () => (this.translation_x = swipe.get_accumulated_delta().get_x()));
        swipe.connect('end', () => {
            const distance = swipe.get_accumulated_delta().get_x();
            const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
            if (Math.abs(distance) > SWIPE_DISMISS_DISTANCE * scaleFactor)
                this.dismiss(Math.sign(distance));
            else
                this._snapBack();
        });
        swipe.connect('cancel', () => this._snapBack());
        this.add_action(swipe);

        this.connect('destroy', () => {
            if (this._copiedId)
                GLib.source_remove(this._copiedId);
        });

        this._sync();
    }

    _createIconButton(iconName, accessibleName, callback) {
        const button = new St.Button({
            style_class: 'cd-action-button',
            icon_name: iconName,
            accessible_name: accessibleName,
            can_focus: true,
            x_expand: true,
        });
        button.connect('clicked', callback);
        return button;
    }

    _addAction(action) {
        if (this._actionButtons.size >= MAX_ACTIONS)
            return;

        const button = new St.Button({
            style_class: 'cd-action-button',
            label: action.label,
            can_focus: true,
            x_expand: true,
        });
        button.connect('clicked', () => action.activate());
        this._actionButtons.set(action, button);
        this._actions.insert_child_below(button, this._copyButton);
    }

    _removeAction(action) {
        this._actionButtons.get(action)?.destroy();
        this._actionButtons.delete(action);
    }

    _copyBody() {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._body.text);

        this._copyButton.icon_name = 'object-select-symbolic';
        if (this._copiedId)
            GLib.source_remove(this._copiedId);
        this._copiedId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COPIED_TIME, () => {
            this._copyButton.icon_name = 'edit-copy-symbolic';
            delete this._copiedId;
            return GLib.SOURCE_REMOVE;
        });
    }

    _snapBack() {
        this.ease({translation_x: 0, duration: ANIMATION_TIME, mode: ANIMATION_MODE});
    }

    _sync() {
        const {title, body, useBodyMarkup, datetime} = this.notification;

        this._summary.clutter_text.set_markup(
            title ? Util.fixMarkup(title.replace(/\n/g, ' '), false) : '');
        this._preview.clutter_text.set_markup(
            body ? Util.fixMarkup(body.replace(/\n/g, ' '), useBodyMarkup) : '');
        this._body.setMarkup(body ?? '', useBodyMarkup);
        this._copyButton.visible = !!body;
        this._time.datetime = datetime;

        this.setExpanded(this._expanded);
    }

    setExpanded(expanded) {
        this._expanded = expanded;

        setStyleClass(this, 'expanded', expanded);
        this._preview.visible = !expanded;
        this._time.visible = expanded;
        this._body.visible = expanded && !!this._body.text;
        this._actions.visible = expanded;

        this._summary.x_expand = expanded;
        this._summary.clutter_text.line_wrap = expanded;
        this._summary.clutter_text.ellipsize = expanded
            ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END;
    }

    dismiss(direction = 1) {
        this.slideDirection = direction;
        this.notification?.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
    }

    vfunc_clicked(button) {
        if (button === Clutter.BUTTON_MIDDLE)
            this.dismiss();
        else if (button === Clutter.BUTTON_SECONDARY)
            this._group.toggleExpanded();
        else
            this.notification?.activate();
    }

    vfunc_key_press_event(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Delete || key === Clutter.KEY_KP_Delete || key === Clutter.KEY_BackSpace) {
            this.dismiss();
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }
});

// One app's card: a round avatar beside a header (app, time, count pill) and its notifications
const AppGroup = GObject.registerClass({
    Signals: {
        'changed': {},
        'expanded': {},
    },
}, class AppGroup extends St.BoxLayout {
    constructor(source) {
        super({
            style_class: 'cd-group',
            clip_to_allocation: true,
            x_expand: true,
        });

        this.removalDirection = 1;
        this.removalDelay = 0;
        this._source = source;
        this._expanded = false;
        this._clearing = false;
        // Oldest first, like source.notifications
        this._rows = new Map();

        this._avatar = new St.Widget({
            style_class: 'cd-avatar',
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.START,
        });
        this.add_child(this._avatar);

        this._avatarIcon = new St.Icon({
            style_class: 'cd-avatar-icon',
            fallback_icon_name: 'application-x-executable-symbolic',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._circleClip = new CircleClipEffect();
        this._avatarIcon.add_effect(this._circleClip);
        this._avatar.add_child(this._avatarIcon);

        this._badge = new St.Bin({
            style_class: 'cd-avatar-badge',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
            child: new St.Icon({
                style_class: 'cd-avatar-badge-icon',
                fallback_icon_name: 'application-x-executable-symbolic',
                x_expand: true,
                y_expand: true,
            }),
        });
        this._avatar.add_child(this._badge);

        const column = new St.BoxLayout({
            style_class: 'cd-group-column',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.add_child(column);

        const header = new St.BoxLayout({style_class: 'cd-group-header'});
        column.add_child(header);

        const title = new St.Label({
            style_class: 'cd-group-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        source.bind_property_full('title', title, 'text',
            GObject.BindingFlags.SYNC_CREATE,
            (_, value) => [true, value || 'Unknown App'],
            null);
        header.add_child(title);

        this._time = new TimeLabel({
            style_class: 'cd-time',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._time);

        const countBox = new St.BoxLayout({style_class: 'cd-count-box'});
        this._count = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        countBox.add_child(this._count);
        this._chevron = new St.Icon({
            style_class: 'cd-count-chevron',
            icon_name: 'pan-down-symbolic',
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        countBox.add_child(this._chevron);

        this._countButton = new St.Button({
            style_class: 'cd-count-button',
            accessible_name: 'Expand',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: countBox,
        });
        this._countButton.connect('clicked', () => this.toggleExpanded());
        header.add_child(this._countButton);

        this._rowsBox = new St.BoxLayout({
            style_class: 'cd-group-rows',
            orientation: Clutter.Orientation.VERTICAL,
        });
        column.add_child(this._rowsBox);

        source.connectObject(
            'notification-added', (_, notification) => this._addRow(notification),
            'notification-removed', (_, notification) => this._removeRow(notification),
            this);
        source.notifications.forEach(notification => this._addRow(notification));
    }

    get hasUrgent() {
        return this._source.notifications.some(n => n.urgency === MessageTray.Urgency.CRITICAL);
    }

    get latest() {
        return Math.max(...this._source.notifications.map(n => n.datetime.to_unix()));
    }

    _addRow(notification) {
        const row = new NotificationRow(notification, this);
        this._rows.set(notification, row);

        easeHeightChange(this, () => {
            this._rowsBox.insert_child_at_index(row, 0);
            this.sync();
        });
    }

    _removeRow(notification) {
        const row = this._rows.get(notification);
        this._rows.delete(notification);
        this.removalDirection = row.slideDirection;

        // The rows stay in place when the whole group is about to animate away
        if (this._clearing || this._rows.size === 0)
            return;

        removeAnimated(row, row.slideDirection);
        this.sync();
    }

    _syncRows() {
        [...this._rows.values()].reverse().forEach((row, index) => {
            row.setExpanded(this._expanded);
            row.visible = this._expanded || index < GROUP_PREVIEW_ROWS;
        });
    }

    sync() {
        const {notifications} = this._source;
        const newest = notifications.at(-1);
        if (!newest)
            return;

        const image = notifications.findLast(n => n.gicon && !(n.gicon instanceof Gio.ThemedIcon))?.gicon;
        this._avatarIcon.gicon = image ?? newest.gicon ?? this._source.icon;
        this._badge.child.gicon = this._source.icon;
        this._badge.visible = !!image;
        this._circleClip.enabled = !!image;
        setStyleClass(this._avatar, 'has-image', !!image);

        setStyleClass(this, 'critical', this.hasUrgent);
        setStyleClass(this, 'low', notifications.every(n => n.urgency === MessageTray.Urgency.LOW));

        this._time.datetime = newest.datetime;
        this._count.text = `${notifications.length}`;

        this._syncRows();
        this.emit('changed');
    }

    toggleExpanded() {
        this._expanded = !this._expanded;

        this._countButton.accessible_name = this._expanded ? 'Collapse' : 'Expand';
        this._chevron.ease({
            rotation_angle_z: this._expanded ? 180 : 0,
            duration: ANIMATION_TIME,
            mode: ANIMATION_MODE,
        });
        easeHeightChange(this, () => this._syncRows(), () => {
            if (this._expanded)
                this.emit('expanded');
        });
    }

    clear(delay) {
        this.removalDelay = delay;
        this._clearing = true;
        [...this._source.notifications].forEach(n => {
            n.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
        });
    }

    vfunc_map() {
        // Seeing a notification here is what clears the clock's unread dot
        this._source.notifications.forEach(n => (n.acknowledged = true));
        super.vfunc_map();
    }
});

// The Notifications tab: a count, the app cards, the dinosaur when there's nothing to show, and a
// floating button that clears everything.
export const NotificationDock = GObject.registerClass({
    Signals: {'count-changed': {param_types: [GObject.TYPE_INT]}},
}, class NotificationDock extends St.Widget {
    constructor() {
        super({
            style_class: 'cd-dock',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });

        this._groups = new Map();

        const column = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        this.add_child(column);

        this._title = new St.Label({style_class: 'cd-dock-title'});
        column.add_child(this._title);

        this._list = new St.BoxLayout({
            style_class: 'cd-dock-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        // Lets the last card scroll clear of the clear button. Padding can't, since the view clips to it.
        this._listEnd = new St.Widget({style_class: 'cd-dock-list-end'});
        this._list.add_child(this._listEnd);

        this._scrollView = new St.ScrollView({
            style_class: 'cd-dock-scroll vfade',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            child: this._list,
        });
        column.add_child(this._scrollView);

        this._placeholder = new St.BoxLayout({
            style_class: 'cd-placeholder',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._placeholder.add_child(new St.Widget({
            style_class: 'cd-placeholder-image',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        this._placeholder.add_child(new St.Label({
            style_class: 'cd-placeholder-label',
            text: 'All up to date!',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        this.add_child(this._placeholder);

        this._clearButton = new St.Button({
            style_class: 'cd-clear-button',
            icon_name: 'edit-clear-all-symbolic',
            accessible_name: 'Clear all notifications',
            can_focus: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
        });
        this._clearButton.connect('clicked', () => this._clear());
        this.add_child(this._clearButton);

        Main.messageTray.connectObject(
            'source-added', (_, source) => this._addGroup(source),
            'source-removed', (_, source) => this._removeGroup(source),
            this);
        global.stage.connectObject('notify::key-focus', () => {
            const focus = global.stage.key_focus;
            if (focus && this._list.contains(focus))
                ensureActorVisibleInScrollView(this._scrollView, focus);
        }, this);

        Main.messageTray.getSources().forEach(source => this._addGroup(source));
        this._sync();
    }

    _addGroup(source) {
        const group = new AppGroup(source);
        this._groups.set(source, group);
        group.connectObject(
            'changed', () => this._sync(),
            // Without this, opening a card near the bottom would happen out of sight
            'expanded', () => ensureActorVisibleInScrollView(this._scrollView, group),
            this);
        this._list.insert_child_below(group, this._listEnd);

        group.opacity = 0;
        group.ease({opacity: 255, duration: ANIMATION_TIME, mode: ANIMATION_MODE});
        group.sync();
    }

    _removeGroup(source) {
        const group = this._groups.get(source);
        this._groups.delete(source);
        group.disconnectObject(this);
        removeAnimated(group, group.removalDirection, group.removalDelay);
        this._sync();
    }

    _clear() {
        const groups = [...this._groups.values()];
        const stagger = ANIMATION_TIME / Math.max(groups.length, 5);
        groups.forEach((group, index) => group.clear(index * stagger));
    }

    _sync() {
        const sources = [...this._groups.keys()];
        const count = sources.reduce((sum, source) => sum + source.count, 0);

        this._title.text = count > 0
            ? `${count} ${count === 1 ? 'notification' : 'notifications'}`
            : 'Notifications';
        fadeVisible(this._placeholder, count === 0);
        fadeVisible(this._clearButton, count > 0);

        this.emit('count-changed', count);

        // Urgent apps stay on top, followed by the most recent ones
        const groups = [...this._groups.values()]
            .sort((a, b) => b.hasUrgent - a.hasUrgent || b.latest - a.latest);
        groups.forEach((group, index) => {
            if (this._list.get_child_at_index(index) !== group)
                this._list.set_child_at_index(group, index);
        });
    }
});
