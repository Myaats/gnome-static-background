const { Clutter, GLib, GObject, Graphene, Meta, St } = imports.gi;

const Gi = imports._gi;
const Background = imports.ui.background;
const DND = imports.ui.dnd;
const Main = imports.ui.main;
const OverviewControls = imports.ui.overviewControls;
const Params = imports.misc.params;
const Util = imports.misc.util;
const { WindowPreview } = imports.ui.windowPreview;
const Workspace = imports.ui.workspace;

function hookVfunc(proto, symbol, func) {
    proto[Gi.hook_up_vfunc_symbol](symbol, func);
}

const _Util = {
    overrideProto: function(proto, overrides) {
        const backup = {};
    
        for (var symbol in overrides) {
            if (symbol.startsWith('after_')) {
                const actualSymbol = symbol.slice('after_'.length);
                const fn = proto[actualSymbol];
                const afterFn = overrides[symbol]
                proto[actualSymbol] = function() {
                    const args = Array.prototype.slice.call(arguments);
                    const res = fn.apply(this, args);
                    afterFn.apply(this, args);
                    return res;
                };
                backup[actualSymbol] = fn;
            }
            else {
                backup[symbol] = proto[symbol];
                if (symbol.startsWith('vfunc')) {
                    hookVfunc(proto[Gi.gobject_prototype_symbol], symbol.slice(6), overrides[symbol]);
                }
                else {
                    proto[symbol] = overrides[symbol];
                }
            }
        }
        return backup;
    }
};

var staticBackgroundEnabled = false;
function staticBackgroundOverride() {
    if (!staticBackgroundEnabled) {
        let set_backgrounds = function() {
            if (global.static_background.bgManagers) {
                for (var bg of global.static_background.bgManagers) {
                    Main.overview._overview._controls._stateAdjustment.disconnectObject(bg);
                    bg.destroy();
                }
                delete global.static_background.bgManagers;
            }

            global.static_background.bgManagers = [];
            for (var monitor of Main.layoutManager.monitors) {
                let bgManager = new Background.BackgroundManager({
                    monitorIndex: monitor.index,
                    container: Main.layoutManager.overviewGroup,
                    vignette: true,
                });

                Main.overview._overview._controls._stateAdjustment.connectObject('notify::value', (v) => {
                    bgManager.backgroundActor.content.vignette_sharpness = 0;
                    bgManager.backgroundActor.content.brightness = Util.lerp(1, 0.75, Math.min(v.value, 1));
                }, bgManager);

                global.static_background.bgManagers.push(bgManager);
            }
        }
        set_backgrounds();
        global.static_background.bgMonitorsChangedID = Main.layoutManager.connectObject('monitors-changed', set_backgrounds)
        staticBackgroundEnabled = true;
    }
}

function staticBackgroundReset() {
    if (staticBackgroundEnabled) {
        Main.layoutManager.disconnectObject(global.static_background.bgMonitorChangedID);
        global.static_background.bgMonitorChangedID = null;
        for (var bg of global.static_background.bgManagers) {
            Main.overview._overview._controls._stateAdjustment.disconnectObject(bg);
            bg.destroy();
        }
        delete global.static_background.bgManagers;
        staticBackgroundEnabled = false;
    }
}

var scalingWorkspaceBackgroundEnabled = false;
function scalingWorkspaceBackgroundOverride() {
    if (!scalingWorkspaceBackgroundEnabled) {
        global.static_background.GSFunctions['Workspace'] = _Util.overrideProto(Workspace.Workspace.prototype, WorkspaceOverride);
        scalingWorkspaceBackgroundEnabled = true;
    }
}

function scalingWorkspaceBackgroundReset() {
    if (scalingWorkspaceBackgroundEnabled) {
        _Util.overrideProto(Workspace.Workspace.prototype, global.static_background.GSFunctions['Workspace']);
        scalingWorkspaceBackgroundEnabled = false;

        // Ensure that variables used by overview entry / exit animation have their proper values when the animation is disabled
        let controlsManager = Main.overview._overview._controls;
        controlsManager.dash.translation_x = 0;
        controlsManager._searchEntry.opacity = 255;
        controlsManager._thumbnailsBox.translation_x = 0;
    }
}

function override() {
    global.static_background.GSFunctions["WorkspaceLayout"] = _Util.overrideProto(Workspace.WorkspaceLayout.prototype, WorkspaceLayoutOverride);
}

function reset() {
    staticBackgroundReset();
    scalingWorkspaceBackgroundReset();
    _Util.overrideProto(Workspace.WorkspaceLayout.prototype, global.static_background.GSFunctions["WorkspaceLayout"]);
}

WorkspaceOverride = {
    _init: function (metaWorkspace, monitorIndex, overviewAdjustment) {
        St.Widget.prototype._init.call(this, {
            style_class: 'window-picker',
            pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
            layout_manager: new Clutter.BinLayout(),
        });

        const layoutManager = new Workspace.WorkspaceLayout(metaWorkspace, monitorIndex,
            overviewAdjustment);

        // Window previews
        this._container = new Clutter.Actor({
            reactive: true,
            x_expand: true,
            y_expand: true,
        });
        this._container.layout_manager = layoutManager;
        this.add_child(this._container);

        this.metaWorkspace = metaWorkspace;

        this._overviewAdjustment = overviewAdjustment;

        this.monitorIndex = monitorIndex;
        this._monitor = Main.layoutManager.monitors[this.monitorIndex];

        if (monitorIndex != Main.layoutManager.primaryIndex)
            this.add_style_class_name('external-monitor');

        const clickAction = new Clutter.ClickAction();
        clickAction.connectObject('clicked', action => {
            // Switch to the workspace when not the active one, leave the
            // overview otherwise.
            if (action.get_button() === 1 || action.get_button() === 0) {
                const leaveOverview = this._shouldLeaveOverview();

                this.metaWorkspace?.activate(global.get_current_time());
                if (leaveOverview)
                    Main.overview.hide();
            }
        });
        this.bind_property('mapped', clickAction, 'enabled', GObject.BindingFlags.SYNC_CREATE);
        this._container.add_action(clickAction);

        this.connectObject('style-changed', this._onStyleChanged.bind(this));
        this.connectObject('destroy', this._onDestroy.bind(this));

        this._skipTaskbarSignals = new Map();

        const windows = global.get_window_actors().map(a => a.meta_window)
            .filter(this._isMyWindow, this);

        // Create clones for windows that should be
        // visible in the Overview
        this._windows = [];
        for (let i = 0; i < windows.length; i++) {
            if (this._isOverviewWindow(windows[i]))
                this._addWindowClone(windows[i]);
        }

        // Track window changes, but let the window tracker process them first
        this.metaWorkspace?.connectObject(
            'window-added', this._windowAdded.bind(this), GObject.ConnectFlags.AFTER,
            'window-removed', this._windowRemoved.bind(this), GObject.ConnectFlags.AFTER,
            'notify::active', () => layoutManager.syncOverlays(), this);
        global.display.connectObject(
            'window-entered-monitor', this._windowEnteredMonitor.bind(this), GObject.ConnectFlags.AFTER,
            'window-left-monitor', this._windowLeftMonitor.bind(this), GObject.ConnectFlags.AFTER,
            this);
        this._layoutFrozenId = 0;


        // DND requires this to be set
        this._delegate = this;
    },
}

let WorkspaceLayoutOverride = {
    _adjustSpacingAndPadding(rowSpacing, colSpacing, containerBox) {
        if (this._sortedWindows.length === 0)
            return [rowSpacing, colSpacing, containerBox];

        // All of the overlays have the same chrome sizes,
        // so just pick the first one.
        const window = this._sortedWindows[0];

        const [topOversize, bottomOversize] = window.chromeHeights();
        const [leftOversize, rightOversize] = window.chromeWidths();

        const oversize =
            Math.max(topOversize, bottomOversize, leftOversize, rightOversize);

        if (rowSpacing !== null)
            rowSpacing += oversize;
        if (colSpacing !== null)
            colSpacing += oversize;

        return [rowSpacing, colSpacing, containerBox];
    },
}

function enable() {
	global.static_background = {};
    global.static_background.GSFunctions = {};

	override();
	staticBackgroundOverride();
    scalingWorkspaceBackgroundOverride();
}

function disable() {
	reset();
}
