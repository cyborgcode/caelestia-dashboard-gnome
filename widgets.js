import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

// Smaller changes than this aren't worth animating a bar for
const MIN_LEVEL_CHANGE = 0.01;

export function setStyleClass(actor, name, enabled) {
    if (enabled)
        actor.add_style_class_name(name);
    else
        actor.remove_style_class_name(name);
}

// Outlines the concave corner that blends a panel into the top bar, in a size by size square at x. The
// panel is on its right for END and on its left for START.
export function addPanelEarPath(cr, x, size, panelSide) {
    if (panelSide === Clutter.ActorAlign.END) {
        cr.moveTo(x + size, size);
        cr.lineTo(x + size, 0);
        cr.lineTo(x, 0);
        cr.arc(x, size, size, -Math.PI / 2, 0);
    } else {
        cr.moveTo(x, size);
        cr.lineTo(x, 0);
        cr.lineTo(x + size, 0);
        cr.arcNegative(x + size, size, size, -Math.PI / 2, Math.PI);
    }
}

// Crops an image to a circle
export const CircleClipEffect = GObject.registerClass(
class CircleClipEffect extends Shell.GLSLEffect {
    vfunc_build_pipeline() {
        const declarations = 'uniform sampler2D tex;\n';
        const code = `
            cogl_color_out = cogl_color_in * texture2D(tex, cogl_tex_coord_in[0].xy);
            cogl_color_out *= 1.0 - smoothstep(0.48, 0.5, distance(cogl_tex_coord_in[0].xy, vec2(0.5)));
        `;
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, declarations, code, true);
    }
});

// A circular progress arc, in radians measured clockwise from three o'clock. CSS sets its colours
// through color and -arc-track-color, and its thickness through -arc-width.
export const ArcProgress = GObject.registerClass(
class ArcProgress extends St.DrawingArea {
    constructor(startAngle, sweepAngle, params) {
        super({style_class: 'cd-arc', ...params});
        this._startAngle = startAngle;
        this._sweepAngle = sweepAngle;
        this._value = 0;
    }

    set value(value) {
        this._value = Math.clamp(value, 0, 1);
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const node = this.get_theme_node();
        const [width, height] = this.get_surface_size();
        const thickness = node.get_length('-arc-width');
        const radius = Math.min(width, height) / 2 - thickness / 2;

        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(thickness);

        cr.setSourceColor(node.get_color('-arc-track-color'));
        cr.arc(width / 2, height / 2, radius, this._startAngle, this._startAngle + this._sweepAngle);
        cr.stroke();

        if (this._value > 0) {
            cr.setSourceColor(node.get_foreground_color());
            cr.arc(width / 2, height / 2, radius, this._startAngle,
                this._startAngle + this._sweepAngle * this._value);
            cr.stroke();
        }

        cr.$dispose();
    }
});

// A rounded bar that fills up from the bottom or the left. It draws itself, because resizing a child
// on every frame would make the whole dashboard lay itself out again. CSS sets its colours through
// color and -bar-track-color.
export const LevelBar = GObject.registerClass({
    Properties: {
        'level': GObject.ParamSpec.double(
            'level', null, null,
            GObject.ParamFlags.READWRITE,
            0, 1, 0),
    },
}, class LevelBar extends St.DrawingArea {
    constructor(orientation, params) {
        super(params);
        this._orientation = orientation;
        this._level = 0;
        this._target = 0;
    }

    get level() {
        return this._level;
    }

    set level(level) {
        this._level = level;
        this.notify('level');
        this.queue_repaint();
    }

    setLevel(level) {
        const target = Math.clamp(level, 0, 1);
        if (Math.abs(target - this._target) < MIN_LEVEL_CHANGE)
            return;

        this._target = target;
        this.ease_property('level', target, {
            duration: 400,
            progress_mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _addBar(cr, x, y, width, height) {
        const radius = Math.min(width, height) / 2;
        cr.newSubPath();
        cr.arc(x + width - radius, y + radius, radius, -Math.PI / 2, 0);
        cr.arc(x + width - radius, y + height - radius, radius, 0, Math.PI / 2);
        cr.arc(x + radius, y + height - radius, radius, Math.PI / 2, Math.PI);
        cr.arc(x + radius, y + radius, radius, Math.PI, Math.PI * 1.5);
        cr.closePath();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const node = this.get_theme_node();
        const [width, height] = this.get_surface_size();

        cr.setSourceColor(node.get_color('-bar-track-color'));
        this._addBar(cr, 0, 0, width, height);
        cr.fill();

        if (this._level > 0) {
            cr.setSourceColor(node.get_foreground_color());
            if (this._orientation === Clutter.Orientation.VERTICAL)
                this._addBar(cr, 0, height * (1 - this._level), width, height * this._level);
            else
                this._addBar(cr, 0, 0, width * this._level, height);
            cr.fill();
        }

        cr.$dispose();
    }
});
