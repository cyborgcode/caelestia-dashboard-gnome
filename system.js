import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';

// How often the numbers refresh while the dashboard is open, in seconds
const STATS_INTERVAL = 2;
// How long a weather reading stays good, in seconds
const WEATHER_MAX_AGE = 30 * 60;
// wttr.in finds the location from the request's IP address, and needs no account
const WEATHER_URL = 'https://wttr.in/?format=j1';

const WEATHER_ICONS = [
    [[113], 'weather-clear-symbolic'],
    [[116], 'weather-few-clouds-symbolic'],
    [[119, 122], 'weather-overcast-symbolic'],
    [[143, 248, 260], 'weather-fog-symbolic'],
    [[200, 386, 389, 392, 395], 'weather-storm-symbolic'],
    [[179, 182, 227, 230, 317, 320, 323, 326, 329, 332, 335, 338, 350, 362, 365, 368, 371, 374, 377],
        'weather-snow-symbolic'],
];
const WEATHER_ICON_RAIN = 'weather-showers-symbolic';

const textDecoder = new TextDecoder();

function readText(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return textDecoder.decode(bytes);
    } catch {
        return null;
    }
}

function listDirectory(path) {
    try {
        const dir = GLib.Dir.open(path, 0);
        const names = [];
        for (let name = dir.read_name(); name; name = dir.read_name())
            names.push(name);
        dir.close();
        return names;
    } catch {
        return [];
    }
}

function findTemperatureFile() {
    const hwmon = '/sys/class/hwmon';
    for (const dir of listDirectory(hwmon)) {
        const name = readText(`${hwmon}/${dir}/name`)?.trim();
        if (name === 'coretemp' || name === 'k10temp' || name === 'zenpower')
            return `${hwmon}/${dir}/temp1_input`;
    }
    return '/sys/class/thermal/thermal_zone0/temp';
}

function findBatteryDirectory() {
    const supplies = '/sys/class/power_supply';
    const name = listDirectory(supplies).find(supply => supply.startsWith('BAT'));
    return name ? `${supplies}/${name}` : null;
}

export function formatUptime() {
    const seconds = parseFloat(readText('/proc/uptime') ?? '0');
    const counts = [
        [Math.floor(seconds / 86400), 'day'],
        [Math.floor(seconds / 3600) % 24, 'hour'],
        [Math.floor(seconds / 60) % 60, 'minute'],
    ];
    // The two largest units are plenty, and three don't fit the card
    const parts = counts.filter(([count]) => count > 0).slice(0, 2)
        .map(([count, unit]) => `${count} ${unit}${count === 1 ? '' : 's'}`);
    return parts.length > 0 ? `up ${parts.join(', ')}` : 'up less than a minute';
}

// The live numbers behind the resource bars and the Performance tab, read only while they show
export const SystemStats = GObject.registerClass({
    Signals: {'changed': {}},
}, class SystemStats extends GObject.Object {
    constructor() {
        super();

        this.cpu = 0;
        this.temperature = null;
        this.memoryUsed = 0;
        this.memoryTotal = 0;
        this.diskUsed = 0;
        this.diskTotal = 0;
        this.downloadRate = 0;
        this.uploadRate = 0;
        this.battery = null;

        this.cpuModel = /^model name\s*:\s*(.+)$/m.exec(readText('/proc/cpuinfo') ?? '')?.[1] ?? 'Processor';
        this.threads = GLib.get_num_processors();

        this._temperatureFile = findTemperatureFile();
        this._batteryDirectory = findBatteryDirectory();
        this._cpuBusy = 0;
        this._cpuTotal = 0;
        this._received = null;
        this._sent = null;
        this._lastUpdate = 0;
    }

    start() {
        if (this._timeoutId)
            return;

        this._update();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, STATS_INTERVAL, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        delete this._timeoutId;
    }

    _update() {
        this._updateCpu();
        this._updateMemory();
        this._updateDisk();
        this._updateNetwork();
        this._updateBattery();

        const temperature = parseInt(readText(this._temperatureFile));
        this.temperature = Number.isNaN(temperature) ? null : temperature / 1000;

        this.emit('changed');
    }

    _updateCpu() {
        const fields = (readText('/proc/stat') ?? '').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
        const total = fields.reduce((sum, field) => sum + field, 0);
        // The fourth and fifth fields are idle and waiting on I/O
        const busy = total - (fields[3] ?? 0) - (fields[4] ?? 0);

        if (total > this._cpuTotal)
            this.cpu = (busy - this._cpuBusy) / (total - this._cpuTotal);
        this._cpuBusy = busy;
        this._cpuTotal = total;
    }

    _updateMemory() {
        const memoryInfo = readText('/proc/meminfo') ?? '';
        const read = key => parseInt(new RegExp(`^${key}:\\s*(\\d+)`, 'm').exec(memoryInfo)?.[1] ?? '0') * 1024;
        this.memoryTotal = read('MemTotal');
        this.memoryUsed = this.memoryTotal - read('MemAvailable');
    }

    _updateDisk() {
        try {
            const info = Gio.File.new_for_path('/').query_filesystem_info(
                `${Gio.FILE_ATTRIBUTE_FILESYSTEM_SIZE},${Gio.FILE_ATTRIBUTE_FILESYSTEM_FREE}`, null);
            this.diskTotal = info.get_attribute_uint64(Gio.FILE_ATTRIBUTE_FILESYSTEM_SIZE);
            this.diskUsed = this.diskTotal - info.get_attribute_uint64(Gio.FILE_ATTRIBUTE_FILESYSTEM_FREE);
        } catch {
            this.diskTotal = 0;
            this.diskUsed = 0;
        }
    }

    _updateNetwork() {
        let received = 0;
        let sent = 0;
        for (const line of (readText('/proc/net/dev') ?? '').split('\n').slice(2)) {
            const [name, counters] = line.trim().split(/:\s*/);
            // Virtual interfaces only repeat traffic that the physical ones already count
            if (!counters || /^(lo|docker|veth|br-|virbr)/.test(name))
                continue;
            const fields = counters.split(/\s+/).map(Number);
            received += fields[0];
            sent += fields[8];
        }

        const now = GLib.get_monotonic_time();
        const elapsed = (now - this._lastUpdate) / GLib.USEC_PER_SEC;
        if (this._received !== null && elapsed < STATS_INTERVAL * 2) {
            this.downloadRate = Math.max(received - this._received, 0) / elapsed;
            this.uploadRate = Math.max(sent - this._sent, 0) / elapsed;
        } else {
            this.downloadRate = 0;
            this.uploadRate = 0;
        }
        this._received = received;
        this._sent = sent;
        this._lastUpdate = now;
    }

    _updateBattery() {
        if (!this._batteryDirectory)
            return;

        const level = parseInt(readText(`${this._batteryDirectory}/capacity`));
        this.battery = Number.isNaN(level) ? null : {
            level: level / 100,
            status: readText(`${this._batteryDirectory}/status`)?.trim() ?? '',
        };
    }

    destroy() {
        this.stop();
    }
});

export const WeatherClient = GObject.registerClass({
    Signals: {'changed': {}},
}, class WeatherClient extends GObject.Object {
    constructor() {
        super();

        this.temperature = '--';
        this.description = 'Loading weather…';
        this.iconName = 'weather-few-clouds-symbolic';

        this._session = new Soup.Session({timeout: 15});
        this._cancellable = new Gio.Cancellable();
        this._fetchedAt = 0;
        this._fetching = false;
    }

    refresh() {
        const age = (GLib.get_monotonic_time() - this._fetchedAt) / GLib.USEC_PER_SEC;
        if (this._fetching || (this._fetchedAt > 0 && age < WEATHER_MAX_AGE))
            return;

        this._fetching = true;
        const message = Soup.Message.new('GET', WEATHER_URL);
        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable, (session, result) => {
            if (this._cancellable.is_cancelled())
                return;

            this._fetching = false;
            try {
                const bytes = session.send_and_read_finish(result);
                const [current] = JSON.parse(textDecoder.decode(bytes.get_data())).current_condition;
                const code = parseInt(current.weatherCode);

                this.temperature = `${current.temp_C}°C`;
                this.description = current.weatherDesc[0].value;
                this.iconName = WEATHER_ICONS.find(([codes]) => codes.includes(code))?.[1] ?? WEATHER_ICON_RAIN;
                this._fetchedAt = GLib.get_monotonic_time();
            } catch (error) {
                console.warn(`Caelestia Dashboard: couldn't read the weather: ${error.message}`);

                // A reading that's still fresh enough is better than no reading
                if (this._fetchedAt === 0) {
                    this.description = 'Weather unavailable';
                    this.iconName = 'weather-severe-alert-symbolic';
                }
            }
            this.emit('changed');
        });
    }

    destroy() {
        this._cancellable.cancel();
        this._session.abort();
    }
});
