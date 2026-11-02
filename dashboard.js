import AccountsService from 'gi://AccountsService';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {PACKAGE_VERSION} from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Avatar} from 'resource:///org/gnome/shell/ui/userWidget.js';

import {NotificationDock} from './dock.js';
import {MediaController, MediaView} from './media.js';
import {formatUptime, SystemStats, WeatherClient} from './system.js';
import {addPanelEarPath, ArcProgress, LevelBar, setStyleClass} from './widgets.js';

const extensionDirectory = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);

const ANIMATION_TIME = 220;
const ANIMATION_MODE = Clutter.AnimationMode.EASE_OUT_CUBIC;
const PAGE_SLIDE_DISTANCE = 48;
// How long to wait after opening before going to the network, so it can't disturb the slide
const WEATHER_REFRESH_DELAY = 400;
// How long to leave between the background steps that prepare each page, in milliseconds
const PREPARE_INTERVAL = 1000;
const NOTIFICATIONS_TAB_INDEX = 4;

function extensionIcon(name) {
    return Gio.icon_new_for_string(`${extensionDirectory}/${name}.svg`);
}

function createCard(styleClass, params) {
    return new St.BoxLayout({style_class: `cd-card ${styleClass}`, ...params});
}

// The concave corner that blends the dashboard into the top bar. Its colour comes from CSS.
export const PanelEar = GObject.registerClass(
class PanelEar extends St.DrawingArea {
    constructor(panelSide) {
        super({style_class: 'cd-panel-ear', y_align: Clutter.ActorAlign.START});
        this._panelSide = panelSide;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [, height] = this.get_surface_size();

        cr.setSourceColor(this.get_theme_node().get_foreground_color());
        addPanelEarPath(cr, 0, height, this._panelSide);
        cr.fill();

        cr.$dispose();
    }
});

const WeatherCard = GObject.registerClass(
class WeatherCard extends St.BoxLayout {
    constructor(weather) {
        super({style_class: 'cd-card cd-weather'});

        this._weather = weather;

        this._icon = new St.Icon({style_class: 'cd-weather-icon', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._icon);

        const text = new St.BoxLayout({
            style_class: 'cd-weather-text',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(text);

        this._temperature = new St.Label({style_class: 'cd-weather-temperature', x_align: Clutter.ActorAlign.CENTER});
        text.add_child(this._temperature);

        this._description = new St.Label({style_class: 'cd-weather-description', x_align: Clutter.ActorAlign.CENTER});
        text.add_child(this._description);

        weather.connectObject('changed', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        this._icon.icon_name = this._weather.iconName;
        this._temperature.text = this._weather.temperature;
        this._description.text = this._weather.description;
    }
});

const UserCard = GObject.registerClass(
class UserCard extends St.BoxLayout {
    constructor() {
        super({style_class: 'cd-card cd-user', x_expand: true});

        const user = AccountsService.UserManager.get_default().get_user(GLib.get_user_name());
        const avatar = new Avatar(user, {styleClass: 'cd-avatar', iconSize: 76});
        avatar.y_align = Clutter.ActorAlign.CENTER;
        user.connectObject(
            'notify::is-loaded', () => avatar.update(),
            'changed', () => avatar.update(),
            avatar);
        avatar.update();
        this.add_child(avatar);

        const rows = new St.BoxLayout({
            style_class: 'cd-user-rows',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(rows);

        const createRow = (iconName, text) => {
            const row = new St.BoxLayout({style_class: 'cd-user-row'});
            row.add_child(new St.Icon({style_class: 'cd-user-row-icon', icon_name: iconName}));
            const label = new St.Label({
                style_class: 'cd-user-row-label',
                text,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(label);
            rows.add_child(row);
            return label;
        };
        createRow('distributor-logo-symbolic', GLib.get_os_info('PRETTY_NAME') ?? 'Linux');
        createRow('user-desktop-symbolic', `GNOME ${PACKAGE_VERSION}`);
        this._uptime = createRow('document-open-recent-symbolic', '');

        this.connect('notify::mapped', () => this.sync());
        this.sync();
    }

    sync() {
        this._uptime.text = formatUptime();
    }
});

const ClockCard = GObject.registerClass(
class ClockCard extends St.BoxLayout {
    constructor(wallClock) {
        super({
            style_class: 'cd-card cd-clock',
            orientation: Clutter.Orientation.VERTICAL,
        });

        const inner = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(inner);

        const createLabel = (styleClass, text = '') => {
            const label = new St.Label({style_class: styleClass, text, x_align: Clutter.ActorAlign.CENTER});
            inner.add_child(label);
            return label;
        };
        this._hour = createLabel('cd-clock-digits');
        createLabel('cd-clock-dots', '•••');
        this._minute = createLabel('cd-clock-digits');
        this._meridiem = createLabel('cd-clock-meridiem');
        this._date = createLabel('cd-clock-date');

        this._settings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        wallClock.connectObject('notify::clock', () => this._sync(), this);
        this.connect('notify::mapped', () => this._sync());
        this.connect('destroy', () => this._settings.run_dispose());
    }

    _sync() {
        if (!this.mapped)
            return;

        const now = GLib.DateTime.new_now_local();
        const uses24Hours = this._settings.get_string('clock-format') === '24h';

        this._hour.text = now.format(uses24Hours ? '%H' : '%I');
        this._minute.text = now.format('%M');
        this._meridiem.text = now.format('%p') ?? '';
        this._meridiem.visible = !uses24Hours;
        this._date.text = now.format('%a, %-d');
    }
});

const CalendarCard = GObject.registerClass(
class CalendarCard extends St.BoxLayout {
    constructor() {
        super({
            style_class: 'cd-card cd-calendar',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            reactive: true,
        });

        const header = new St.BoxLayout({style_class: 'cd-calendar-header'});
        this.add_child(header);

        const createPager = (iconName, accessibleName, step) => {
            const button = new St.Button({
                style_class: 'cd-calendar-pager',
                icon_name: iconName,
                accessible_name: accessibleName,
                can_focus: true,
            });
            button.connect('clicked', () => this._changeMonth(step));
            return button;
        };
        header.add_child(createPager('pan-start-symbolic', 'Previous month', -1));

        this._month = new St.Button({
            style_class: 'cd-calendar-month',
            can_focus: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._month.connect('clicked', () => this._showCurrentMonth());
        header.add_child(this._month);

        header.add_child(createPager('pan-end-symbolic', 'Next month', 1));

        const layout = new Clutter.GridLayout({column_homogeneous: true, row_homogeneous: true});
        const grid = new St.Widget({
            style_class: 'cd-calendar-grid',
            layout_manager: layout,
            x_expand: true,
            y_expand: true,
        });
        this.add_child(grid);

        const createCell = styleClass => {
            const cell = new St.Label({
                style_class: styleClass,
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            cell.clutter_text.y_align = Clutter.ActorAlign.CENTER;
            return cell;
        };

        this._weekStart = Shell.util_get_week_start();
        for (let column = 0; column < 7; column++) {
            const heading = createCell('cd-calendar-heading');
            // January 1st 2023 was a Sunday, the day Shell.util_get_week_start() counts from
            const weekDay = (this._weekStart + column) % 7;
            heading.text = GLib.DateTime.new_local(2023, 1, 1 + weekDay, 0, 0, 0).format('%a');
            layout.attach(heading, column, 0, 1, 1);
        }

        this._days = [];
        for (let row = 1; row <= 6; row++) {
            for (let column = 0; column < 7; column++) {
                const day = createCell('cd-calendar-day');
                layout.attach(day, column, row, 1, 1);
                this._days.push(day);
            }
        }

        this.connect('notify::mapped', () => {
            if (this.mapped)
                this._showCurrentMonth();
        });
        this._showCurrentMonth();
    }

    _showCurrentMonth() {
        const now = new Date();
        this._year = now.getFullYear();
        this._monthIndex = now.getMonth();
        this._sync();
    }

    _changeMonth(step) {
        const shown = new Date(this._year, this._monthIndex + step, 1);
        this._year = shown.getFullYear();
        this._monthIndex = shown.getMonth();
        this._sync();
    }

    _sync() {
        const today = new Date();

        // Reopening on the same day changes none of the cells
        const shownKey = `${this._year}-${this._monthIndex}-${today.toDateString()}`;
        if (shownKey === this._shownKey)
            return;
        this._shownKey = shownKey;

        this._month.label = GLib.DateTime.new_local(this._year, this._monthIndex + 1, 1, 0, 0, 0).format('%B %Y');

        const firstWeekDay = new Date(this._year, this._monthIndex, 1).getDay();
        const offset = (firstWeekDay - this._weekStart + 7) % 7;

        this._days.forEach((cell, index) => {
            const date = new Date(this._year, this._monthIndex, 1 - offset + index);
            const isToday = date.getFullYear() === today.getFullYear() &&
                date.getMonth() === today.getMonth() &&
                date.getDate() === today.getDate();

            cell.text = `${date.getDate()}`;
            setStyleClass(cell, 'other-month', date.getMonth() !== this._monthIndex);
            setStyleClass(cell, 'weekend', date.getDay() === 0 || date.getDay() === 6);
            setStyleClass(cell, 'today', isToday);
        });
    }

    vfunc_scroll_event(event) {
        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.LEFT)
            this._changeMonth(-1);
        else if (direction === Clutter.ScrollDirection.DOWN || direction === Clutter.ScrollDirection.RIGHT)
            this._changeMonth(1);
        return Clutter.EVENT_STOP;
    }
});

const ResourcesCard = GObject.registerClass(
class ResourcesCard extends St.BoxLayout {
    constructor(stats) {
        super({style_class: 'cd-card cd-resources'});

        this._stats = stats;

        const createBar = (gicon, fillClass, accessibleName) => {
            const column = new St.BoxLayout({
                style_class: 'cd-resource',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                accessible_name: accessibleName,
            });
            const bar = new LevelBar(Clutter.Orientation.VERTICAL, {
                style_class: `cd-resource-track ${fillClass}`,
                x_align: Clutter.ActorAlign.CENTER,
                y_expand: true,
            });
            column.add_child(bar);
            column.add_child(new St.Icon({
                style_class: `cd-resource-icon ${fillClass}`,
                gicon,
                x_align: Clutter.ActorAlign.CENTER,
            }));
            this.add_child(column);
            return bar;
        };
        this._cpu = createBar(extensionIcon('cpu-symbolic'), 'cd-accent-primary', 'Processor');
        this._memory = createBar(extensionIcon('memory-symbolic'), 'cd-accent-tertiary', 'Memory');
        this._disk = createBar(new Gio.ThemedIcon({name: 'drive-harddisk-symbolic'}), 'cd-accent-secondary', 'Storage');

        stats.connectObject('changed', () => this._sync(), this);
        this.connect('notify::mapped', () => this._sync());
    }

    _sync() {
        if (!this.mapped)
            return;

        const {cpu, memoryUsed, memoryTotal, diskUsed, diskTotal} = this._stats;
        this._cpu.setLevel(cpu);
        this._memory.setLevel(memoryTotal > 0 ? memoryUsed / memoryTotal : 0);
        this._disk.setLevel(diskTotal > 0 ? diskUsed / diskTotal : 0);
    }
});

// The Dashboard tab
const OverviewPage = GObject.registerClass(
class OverviewPage extends St.BoxLayout {
    constructor({weather, stats, media, wallClock}) {
        super({style_class: 'cd-page cd-overview', x_expand: true, y_expand: true});

        const left = new St.BoxLayout({
            style_class: 'cd-overview-column',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.add_child(left);

        const top = new St.BoxLayout({style_class: 'cd-overview-row'});
        left.add_child(top);
        top.add_child(new WeatherCard(weather));
        top.add_child(new UserCard());

        const bottom = new St.BoxLayout({style_class: 'cd-overview-row', y_expand: true});
        left.add_child(bottom);
        bottom.add_child(new ClockCard(wallClock));
        bottom.add_child(new CalendarCard());
        bottom.add_child(new ResourcesCard(stats));

        const mediaCard = createCard('cd-media-card', {y_expand: true});
        mediaCard.add_child(new MediaView(media, {compact: true}));
        this.add_child(mediaCard);
    }
});

// The Media tab
const MediaPage = GObject.registerClass(
class MediaPage extends St.BoxLayout {
    constructor(media) {
        super({style_class: 'cd-page', x_expand: true, y_expand: true});

        const card = createCard('cd-media-page-card', {x_expand: true, y_expand: true});
        card.add_child(new MediaView(media, {compact: false}));
        this.add_child(card);
    }
});

// A Performance tab card: a titled number with an optional bar below it
const StatCard = GObject.registerClass(
class StatCard extends St.BoxLayout {
    constructor(gicon, title, fillClass) {
        super({
            style_class: 'cd-card cd-stat',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });

        const header = new St.BoxLayout({style_class: 'cd-stat-header'});
        this.add_child(header);
        header.add_child(new St.Icon({style_class: `cd-stat-icon ${fillClass}`, gicon}));
        header.add_child(new St.Label({
            style_class: 'cd-stat-title',
            text: title,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this._value = new St.Label({style_class: 'cd-stat-value', y_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._value);

        this._detail = new St.Label({style_class: 'cd-stat-detail'});
        this.add_child(this._detail);

        this._bar = new LevelBar(Clutter.Orientation.HORIZONTAL, {
            style_class: `cd-stat-track ${fillClass}`,
            x_expand: true,
        });
        this.add_child(this._bar);
    }

    update(value, detail, level) {
        this._value.text = value;
        this._detail.text = detail;
        this._bar.visible = level !== null;
        if (level !== null)
            this._bar.setLevel(level);
    }
});

// The Performance tab
const PerformancePage = GObject.registerClass(
class PerformancePage extends St.BoxLayout {
    constructor(stats) {
        super({
            style_class: 'cd-page cd-performance',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });

        this._stats = stats;

        const top = new St.BoxLayout({style_class: 'cd-overview-row', y_expand: true});
        this.add_child(top);

        const cpuCard = createCard('cd-cpu', {x_expand: true, y_expand: true});
        top.add_child(cpuCard);

        const ringStack = new St.Widget({
            style_class: 'cd-cpu-ring',
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        cpuCard.add_child(ringStack);
        this._cpuRing = new ArcProgress(-Math.PI / 2, Math.PI * 2, {x_expand: true, y_expand: true});
        ringStack.add_child(this._cpuRing);
        this._cpuPercent = new St.Label({
            style_class: 'cd-cpu-percent',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        ringStack.add_child(this._cpuPercent);

        const cpuText = new St.BoxLayout({
            style_class: 'cd-cpu-text',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        cpuCard.add_child(cpuText);
        cpuText.add_child(new St.Label({style_class: 'cd-cpu-model', text: stats.cpuModel}));
        cpuText.add_child(new St.Label({style_class: 'cd-stat-detail', text: `${stats.threads} threads`}));
        this._temperature = new St.Label({style_class: 'cd-cpu-temperature'});
        cpuText.add_child(this._temperature);
        this._temperatureBar = new LevelBar(Clutter.Orientation.HORIZONTAL, {
            style_class: 'cd-stat-track cd-accent-primary',
            x_expand: true,
        });
        cpuText.add_child(this._temperatureBar);

        this._memory = new StatCard(extensionIcon('memory-symbolic'), 'Memory', 'cd-accent-tertiary');
        top.add_child(this._memory);

        const bottom = new St.BoxLayout({style_class: 'cd-overview-row', y_expand: true});
        this.add_child(bottom);

        this._disk = new StatCard(new Gio.ThemedIcon({name: 'drive-harddisk-symbolic'}), 'Storage', 'cd-accent-secondary');
        bottom.add_child(this._disk);
        this._network = new StatCard(new Gio.ThemedIcon({name: 'network-transmit-receive-symbolic'}), 'Network', 'cd-accent-primary');
        bottom.add_child(this._network);
        this._battery = new StatCard(new Gio.ThemedIcon({name: 'battery-symbolic'}), 'Battery', 'cd-accent-tertiary');
        bottom.add_child(this._battery);

        stats.connectObject('changed', () => this._sync(), this);
        this.connect('notify::mapped', () => this._sync());
    }

    _sync() {
        if (!this.mapped)
            return;

        const stats = this._stats;

        this._cpuRing.value = stats.cpu;
        this._cpuPercent.text = `${Math.round(stats.cpu * 100)}%`;

        const hasTemperature = stats.temperature !== null;
        this._temperature.visible = hasTemperature;
        this._temperatureBar.visible = hasTemperature;
        if (hasTemperature) {
            this._temperature.text = `${Math.round(stats.temperature)}°C`;
            this._temperatureBar.setLevel(stats.temperature / 100);
        }

        this._memory.update(
            `${Math.round(stats.memoryUsed / stats.memoryTotal * 100)}%`,
            `${GLib.format_size(stats.memoryUsed)} of ${GLib.format_size(stats.memoryTotal)}`,
            stats.memoryUsed / stats.memoryTotal);

        if (stats.diskTotal > 0) {
            this._disk.update(
                `${Math.round(stats.diskUsed / stats.diskTotal * 100)}%`,
                `${GLib.format_size(stats.diskUsed)} of ${GLib.format_size(stats.diskTotal)}`,
                stats.diskUsed / stats.diskTotal);
        }

        this._network.update(
            `↓ ${GLib.format_size(stats.downloadRate)}/s`,
            `↑ ${GLib.format_size(stats.uploadRate)}/s`,
            null);

        this._battery.visible = stats.battery !== null;
        if (stats.battery) {
            this._battery.update(
                `${Math.round(stats.battery.level * 100)}%`,
                stats.battery.status,
                stats.battery.level);
        }
    }
});

// The Workspaces tab: a card per workspace with the apps open on it. Clicking one goes there.
const WorkspacesPage = GObject.registerClass(
class WorkspacesPage extends St.BoxLayout {
    constructor() {
        super({style_class: 'cd-page cd-workspaces', x_expand: true, y_expand: true});

        global.workspace_manager.connectObject(
            'notify::n-workspaces', () => this._sync(),
            'workspace-switched', () => this._sync(),
            'workspaces-reordered', () => this._sync(),
            this);
        this.connect('notify::mapped', () => this._sync());
    }

    _createWorkspaceCard(workspace, index) {
        const tracker = Shell.WindowTracker.get_default();
        const windows = workspace.list_windows().filter(window => !window.skip_taskbar);
        const apps = [...new Set(windows.map(window => tracker.get_window_app(window)).filter(Boolean))];

        const content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        content.add_child(new St.Label({style_class: 'cd-workspace-title', text: `Workspace ${index + 1}`}));

        const windowCount = windows.length === 1 ? '1 window' : `${windows.length} windows`;
        content.add_child(new St.Label({
            style_class: 'cd-stat-detail',
            text: windows.length > 0 ? windowCount : 'Empty',
        }));

        const icons = new St.BoxLayout({style_class: 'cd-workspace-icons', y_expand: true, y_align: Clutter.ActorAlign.END});
        apps.forEach(app => icons.add_child(app.create_icon_texture(40)));
        content.add_child(icons);

        const card = new St.Button({
            style_class: 'cd-card cd-workspace',
            can_focus: true,
            x_expand: true,
            y_expand: true,
            child: content,
        });
        setStyleClass(card, 'current', workspace === global.workspace_manager.get_active_workspace());
        card.connect('clicked', () => {
            workspace.activate(global.get_current_time());
            Main.panel.closeCalendar();
        });
        return card;
    }

    _sync() {
        // Switching workspaces happens all the time with the dashboard closed
        if (!this.mapped)
            return;

        this.destroy_all_children();
        const manager = global.workspace_manager;
        for (let index = 0; index < manager.get_n_workspaces(); index++)
            this.add_child(this._createWorkspaceCard(manager.get_workspace_by_index(index), index));
    }
});

// The whole panel: the tab row and the page it selects
export const Dashboard = GObject.registerClass(
class Dashboard extends St.BoxLayout {
    constructor(mediaSource, wallClock) {
        super({
            style_class: 'cd-panel',
            orientation: Clutter.Orientation.VERTICAL,
        });

        this._stats = new SystemStats();
        this._weather = new WeatherClient();
        this._media = new MediaController(mediaSource);

        this._tabsBox = new St.BoxLayout({style_class: 'cd-tabs', reactive: true});
        this._tabsBox.layout_manager.homogeneous = true;
        this._tabsBox.connect('scroll-event', (_, event) => this._onTabsScroll(event));
        this.add_child(this._tabsBox);

        const indicatorRow = new St.Widget({
            style_class: 'cd-tab-indicator-row',
            layout_manager: new Clutter.FixedLayout(),
        });
        this.add_child(indicatorRow);
        this._indicator = new St.Widget({style_class: 'cd-tab-indicator'});
        indicatorRow.add_child(this._indicator);

        this.add_child(new St.Widget({style_class: 'cd-tab-separator'}));

        this._pagesBox = new St.Widget({
            style_class: 'cd-pages',
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
        });
        this.add_child(this._pagesBox);

        this._tabs = [];
        this._pages = [];
        this._currentTab = -1;

        const dock = new NotificationDock();
        this._addTab(new Gio.ThemedIcon({name: 'view-grid-symbolic'}), 'Dashboard',
            new OverviewPage({weather: this._weather, stats: this._stats, media: this._media, wallClock}));
        this._addTab(new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'}), 'Media', new MediaPage(this._media));
        this._addTab(new Gio.ThemedIcon({name: 'speedometer-symbolic'}), 'Performance', new PerformancePage(this._stats));
        this._addTab(new Gio.ThemedIcon({name: 'focus-windows-symbolic'}), 'Workspaces', new WorkspacesPage());
        this._addTab(new Gio.ThemedIcon({name: 'preferences-system-notifications-symbolic'}), 'Notifications', dock);

        dock.connectObject('count-changed', (_, count) => this._setNotificationCount(count), this);
        this._setNotificationCount(Main.messageTray.getSources().reduce((sum, source) => sum + source.count, 0));

        this._selectTab(0);

        this.connect('notify::mapped', () => this._onMappedChanged());
        this.connect('destroy', () => {
            this._stopWeatherRefresh();
            if (this._prepareId)
                GLib.source_remove(this._prepareId);
            this._stopWaitingForPrepareFrame();
            this._stats.destroy();
            this._weather.destroy();
            this._media.destroy();
        });
    }

    _addTab(gicon, text, page) {
        const index = this._tabs.length;

        const content = new St.BoxLayout({
            style_class: 'cd-tab-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
        });
        content.add_child(new St.Icon({style_class: 'cd-tab-icon', gicon, x_align: Clutter.ActorAlign.CENTER}));

        const labelRow = new St.BoxLayout({style_class: 'cd-tab-label-row', x_align: Clutter.ActorAlign.CENTER});
        labelRow.add_child(new St.Label({style_class: 'cd-tab-label', text}));
        const badge = new St.Label({style_class: 'cd-tab-badge', visible: false});
        labelRow.add_child(badge);
        content.add_child(labelRow);

        const tab = new St.Button({
            style_class: 'cd-tab',
            accessible_name: text,
            can_focus: true,
            x_expand: true,
            child: content,
        });
        // Going by the press rather than the click makes the switch start that much sooner
        tab.connect('notify::pressed', () => {
            if (tab.pressed)
                this._selectTab(index);
        });
        tab.connect('clicked', () => this._selectTab(index));
        tab.badge = badge;
        this._tabsBox.add_child(tab);
        this._tabs.push(tab);

        page.hide();
        this._pagesBox.add_child(page);
        this._pages.push(page);
    }

    _setNotificationCount(count) {
        const {badge} = this._tabs[NOTIFICATIONS_TAB_INDEX];
        badge.text = `${count}`;
        badge.visible = count > 0;
    }

    _selectTab(index) {
        if (index === this._currentTab)
            return;

        const previousTab = this._tabs[this._currentTab];
        const previousPage = this._pages[this._currentTab];
        const direction = Math.sign(index - this._currentTab);
        const page = this._pages[index];

        previousTab?.remove_style_class_name('selected');
        previousPage?.ease({
            translation_x: -direction * PAGE_SLIDE_DISTANCE,
            opacity: 0,
            duration: ANIMATION_TIME,
            mode: ANIMATION_MODE,
            onComplete: () => previousPage.hide(),
        });
        this._tabs[index].add_style_class_name('selected');
        this._currentTab = index;

        page.remove_all_transitions();
        page.show();
        this._pagesBox.set_child_above_sibling(page, null);
        page.set({translation_x: direction * PAGE_SLIDE_DISTANCE, opacity: 0});
        page.ease({translation_x: 0, opacity: 255, duration: ANIMATION_TIME, mode: ANIMATION_MODE});

        if (this.mapped)
            this._syncIndicator(true);
    }

    // Tabs share the row's width evenly, and the indicator spans the selected tab's content. It moves
    // and stretches by transforms, since changing its real position and width would lay out everything.
    _syncIndicator(animate) {
        const tab = this._tabs[this._currentTab];
        const [, rowWidth] = this._tabsBox.get_preferred_width(-1);
        const [, width] = tab.child.get_preferred_width(-1);
        const [, baseWidth] = this._indicator.get_preferred_width(-1);
        const tabWidth = rowWidth / this._tabs.length;
        const target = {
            translation_x: tabWidth * this._currentTab + (tabWidth - width) / 2,
            scale_x: width / baseWidth,
        };

        this._indicator.remove_all_transitions();
        if (animate)
            this._indicator.ease({...target, duration: ANIMATION_TIME, mode: ANIMATION_MODE});
        else
            this._indicator.set(target);
    }

    _onTabsScroll(event) {
        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.LEFT)
            this._selectTab(Math.max(this._currentTab - 1, 0));
        else if (direction === Clutter.ScrollDirection.DOWN || direction === Clutter.ScrollDirection.RIGHT)
            this._selectTab(Math.min(this._currentTab + 1, this._tabs.length - 1));
        return Clutter.EVENT_STOP;
    }

    _onMappedChanged() {
        if (this.mapped) {
            this._syncIndicator(false);
            this._stats.start();
            this._media.start();
            this._weatherRefreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WEATHER_REFRESH_DELAY, () => {
                delete this._weatherRefreshId;
                this._weather.refresh();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._stopWeatherRefresh();
            this._stats.stop();
            this._media.stop();
        }
    }

    _stopWeatherRefresh() {
        if (this._weatherRefreshId)
            GLib.source_remove(this._weatherRefreshId);
        delete this._weatherRefreshId;
    }

    // Laying out a page and showing it for the first time takes long enough to spoil an animation, so
    // each page gets that over with ahead of time: one per step, for one frame, with the menu fully
    // transparent. The weather comes last, so the first open has it ready too.
    prepareInBackground(menu) {
        const popup = menu.actor;
        const pages = [...this._pages];
        this._prepareId = GLib.timeout_add(GLib.PRIORITY_LOW, PREPARE_INTERVAL, () => {
            if (popup.visible)
                return GLib.SOURCE_CONTINUE;

            // The first time it opens, the menu sets a max-height on itself, which restyles every widget
            // inside. Setting the same value now means that never happens during an animation.
            popup.ensure_style();
            menu.sourceActor._onOpenStateChanged(menu, false);

            const page = pages.shift();
            if (!page) {
                delete this._prepareId;
                this._weather.refresh();
                return GLib.SOURCE_REMOVE;
            }

            page.show();
            popup.opacity = 0;
            popup.show();
            this._prepareFrameId = global.stage.connect('after-update', () => {
                this._stopWaitingForPrepareFrame();
                if (!menu.isOpen)
                    popup.hide();
                page.visible = page === this._pages[this._currentTab];
            });
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopWaitingForPrepareFrame() {
        if (this._prepareFrameId)
            global.stage.disconnect(this._prepareFrameId);
        delete this._prepareFrameId;
    }
});
