import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ArcProgress, CircleClipEffect, setStyleClass} from './widgets.js';

const PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';
const PLAYER_PATH = '/org/mpris/MediaPlayer2';
// How long the cat holds each paw, in milliseconds
const CAT_FRAME_TIME = 200;

function formatTime(microseconds) {
    const seconds = Math.floor(microseconds / GLib.USEC_PER_SEC);
    return `${Math.floor(seconds / 60)}:${`${seconds % 60}`.padStart(2, '0')}`;
}

// Follows the player that's playing, and adds the album and position GNOME's player object leaves out
export const MediaController = GObject.registerClass({
    Signals: {
        'changed': {},
        'position-changed': {},
    },
}, class MediaController extends GObject.Object {
    constructor(mediaSource) {
        super();

        this._mediaSource = mediaSource;
        this._cancellable = new Gio.Cancellable();
        this.player = null;
        this.position = 0;

        mediaSource.connectObject(
            'player-added', (_, player) => this._watchPlayer(player),
            'player-removed', () => this._sync(),
            this);
        mediaSource.players.forEach(player => this._watchPlayer(player));
        this._sync();
    }

    _watchPlayer(player) {
        player.connectObject('changed', () => this._sync(), this);
        this._sync();
    }

    _isPlaying(player) {
        return player?._playerProxy?.PlaybackStatus === 'Playing';
    }

    _sync() {
        const players = this._mediaSource.players;
        if (!this._isPlaying(this.player)) {
            this.player = players.find(player => this._isPlaying(player)) ??
                (players.includes(this.player) ? this.player : players[0] ?? null);
        }
        this.emit('changed');
    }

    get isPlaying() {
        return !!this.player && this._isPlaying(this.player);
    }

    get canGoPrevious() {
        return !!this.player?._playerProxy?.CanGoPrevious;
    }

    get canGoNext() {
        return !!this.player?._playerProxy?.CanGoNext;
    }

    _metadata(key) {
        return this.player?._playerProxy?.Metadata?.[key]?.deepUnpack();
    }

    get album() {
        const album = this._metadata('xesam:album');
        return typeof album === 'string' ? album : '';
    }

    get length() {
        return Number(this._metadata('mpris:length') ?? 0);
    }

    get progress() {
        return this.length > 0 ? this.position / this.length : 0;
    }

    get timeText() {
        return this.length > 0 ? `${formatTime(this.position)} / ${formatTime(this.length)}` : '';
    }

    start() {
        if (this._timeoutId)
            return;

        this._updatePosition();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (this.isPlaying)
                this._updatePosition();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        delete this._timeoutId;
    }

    _updatePosition() {
        if (!this.player)
            return;

        // Players don't announce position changes, so it has to be asked for each time
        Gio.DBus.session.call(this.player._busName, PLAYER_PATH,
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [PLAYER_INTERFACE, 'Position']),
            null, Gio.DBusCallFlags.NONE, -1, this._cancellable, (connection, result) => {
                try {
                    const [position] = connection.call_finish(result).deepUnpack();
                    this.position = Number(position.deepUnpack());
                    this.emit('position-changed');
                } catch (error) {
                    // Not every player reports a position, and a player can go away mid-call
                    if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.debug(`Caelestia Dashboard: no media position: ${error.message}`);
                }
            });
    }

    destroy() {
        this.stop();
        this._cancellable.cancel();
        this._mediaSource.disconnectObject(this);
        this._mediaSource.players.forEach(player => player.disconnectObject(this));
    }
});

// A player: round cover with a progress arc, track details, controls and the bongo cat. The compact
// form stacks these for the Dashboard tab, and the full form sets them side by side for the Media tab.
export const MediaView = GObject.registerClass(
class MediaView extends St.BoxLayout {
    constructor(controller, {compact}) {
        super({
            style_class: compact ? 'cd-media cd-media-compact' : 'cd-media cd-media-full',
            orientation: compact ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
            // Expanding would also stretch the fixed-width card around the compact form
            x_expand: !compact,
            y_expand: true,
        });

        this._controller = controller;

        const coverStack = new St.Widget({
            style_class: 'cd-cover-stack',
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: compact ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER,
        });
        this.add_child(coverStack);

        // A half circle from nine o'clock over the top to three o'clock
        this._arc = new ArcProgress(Math.PI, Math.PI, {x_expand: true, y_expand: true});
        coverStack.add_child(this._arc);

        this._cover = new St.Icon({style_class: 'cd-cover'});
        this._coverClip = new CircleClipEffect();
        this._cover.add_effect(this._coverClip);
        const coverButton = new St.Button({
            style_class: 'cd-cover-button',
            accessible_name: 'Open player',
            can_focus: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            child: this._cover,
        });
        coverButton.connect('clicked', () => {
            controller.player?.raise();
            Main.panel.closeCalendar();
        });
        coverStack.add_child(coverButton);

        const details = new St.BoxLayout({
            style_class: 'cd-media-details',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        this.add_child(details);

        const createLabel = styleClass => {
            const label = new St.Label({
                style_class: styleClass,
                x_align: compact ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START,
            });
            details.add_child(label);
            return label;
        };
        this._title = createLabel('cd-media-title');
        this._album = createLabel('cd-media-album');
        this._artist = createLabel('cd-media-artist');
        this._time = createLabel('cd-media-time');
        this._time.visible = !compact;

        const controls = new St.BoxLayout({style_class: 'cd-media-controls', x_expand: true});
        details.add_child(controls);

        const createControl = (iconName, accessibleName, styleClass, callback) => {
            const button = new St.Button({
                style_class: `cd-media-control ${styleClass}`,
                icon_name: iconName,
                accessible_name: accessibleName,
                can_focus: true,
                x_expand: true,
            });
            button.connect('clicked', callback);
            controls.add_child(button);
            return button;
        };
        this._previous = createControl('media-skip-backward-symbolic', 'Previous', 'cd-media-skip',
            () => controller.player?.previous());
        this._playPause = createControl('media-playback-start-symbolic', 'Play or pause', 'cd-media-play',
            () => controller.player?.playPause());
        this._next = createControl('media-skip-forward-symbolic', 'Next', 'cd-media-skip',
            () => controller.player?.next());

        // Two stacked images, since swapping opacity redraws far less than restyling one widget
        const cat = new St.Widget({
            style_class: 'cd-cat',
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            y_expand: true,
        });
        this._catFrames = [0, 1].map(index => {
            const frame = new St.Widget({
                style_class: `cd-cat-frame cd-cat-frame-${index}`,
                opacity: index === 0 ? 255 : 0,
                x_expand: true,
                y_expand: true,
            });
            cat.add_child(frame);
            return frame;
        });
        details.add_child(cat);

        controller.connectObject(
            'changed', () => this._sync(),
            'position-changed', () => this._syncPosition(),
            this);
        this.connect('notify::mapped', () => {
            this._syncPosition();
            this._syncCat();
        });
        this.connect('destroy', () => this._stopCat());
        this._sync();
    }

    _sync() {
        const {player, isPlaying, album} = this._controller;

        this._title.text = (player ? player.trackTitle : 'No media') || 'Unknown title';
        this._album.text = (player ? album : 'No media') || 'Unknown album';
        this._artist.text = player ? player.trackArtists.join(', ') : 'No media';

        const coverUrl = player?.trackCoverUrl;
        this._cover.gicon = coverUrl
            ? new Gio.FileIcon({file: Gio.File.new_for_uri(coverUrl)})
            : new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
        this._coverClip.enabled = !!coverUrl;
        setStyleClass(this._cover, 'no-art', !coverUrl);

        this._playPause.icon_name = isPlaying ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._playPause.reactive = !!player;
        this._previous.reactive = this._controller.canGoPrevious;
        this._next.reactive = this._controller.canGoNext;

        this._syncPosition();
        this._syncCat();
    }

    _syncPosition() {
        if (!this.mapped)
            return;

        this._arc.value = this._controller.progress;
        this._time.text = this._controller.timeText;
    }

    _syncCat() {
        if (this.mapped && this._controller.isPlaying)
            this._startCat();
        else
            this._stopCat();
    }

    _startCat() {
        if (this._catId)
            return;

        let shown = 0;
        this._catId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CAT_FRAME_TIME, () => {
            shown = 1 - shown;
            this._showCatFrame(shown);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopCat() {
        if (this._catId)
            GLib.source_remove(this._catId);
        delete this._catId;
        this._showCatFrame(0);
    }

    _showCatFrame(shown) {
        this._catFrames.forEach((frame, index) => (frame.opacity = index === shown ? 255 : 0));
    }
});
