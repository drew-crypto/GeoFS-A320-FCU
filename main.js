// ==UserScript==
// @name        GeoFS A320 FCU & Autothrottle - Combined Edition
// @namespace   GeoFS-A320-FCU-AT
// @version     7.1
// @description A320 FCU replica with DSEG displays, integrated Meatbroc Autothrottle, metric alt conversion, AP sync, gear/parking brake independent right-click visual toggle, flaps/spoilers, engine ignition trigger, immediate Mach autopilot mode toggle, zebra-striped trim wheel with mouse scroll/custom binds, clear gear indicators, scroll-to-zoom panel sizing, integrated Holding System, and custom PA button.
// @match       https://www.geo-fs.com/*
// @match       https://geo-fs.com/*
// @grant       none
// ==/UserScript==

(function () {
    'use strict';

    /* ============================================================
        EMBEDDED MEATBROC AUTOTHROTTLE ENGINE
        ============================================================ */
    function initAutothrottleEngine() {
        if (typeof geofs === 'undefined') return;
        if (!geofs.autothrottle) {
            geofs.autothrottle = {
                on: false,
                armed: false,
                init: function () {
                    geofs.autothrottle.initStyles();
                    geofs.autothrottle.callbackID = geofs.api.addFrameCallback(geofs.autothrottle.tickWrapper);

                    $(document).on("autothrottleOn", function() {
                        clearTimeout(geofs.autothrottle.panelTimeout);
                        geofs.autopilot.setArm(false);
                        geofs.autothrottle.on = true;
                        var a = Math.round(geofs.animation.values.kias);
                        if (geofs.autopilot.setAutothrottleSpeedMode && geofs.autopilot.speedMode) {
                            geofs.autopilot.setAutothrottleSpeedMode(geofs.autopilot.speedMode);
                        }
                        geofs.autopilot.setSpeed(a);
                    });

                    $(document).on("autothrottleOff", function() {
                        geofs.autothrottle.on = false;
                        if (geofs.autopilot.setSpeedMode && geofs.autopilot.speedMode) {
                            geofs.autopilot.setSpeedMode(geofs.autopilot.speedMode);
                        }
                    });

                    $(document).on("autopilotOn", () => {
                        if (geofs.autopilot.setSpeedMode) geofs.autopilot.setSpeedMode("knots");
                        if (geofs.animation && geofs.animation.values) geofs.autopilot.setSpeed(geofs.animation.values.kias);
                        geofs.autothrottle.on && $(document).trigger("autothrottleOff");
                    });

                    const o = controls.axisSetters.throttle.process;
                    controls.axisSetters.throttle.process = function (e, t) {
                        if (geofs.autothrottle.on) return;
                        o(e, t);
                    };
                },
                initStyles: function () {
                    if (document.getElementById('meatbroc-at-style')) return;
                    const style = document.createElement("style");
                    style.id = 'meatbroc-at-style';
                    style.innerHTML = `
                       .ext-autothrottle-pad { width: 60px; margin: 0px 10px; }
                       .ext-autothrottle-bar { white-space: nowrap; display: flex; align-items: flex-start; pointer-events: all; }
                    `;
                    document.head.appendChild(style);
                },
                toggle: function () {
                    if (!geofs.autothrottle.error) {
                        if (geofs.autothrottle.on) {
                            $(document).trigger("autothrottleOff");
                        } else {
                            $(document).trigger("autothrottleOn");
                        }
                    }
                },
                tick: function (a, b) {
                    var A = clamp(Math.floor(b / geofs.api.renderingSettings.physicsDeltaMs), 1, 10),
                        B = a / A;
                    var c = geofs.animation.values,
                        d = geofs.autopilot,
                        e = d.values.speed,
                        f = c.kias;
                    if (d.speedMode == "mach") {
                        e = geofs.utils.machToKnots(d.values.speed);
                        f = geofs.utils.machToKnots(c.mach);
                    }
                    d.PIDs.throttle.set(e, 0, 1);
                    controls.throttle = d.PIDs.throttle.compute(f, B);
                    controls.throttle = clamp(controls.throttle, 0, 1);
                },
                tickWrapper: function (a) {
                    if (geofs.autothrottle.on) {
                        if (geofs.aircraft.instance.groundContact && geofs.autothrottle.armed) {
                            controls.throttle = 0;
                            $(document).trigger("autothrottleOff");
                            return;
                        }
                        var b = a - geofs.utils.now();
                        var c = b / 1E3;
                        try {
                            geofs.autothrottle.tick(c, b);
                        } catch (err) {
                            geofs.autothrottle.handleError(err);
                        }
                    }
                },
                handleError: function (a) {
                    console.error(a);
                    ui.notification.show('An error with autothrottle occurred, autothrottle is now disabled.');
                    geofs.api.removeFrameCallback(geofs.autothrottle.callbackID);
                    $(document).trigger("autothrottleOff");
                    geofs.autothrottle.error = true;
                }
            };
            geofs.autothrottle.init();

            if (geofs.autopilot) {
                geofs.autopilot.setArm = function (a) {
                    const b = typeof a === 'string' ? JSON.parse(a) : a;
                    geofs.autothrottle.armed = b;
                };
                geofs.autopilot.setAutothrottleSpeedMode = function (e) {
                    var t = "mach" == e;
                    this.setSpeedMode(e);
                };
            }
        }
    }

    /* ============================================================
        TRIM MODEL & STATE INTEGRATION
        ============================================================ */
    const TRIM_STEP = 0.01;
    const TRIM_REPEAT_MS = 50;
    const MAX_TRIM = 0.5;
    const MAX_PITCH = 1;

    let trimValue = 0;
    const rawRef = { value: 0 };
    let currentAV = null;

    const trimBindings = {
        up: { type: 'keyboard', code: 'PageUp' },
        down: { type: 'keyboard', code: 'PageDown' },
        reset: { type: 'keyboard', code: 'KeyR' }
    };

    const savedTrimBinds = localStorage.getItem('geofs-a320-trim-binds');
    if (savedTrimBinds) {
        try { Object.assign(trimBindings, JSON.parse(savedTrimBinds)); } catch(e){}
    }

    function saveTrimBindings() {
        localStorage.setItem('geofs-a320-trim-binds', JSON.stringify(trimBindings));
    }

    function trimGetter() {
        return Math.max(-MAX_PITCH, Math.min(MAX_PITCH, rawRef.value + trimValue));
    }
    trimGetter._isTrimOverride = true;

    function ensureOverrides() {
        const av = geofs.aircraft.instance && geofs.aircraft.instance.animationValue;
        if (!av) return;

        const desc = Object.getOwnPropertyDescriptor(av, 'pitch');
        if (!desc || !desc.get || !desc.get._isTrimOverride) {
            currentAV = av;
            rawRef.value = av.pitch || 0;

            function defineOverride(propName) {
                Object.defineProperty(av, propName, {
                    get: trimGetter,
                    set(v) { rawRef.value = v; },
                    configurable: true
                });
            }

            defineOverride('rawPitch');
            defineOverride('pitch');
        }
    }

    /* ============================================================
        FCU STATE
        ============================================================ */
    const state = {
        speed: 250,
        isMach: false,
        heading: 360,
        track: false,
        altitude: 5000,
        altStep: 100,
        vs: 0,
        fpa: false,

        ap1: false,
        ap2: false,
        athr: false,
        loc: false,
        exped: false,
        appr: false,
        metricAlt: false,

        gearDown: true,
        flapsPosition: 0,
        spoilerState: 0,
        parkBrakeOn: false,
        wasOnGround: true,

        eng1Master: false,
        eng2Master: false,
        engMode: 'NORM',
        enginesTriggered: false,

        managedSpeed: true,
        managedHeading: true,
        managedAltitude: true,
        navMode: false
    };

    if (window.geofs && window.geofs.api) {
        try { window.geofs.api.removeFrameCallback('autoAirbrakesAndTrimSync'); } catch(e) {}
    }

    /* ============================================================
        TIMING & KEYBOARD BINDING STATE
        ============================================================ */
    let togglePanelKey = 'F1';
    let isListeningForKey = false;
    let listeningForTrimAction = null;
    let currentPanelWidth = 1090;

    const savedKey = localStorage.getItem('geofs-fcu-toggle-key');
    if (savedKey) {
        togglePanelKey = savedKey;
    }

    /* ============================================================
        EMBEDDED HOLD GENERATOR ENGINE & PANEL SETUP
        ============================================================ */
    function initHoldSystem() {
        if (window._holdGeneratorPanel) return;

        const SPEED_KTS = 230;
        const INBOUND_TIME_MIN = 1;
        const KEYBIND_STORAGE = "geofs_hold_generator_keybind";

        function generateHold(lat, lon, holdAlt, holdSpd) {
            const inboundNM = SPEED_KTS * INBOUND_TIME_MIN / 60;
            const widthNM = inboundNM / 2;
            const latOffset = inboundNM / 60;
            const lonOffset = widthNM / (60 * Math.cos(lat * Math.PI / 180));

            return [
                { ident: "FIX", type: "FIX", lat: lat, lon: lon, alt: holdAlt, spd: holdSpd },
                { ident: "NORTH_LEG", type: "FIX", lat: lat + latOffset, lon: lon, alt: holdAlt, spd: holdSpd },
                { ident: "EAST_NORTH", type: "FIX", lat: lat + latOffset, lon: lon + lonOffset, alt: holdAlt, spd: holdSpd },
                { ident: "EAST_SOUTH", type: "FIX", lat: lat, lon: lon + lonOffset, alt: holdAlt, spd: holdSpd },
                { ident: "FIX", type: "FIX", lat: lat, lon: lon, alt: holdAlt, spd: holdSpd }
            ];
        }

        function getCurrentFlightPlan() {
            try {
                const fp = window.geofs && geofs.flightPlan && geofs.flightPlan.waypointArray;
                if (!fp || !Array.isArray(fp) || fp.length === 0) return null;
                return fp.map(w => ({
                    id: typeof w.id !== "undefined" ? w.id : null,
                    ident: w.ident || w.name || null,
                    lat: Number(w.lat),
                    lon: Number(w.lon),
                    alt: typeof w.alt !== "undefined" ? w.alt : (typeof w.altitude !== "undefined" ? w.altitude : ""),
                    spd: typeof w.spd !== "undefined" ? w.spd : (typeof w.speed !== "undefined" ? w.speed : "")
                }));
            } catch (e) {
                console.error("Hold Generator - Flight plan read error:", e);
                return null;
            }
        }

        function findWaypointIndex(flightPlan, waypointName) {
            const searchName = waypointName.trim().toUpperCase();
            if (!searchName) return -1;
            for (let i = 0; i < flightPlan.length; i++) {
                const wp = flightPlan[i];
                const ident = String(wp.ident || "").trim().toUpperCase();
                if (ident === searchName) return i;
            }
            return -1;
        }

        const holdPanel = document.createElement("div");
        holdPanel.id = "holdGeneratorPanel";
        holdPanel.style.cssText = `
            position: fixed;
            top: 90px;
            right: 24px;
            width: 370px;
            background: linear-gradient(145deg, rgba(25,29,35,0.98), rgba(12,15,19,0.98));
            color: #22dd77;
            padding: 18px;
            border-radius: 14px;
            border: 1px solid rgba(255,255,255,0.10);
            z-index: 999999;
            font-family: Arial, Helvetica, sans-serif;
            box-shadow: 0 12px 40px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.05);
            backdrop-filter: blur(10px);
            user-select: none;
            display: none;
        `;

        holdPanel.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;">
                <div>
                    <div style="font-size:19px; font-weight:700; letter-spacing:0.5px;">HOLD GENERATOR</div>
                    <div style="margin-top:3px; font-size:11px; color:#22dd77; letter-spacing:0.8px;">IFR HOLDING PATTERN</div>
                </div>
                <div style="width:34px; height:34px; border-radius:9px; display:flex; align-items:center; justify-content:center; background:rgba(25,118,210,0.18); color:#22dd77; font-size:18px; font-weight:bold;">⟳</div>
            </div>
            <div style="background:rgba(255,255,255,0.035); border:1px solid rgba(255,255,255,0.06); border-radius:10px; padding:11px 13px; margin-bottom:12px;">
                <div style="display:flex; align-items:center; justify-content:space-between;">
                    <div>
                        <div style="font-size:11px; font-weight:bold; color:#7f8b99; letter-spacing:1px; margin-bottom:3px;">PANEL KEYBIND</div>
                        <div id="keybindStatus" style="font-size:12px; color:#b9c2cc;">No key assigned</div>
                    </div>
                    <button id="setKeybind" style="padding:7px 11px; border:1px solid #3b4652; border-radius:7px; background:#252b32; color:#e8edf2; font-size:11px; font-weight:700; cursor:pointer;">SET KEY</button>
                </div>
            </div>
            <div style="background:rgba(255,255,255,0.035); border:1px solid rgba(255,255,255,0.06); border-radius:10px; padding:13px; margin-bottom:12px;">
                <div style="font-size:11px; font-weight:bold; color:#7f8b99; letter-spacing:1px; margin-bottom:10px;">HOLD FIX</div>
                <div style="font-size:12px; color:#b9c2cc; margin-bottom:6px;">Waypoint name</div>
                <input id="holdWaypoint" type="text" placeholder="Example: FIX" autocomplete="off" spellcheck="false" style="width:100%; box-sizing:border-box; padding:10px 11px; border-radius:7px; border:1px solid #39424d; background:#15191e; color:#ffffff; outline:none; font-size:13px; text-transform:uppercase;">
            </div>
            <div style="background:rgba(255,255,255,0.035); border:1px solid rgba(255,255,255,0.06); border-radius:10px; padding:13px; margin-bottom:12px;">
                <div style="font-size:11px; font-weight:bold; color:#7f8b99; letter-spacing:1px; margin-bottom:10px;">HOLD PARAMETERS</div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
                    <div>
                        <div style="font-size:12px; color:#b9c2cc; margin-bottom:6px;">Altitude</div>
                        <input id="holdAlt" type="number" step="1" placeholder="5000" style="width:100%; box-sizing:border-box; padding:10px; border-radius:7px; border:1px solid #39424d; background:#15191e; color:#ffffff; outline:none; font-size:13px;">
                    </div>
                    <div>
                        <div style="font-size:12px; color:#b9c2cc; margin-bottom:6px;">Speed</div>
                        <input id="holdSpd" type="number" step="1" placeholder="230" style="width:100%; box-sizing:border-box; padding:10px; border-radius:7px; border:1px solid #39424d; background:#15191e; color:#ffffff; outline:none; font-size:13px;">
                    </div>
                </div>
            </div>
            <button id="generateHold" style="width:100%; padding:11px; border:none; border-radius:8px; background:#1976d2; color:white; font-weight:700; font-size:13px; letter-spacing:0.3px; cursor:pointer; margin-bottom:8px;">GENERATE HOLD</button>
            <button id="copyHold" style="width:100%; padding:10px; border:1px solid #3b4652; border-radius:8px; background:#22dd77; color:#ffffff; font-weight:600; font-size:12px; cursor:pointer; margin-bottom:12px;">COPY JSON</button>
            <div style="font-size:11px; font-weight:bold; color:#7f8b99; letter-spacing:1px; margin-bottom:6px;">OUTPUT</div>
            <textarea id="holdOutput" readonly placeholder="Generated flight plan will appear here..." style="width:100%; height:260px; box-sizing:border-box; resize:vertical; padding:10px; border-radius:8px; border:1px solid #303841; background:#0c0f12; color:#63e6a4; font-family:Consolas,monospace; font-size:11px; line-height:1.45; outline:none;"></textarea>
            <div id="holdStatus" style="margin-top:10px; padding:8px 10px; border-radius:7px; background:rgba(255,255,255,0.035); color:#22dd77; font-size:11px; line-height:1.4;">230 kt • 1 min inbound • 3.83 NM • half-width</div>
        `;
        document.body.appendChild(holdPanel);
        window._holdGeneratorPanel = holdPanel;

        const closeButton = document.createElement("button");
        closeButton.textContent = "×";
        closeButton.title = "Hide Hold Generator";
        closeButton.style.cssText = `position:absolute; top:10px; right:10px; width:25px; height:25px; border:none; border-radius:6px; background:rgba(255,255,255,0.06); color:#9ba7b4; font-size:18px; line-height:20px; cursor:pointer;`;
        holdPanel.appendChild(closeButton);
        closeButton.onclick = () => { holdPanel.style.display = 'none'; };

        const keybindStatus = document.getElementById("keybindStatus");
        const setKeybindButton = document.getElementById("setKeybind");
        let assignedKey = localStorage.getItem(KEYBIND_STORAGE) || null;

        function updateKeybindDisplay() {
            if (assignedKey) {
                keybindStatus.textContent = "Toggle key: " + assignedKey;
                keybindStatus.style.color = "#63e6a4";
            } else {
                keybindStatus.textContent = "No key assigned";
                keybindStatus.style.color = "#b9c2cc";
            }
        }
        updateKeybindDisplay();

        let listeningForKey = false;
        setKeybindButton.onclick = () => {
            listeningForKey = true;
            setKeybindButton.textContent = "PRESS KEY...";
            setKeybindButton.style.background = "#1976d2";
            setKeybindButton.style.color = "#ffffff";
            keybindStatus.textContent = "Press any key to assign it...";
        };

        document.addEventListener("keydown", (e) => {
            if (listeningForKey) {
                e.preventDefault();
                e.stopPropagation();
                listeningForKey = false;
                if (e.key === "Escape") {
                    setKeybindButton.textContent = "SET KEY";
                    setKeybindButton.style.background = "#252b32";
                    setKeybindButton.style.color = "#e8edf2";
                    updateKeybindDisplay();
                    return;
                }
                assignedKey = e.code;
                localStorage.setItem(KEYBIND_STORAGE, assignedKey);
                setKeybindButton.textContent = "SET KEY";
                setKeybindButton.style.background = "#252b32";
                setKeybindButton.style.color = "#e8edf2";
                updateKeybindDisplay();
                return;
            }
        }, true);

        document.getElementById("generateHold").onclick = () => {
            const waypointName = document.getElementById("holdWaypoint").value.trim();
            const altInput = document.getElementById("holdAlt").value.trim();
            const spdInput = document.getElementById("holdSpd").value.trim();
            const holdAlt = altInput === "" ? "" : Number(altInput);
            const holdSpd = spdInput === "" ? "" : Number(spdInput);

            if (!waypointName) { alert("Please enter the waypoint name."); return; }
            const flightPlan = getCurrentFlightPlan();
            if (!flightPlan) { alert("No active GeoFS flight plan was found."); return; }
            const waypointIndex = findWaypointIndex(flightPlan, waypointName);
            if (waypointIndex === -1) { alert('Waypoint "' + waypointName + '" was not found.'); return; }

            const originalWaypoint = flightPlan[waypointIndex];
            const hold = generateHold(originalWaypoint.lat, originalWaypoint.lon, holdAlt, holdSpd);
            document.getElementById("holdOutput").value = JSON.stringify(hold, null, 2);
            document.getElementById("holdStatus").textContent = "✓ Found " + originalWaypoint.ident + " • " + originalWaypoint.lat.toFixed(6) + " / " + originalWaypoint.lon.toFixed(6);
        };

        document.getElementById("copyHold").onclick = async function () {
            const button = this;
            const waypointName = document.getElementById("holdWaypoint").value.trim();
            const altInput = document.getElementById("holdAlt").value.trim();
            const spdInput = document.getElementById("holdSpd").value.trim();
            const holdAlt = altInput === "" ? "" : Number(altInput);
            const holdSpd = spdInput === "" ? "" : Number(spdInput);

            if (!waypointName) { alert("Please enter the waypoint name."); return; }
            const flightPlan = getCurrentFlightPlan();
            if (!flightPlan) { alert("No active GeoFS flight plan was found."); return; }
            const waypointIndex = findWaypointIndex(flightPlan, waypointName);
            if (waypointIndex === -1) { alert('Waypoint not found.'); return; }

            const originalWaypoint = flightPlan[waypointIndex];
            const hold = generateHold(originalWaypoint.lat, originalWaypoint.lon, holdAlt, holdSpd);
            let highestID = -1;
            flightPlan.forEach(wp => { if (typeof wp.id === "number" && wp.id > highestID) highestID = wp.id; });
            const insertedHold = hold.slice(1).map((wp, index) => ({ id: highestID + index + 1, ident: wp.ident, lat: wp.lat, lon: wp.lon, alt: wp.alt, spd: wp.spd }));
            const modifiedFlightPlan = [...flightPlan.slice(0, waypointIndex + 1), ...insertedHold, ...flightPlan.slice(waypointIndex + 1)];
            const finalJSON = JSON.stringify(modifiedFlightPlan, null, 2);
            document.getElementById("holdOutput").value = finalJSON;
            try {
                await navigator.clipboard.writeText(finalJSON);
                button.textContent = "✓ COPIED FLIGHT PLAN";
                setTimeout(() => { button.textContent = "COPY JSON"; }, 1500);
            } catch (error) { alert("Could not copy flight plan."); }
        };
    }

    /* ============================================================
        CREATE PANEL DOM
        ============================================================ */
    const fcu = document.createElement('div');
    fcu.id = 'geofs-a320-fcu';

    fcu.innerHTML = `
        <div class="fcu-panel">
            <!-- TOP DIGITAL WINDOWS -->
            <div class="fcu-top">
                <div class="window spd-window">
                    <div class="label spd-mach-title">SPD / MACH</div>
                    <div class="digital speed-display">
                        <span class="val">250</span>
                        <b class="managed-dot">●</b>
                    </div>
                </div>

                <div class="window hdg-window">
                    <div class="label hdg-title">HDG / TRK</div>
                    <div class="digital heading-display">
                        <span class="val">360</span>
                        <b class="managed-dot">●</b>
                    </div>
                </div>

                <div class="window alt-window">
                    <div class="label alt-title">ALT <small class="unit-indicator">FT</small></div>
                    <div class="digital alt-display">
                        <span class="val">05000</span>
                        <b class="managed-dot">●</b>
                    </div>
                </div>

                <div class="window vs-window">
                    <div class="label vs-title">V/S / FPA</div>
                    <div class="digital vs-display">
                        <span class="val">+0000</span>
                    </div>
                </div>
            </div>

            <!-- MAIN FCU CONTROLS -->
            <div class="fcu-body">
                <!-- PARKING BRAKE SECTION (Far Left) -->
                <div class="section pbrake-section">
                    <div class="pbrake-plate" title="Left-click: Toggle Parking Brake & Control | Right-click: Toggle visual switch only">
                        <div class="pbrake-header">
                            <span class="pbrk-title">PARKING BRK</span>
                        </div>
                        <div class="pbrake-arc"></div>
                        <div class="pbrake-labels">
                            <span class="lbl-off">OFF</span>
                            <span class="lbl-on">ON</span>
                        </div>
                        <div class="pbrake-knob-container">
                            <div class="pbrake-knob off">
                                <div class="pbrake-fin"></div>
                                <div class="pbrake-handle">
                                    <span>PARK BRK</span>
                                </div>
                            </div>
                        </div>
                        <div class="screw pbrake-screw"></div>
                    </div>
                </div>

                <!-- FLAPS SECTION -->
                <div class="section flaps-section">
                    <div class="flaps-lever-plate" title="Left-click: Cycle Flaps (F) | Right-click: Decrease Flaps (]) | Scroll to change">
                        <div class="flaps-scale-labels">
                            <span class="f-lbl">0</span>
                            <span class="f-lbl">1</span>
                            <span class="f-lbl">2</span>
                            <span class="f-lbl">3</span>
                            <span class="f-lbl">FULL</span>
                        </div>
                        <div class="flaps-slot">
                            <div class="flaps-handle pos-0">
                                <div class="flaps-handle-head"></div>
                                <div class="flaps-center-button"></div>
                                <div class="flaps-shaft"></div>
                            </div>
                        </div>
                        <div class="screw flaps-screw"></div>
                    </div>
                </div>

                <!-- SPEED BRAKE / SPOILERS SECTION -->
                <div class="section spoilers-section">
                    <div class="spoilers-lever-plate" title="Click to cycle Spoilers: OFF -> ARMED -> ON">
                        <div class="spoilers-title-lbl">SPD BRAKE</div>
                        <div class="spoilers-scale-labels">
                            <span class="s-lbl">RET</span>
                            <span class="s-lbl">ARM</span>
                            <span class="s-lbl">FULL</span>
                        </div>
                        <div class="spoilers-slot">
                            <div class="spoilers-handle state-0">
                                <div class="spoilers-cap"></div>
                                <div class="spoilers-grip"></div>
                            </div>
                        </div>
                        <div class="screw spoilers-screw"></div>
                    </div>
                </div>

                <!-- ZEBRA STRIPED TRIM WHEEL SECTION -->
                <div class="section trim-section">
                    <div class="trim-wheel-plate" title="Scroll to trim | Click wheel to set custom Binds">
                        <div class="trim-title-lbl">PITCH TRIM</div>
                        <div class="trim-wheel-housing">
                            <div class="trim-rotating-drum">
                                <span class="drum-mark mark-dn2">DN 2</span>
                                <span class="drum-mark mark-dn1">DN 1</span>
                                <span class="drum-mark mark-zero">0</span>
                                <span class="drum-mark mark-up1">UP 1</span>
                                <span class="drum-mark mark-up2">UP 2</span>
                            </div>
                            <div class="trim-center-pointer"></div>
                        </div>
                        <div class="screw trim-screw"></div>
                    </div>
                </div>

                <!-- SPEED SECTION -->
                <div class="section speed-section">
                    <button class="fcu-button spd-mach-btn">SPD<br>MACH</button>
                    <div class="knob-label-above speed-lbl-above">SPD</div>
                    <div class="speed-knob knob-large" title="Scroll to change speed | Double-click for Flight Plan Speed (requires A/THR)">
                        <div class="knob-highlight"></div>
                    </div>
                    <!-- HOLD BUTTON RIGHT UNDER SPEED KNOB -->
                    <button class="fcu-button hold-sys-btn" title="Toggle Holding System Generator Panel">HOLD</button>
                </div>

                <!-- HEADING SECTION -->
                <div class="section heading-section">
                    <div class="section-label">LAT</div>
                    <div class="heading-knob knob-large" title="Scroll to change heading | Double-click for Flight Plan NAV">
                        <div class="heading-cap">
                            <div class="triangle"></div>
                        </div>
                    </div>
                    <!-- PA BUTTON BELOW HEADING KNOB -->
                    <button class="fcu-button pa-sys-btn" title="Toggle PA System">PA</button>
                </div>

                <div class="divider divider-one"></div>

                <!-- AP / MODE SECTION -->
                <div class="section mode-section">
                    <div class="hdg-trk-toggle small-round" title="Toggle HDG/TRK vs V/S/FPA"></div>
                    <div class="small-label hdg-trk-label">HDG V/S<br>TRK FPA</div>
                    <button class="fcu-button ap1">AP 1</button>
                    <button class="fcu-button ap2">AP 2</button>
                    <button class="fcu-button athr">A/THR</button>
                    <button class="fcu-button loc">LOC</button>
                </div>

                <div class="divider divider-two"></div>

                <!-- ALTITUDE SECTION -->
                <div class="section altitude-section">
                    <div class="alt-step-toggle" title="Click to toggle 100/1000 step">
                        <span class="step-100 active">100</span>
                        <span class="step-1000">1000</span>
                    </div>
                    <div class="knob-label-above alt-lbl-above">ALT</div>
                    <div class="alt-knob knob-large" title="Scroll to change altitude | Double-click for Flight Plan Altitude">
                        <div class="alt-cap"></div>
                    </div>
                    <button class="fcu-button exped">EXPED</button>
                    <button class="fcu-button metric-alt-btn">METRIC<br>ALT</button>
                </div>

                <!-- V/S SECTION -->
                <div class="section vs-section">
                    <div class="section-label">V/S</div>
                    <div class="vs-knob knob-large" title="Scroll up/down to set Vertical Speed">
                        <div class="vs-cap"></div>
                    </div>
                    <button class="fcu-button appr">APPR</button>
                </div>

                <!-- ENGINE PANEL SECTION -->
                <div class="section eng-panel-section">
                    <div class="eng-panel-plate">
                        <div class="eng-panel-header">ENG</div>
                        <div class="eng-master-container master-1-cont">
                            <span class="eng-master-lbl-top">MASTER 1</span>
                            <div class="eng-labels-side">
                                <span class="lbl-on-side">ON</span>
                                <span class="lbl-off-side">OFF</span>
                            </div>
                            <div class="eng-master-switch off" data-engine="1" title="Toggle Engine 1 Master">
                                <div class="eng-switch-guard"></div>
                                <div class="eng-switch-face">
                                    <span>ENG<br>1</span>
                                </div>
                            </div>
                        </div>
                        <div class="eng-master-container master-2-cont">
                            <span class="eng-master-lbl-top">MASTER 2</span>
                            <div class="eng-labels-side">
                                <span class="lbl-on-side">ON</span>
                                <span class="lbl-off-side">OFF</span>
                            </div>
                            <div class="eng-master-switch off" data-engine="2" title="Toggle Engine 2 Master">
                                <div class="eng-switch-guard"></div>
                                <div class="eng-switch-face">
                                    <span>ENG<br>2</span>
                                </div>
                            </div>
                        </div>
                        <div class="eng-mode-selector-area">
                            <span class="mode-title-lbl">MODE</span>
                            <span class="mode-norm-lbl">NORM</span>
                            <div class="mode-arc"></div>
                            <span class="mode-crank-lbl">CRANK</span>
                            <span class="mode-start-lbl">IGN /<br>START</span>
                            <div class="mode-knob norm" title="Click to cycle start mode: CRANK -> NORM -> IGN/START">
                                <div class="mode-knob-indicator"></div>
                            </div>
                        </div>
                        <div class="screw eng-screw"></div>
                    </div>
                </div>

                <!-- LANDING GEAR SECTION (Far Right) -->
                <div class="section gear-section">
                    <div class="gear-lever-plate" title="Left-click: Toggle gear & control | Right-click: Toggle lever position only">
                        <div class="gear-graphic-up">
                            <span class="gear-text-up">UP</span>
                            <div class="gear-arrow-up"></div>
                        </div>
                        <div class="gear-slot">
                            <div class="gear-handle down">
                                <div class="gear-wheel-left"></div>
                                <div class="gear-knob-body"></div>
                                <div class="gear-wheel-right"></div>
                                <div class="gear-pointer"></div>
                            </div>
                        </div>
                        <div class="gear-graphic-down">
                            <div class="gear-arrow-down"></div>
                            <span class="gear-text-down">DOWN</span>
                        </div>
                        <div class="screw gear-screw"></div>
                    </div>
                    <div class="gear-lights-container">
                        <div class="gear-position-light up-light" title="Gear UP Light"></div>
                        <div class="gear-position-light dn-light" title="Gear DOWN Light"></div>
                    </div>
                </div>

                <!-- SCREWS & DRAG HANDLE -->
                <div class="screw screw-1"></div>
                <div class="screw screw-2"></div>
                <div class="screw screw-3"></div>
                <div class="screw screw-4"></div>

                <div class="drag-handle" title="Right-click to bind toggle key | Drag to move | Scroll on panel to resize">
                    A320 FCU <span class="toggle-key-display">(${togglePanelKey})</span>
                </div>
            </div>
        </div>

        <!-- TRIM BINDINGS MODAL -->
        <div id="trim-binds-modal">
            <div class="modal-title">TRIM BINDINGS</div>
            <div class="bind-row">
                <span>TRIM UP:</span>
                <button id="bind-up-btn" class="bind-btn">SET</button>
            </div>
            <div class="bind-row">
                <span>TRIM DOWN:</span>
                <button id="bind-down-btn" class="bind-btn">SET</button>
            </div>
            <div class="bind-row">
                <span>TRIM RESET:</span>
                <button id="bind-reset-btn" class="bind-btn">SET</button>
            </div>
            <button id="close-modal-btn" class="bind-btn close-btn">CLOSE</button>
        </div>
    `;
    document.body.appendChild(fcu);

    /* ============================================================
        STYLES (CSS) & 14-SEGMENT DIGITAL FONT IMPORT
        ============================================================ */
    const css = document.createElement('style');
    css.textContent = `
    @import url('https://cdn.jsdelivr.net/npm/dseg@0.4.6/css/dseg.css');

    #geofs-a320-fcu {
        position: fixed;
        left: 20%;
        top: 20px;
        z-index: 999999;
        user-select: none;
        font-family: Arial, Helvetica, sans-serif;
        width: 1090px;
        height: 224px;
        min-width: 400px;
        min-height: 110px;
        overflow: hidden;
        background: transparent;
    }

    .fcu-panel {
        position: absolute;
        width: 1610px;
        height: 320px;
        border-radius: 8px;
        background: linear-gradient(180deg, #455a6d 0%, #354a5b 50%, #293e4f 100%);
        box-shadow: 0 8px 30px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,255,255,.16), inset 0 -5px 10px rgba(0,0,0,.35);
        border: 2px solid #1a2733;
        transform-origin: top left;
        box-sizing: border-box;
    }

    .fcu-top { position: absolute; left: 40px; right: 40px; top: 25px; height: 75px; display: flex; gap: 12px; }
    .window { height: 70px; background: linear-gradient(180deg, #020303, #111313 55%, #020202); border: 2px solid #222; border-radius: 4px; box-shadow: inset 0 0 13px #000, 0 1px 2px rgba(255,255,255,.08); position: relative; }
    .spd-window { width: 190px; }
    .hdg-window { width: 190px; }
    .alt-window { width: 280px; }
    .vs-window  { flex: 1; }

    .label { position: absolute; left: 10px; top: 6px; color: #fff1a5; font-size: 13px; font-weight: bold; letter-spacing: .5px; }
    .unit-indicator { font-size: 10px; color: #ffe36e; margin-left: 5px; }

    .digital { position: absolute; color: #ffe66f; font-family: 'DSEG14-Classic', 'DSEG7-Classic', 'Quartz', monospace; font-style: italic; font-size: 38px; line-height: 38px; bottom: 8px; right: 15px; text-shadow: 0 0 4px rgba(255,225,90,.6); display: flex; align-items: center; gap: 6px; }
    .managed-dot { font-family: Arial, sans-serif; font-style: normal; font-size: 20px; margin-left: 4px; vertical-align: middle; flex-shrink: 0; }

    .fcu-body { position: absolute; left: 0; right: 0; top: 110px; bottom: 0; }
    .section { position: absolute; top: 10px; height: 190px; }
    .section-label { position: absolute; top: 0; left: 50%; transform: translateX(-50%); color: #fff1a5; font-weight: bold; font-size: 14px; }

    .knob-label-above {
        position: absolute;
        color: #fff1a5;
        font-weight: bold;
        font-size: 12px;
        letter-spacing: 0.5px;
        text-align: center;
        width: 76px;
    }
    .speed-lbl-above { left: 100px; top: 8px; }
    .alt-lbl-above { left: 95px; top: 8px; }

    .pbrake-section { left: 35px; width: 80px; }
    .flaps-section { left: 125px; width: 55px; }
    .spoilers-section { left: 190px; width: 55px; }
    .trim-section { left: 250px; width: 65px; }
    .speed-section { left: 320px; width: 200px; }
    .heading-section { left: 525px; width: 150px; }

    .hold-sys-btn { left: 100px; top: 115px; width: 76px; height: 35px; font-size: 12px; }
    .pa-sys-btn { left: 35px; top: 115px; width: 76px; height: 35px; font-size: 12px; }

    .divider-one { left: 685px; }
    .mode-section { left: 695px; width: 270px; }
    .divider-two { left: 975px; }
    .altitude-section { left: 985px; width: 270px; }
    .vs-section { left: 1270px; width: 150px; }
    .eng-panel-section { left: 1430px; width: 110px; }
    .gear-section { left: 1550px; width: 55px; }

    .divider { position: absolute; top: 10px; bottom: 35px; width: 2px; background: linear-gradient(180deg, transparent, #89939b, transparent); }

    .knob-large { position: absolute; width: 76px; height: 76px; border-radius: 50%; border: 3px solid #e8d99e; box-shadow: 0 5px 9px #111, inset 0 2px 5px rgba(255,255,255,.7); cursor: ns-resize; }
    .speed-knob { left: 100px; top: 25px; background: radial-gradient(circle, #e7e9e7 0 42%, #bfc5c5 43% 60%, #3d4549 76% 100%); }
    .heading-knob { left: 35px; top: 25px; background: radial-gradient(circle, #e9ebea 0 45%, #7c8588 72%, #333b3f 100%); }
    .alt-knob { left: 95px; top: 25px; background: radial-gradient(circle, #e9eceb 0 42%, #bfc5c5 43% 60%, #353d40 100%); }
    .vs-knob { left: 35px; top: 25px; background: radial-gradient(circle, #e9eceb 0 42%, #bfc5c5 43% 60%, #353d40 100%); }

    .heading-cap, .alt-cap, .vs-cap { position: absolute; left: 14px; top: 14px; width: 42px; height: 42px; border-radius: 50%; background: radial-gradient(circle, #edf0ef, #b9c0c0); box-shadow: inset 0 2px 3px white, 0 2px 4px #555; }
    .triangle { position: absolute; left: 13px; top: 10px; width: 0; height: 0; border-left: 8px solid transparent; border-right: 8px solid transparent; border-bottom: 14px solid #4a6072; }

    .fcu-button { position: absolute; min-width: 62px; height: 42px; border: 2px solid #1b2429; border-radius: 5px; background: linear-gradient(180deg, #182228, #090e10); color: white; font-size: 13px; font-weight: bold; box-shadow: 0 3px 5px #111, inset 0 1px 0 rgba(255,255,255,.15); cursor: pointer; text-align: center; }
    .fcu-button:hover { background: linear-gradient(180deg, #24313a, #11181c); }
    .fcu-button.active { color: #ffe36e; box-shadow: 0 0 10px rgba(255,216,80,.45), inset 0 0 8px rgba(255,216,80,.15); }

    .spd-mach-btn { left: 15px; top: 40px; width: 65px; }
    .ap1 { left: 20px; top: 25px; }
    .ap2 { left: 95px; top: 25px; }
    .athr { left: 170px; top: 25px; }
    .loc { left: 20px; top: 80px; }
    .exped { left: 20px; top: 115px; }
    .metric-alt-btn { left: 185px; top: 115px; width: 75px; font-size: 11px; }
    .appr { left: 40px; top: 115px; }

    .alt-step-toggle { position: absolute; left: 20px; top: 35px; display: flex; flex-direction: column; gap: 6px; background: #182228; padding: 6px 10px; border-radius: 4px; border: 1px solid #3a4b59; color: #aaa; font-size: 12px; font-weight: bold; cursor: pointer; }
    .alt-step-toggle span.active { color: #ffe36e; }

    .small-round { position: absolute; width: 44px; height: 44px; left: 100px; top: 80px; border-radius: 50%; border: 2px solid #d9c986; background: radial-gradient(circle at 40% 35%, #56646d, #10171b 70%); box-shadow: 0 3px 7px #111; cursor: pointer; }
    .small-label { position: absolute; left: 155px; top: 83px; color: white; font-size: 12px; font-weight: bold; line-height: 14px; }

    .pbrake-plate {
        position: absolute;
        left: 0;
        top: 5px;
        width: 80px;
        height: 178px;
        background: linear-gradient(180deg, #485c6d 0%, #344758 100%);
        border: 2px solid #202e3b;
        border-radius: 6px;
        box-shadow: inset 0 1px 3px rgba(255,255,255,.2), 0 4px 8px rgba(0,0,0,.5);
        cursor: pointer;
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 8px 4px;
        box-sizing: border-box;
    }
    .pbrake-header { display: flex; justify-content: center; width: 100%; margin-bottom: 2px; }
    .pbrk-title { color: #ffffff; font-size: 8.5px; font-weight: bold; letter-spacing: 0.3px; }
    .pbrake-arc { position: absolute; top: 32px; left: 20px; width: 40px; height: 40px; border-top: 1.5px solid #ffffff; border-right: 1.5px solid #ffffff; border-radius: 0 40px 0 0; pointer-events: none; }
    .pbrake-labels { position: absolute; top: 22px; width: 100%; padding: 0 8px; box-sizing: border-box; pointer-events: none; }
    .lbl-off { position: absolute; left: 10px; top: 24px; color: #ffffff; font-size: 8.5px; font-weight: bold; }
    .lbl-on { position: absolute; right: 10px; top: 0px; color: #ffffff; font-size: 8.5px; font-weight: bold; }
    .pbrake-knob-container { position: absolute; bottom: 25px; left: 5px; width: 70px; height: 70px; display: flex; align-items: center; justify-content: center; }
    .pbrake-knob { position: relative; width: 66px; height: 38px; transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1); display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .pbrake-knob.off { transform: rotate(0deg); }
    .pbrake-knob.on { transform: rotate(90deg); }
    .pbrake-fin { position: absolute; top: -14px; width: 0; height: 0; border-left: 10px solid transparent; border-right: 10px solid transparent; border-bottom: 18px solid #0d1216; }
    .pbrake-handle { position: absolute; width: 64px; height: 22px; background: linear-gradient(180deg, #2b353e 0%, #10161a 100%); border: 1.5px solid #05080a; border-radius: 4px; box-shadow: 0 3px 6px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.25); display: flex; align-items: center; justify-content: center; }
    .pbrake-handle span { color: #ffffff; font-size: 8.5px; font-weight: bold; letter-spacing: 0.5px; text-shadow: 0 1px 2px rgba(0,0,0,0.9); }
    .pbrake-screw { position: absolute; left: 6px; bottom: 5px; width: 10px; height: 10px; }

    /* LANDING GEAR LEVER STYLING */
    .gear-lever-plate { position: absolute; left: 0; top: 5px; width: 50px; height: 178px; background: linear-gradient(180deg, #485c6d 0%, #344758 100%); border: 2px solid #202e3b; border-radius: 6px; box-shadow: inset 0 1px 3px rgba(255,255,255,.2), 0 4px 8px rgba(0,0,0,.5); cursor: pointer; display: flex; flex-direction: column; align-items: center; padding: 6px 3px; box-sizing: border-box; }
    .gear-graphic-up { display: flex; flex-direction: column; align-items: center; color: #ffffff; font-size: 9px; font-weight: bold; margin-bottom: 2px; }
    .gear-arrow-up { width: 0; height: 0; border-left: 5px solid transparent; border-right: 5px solid transparent; border-bottom: 8px solid #ffffff; margin-top: 1px; }
    .gear-graphic-down { display: flex; flex-direction: column; align-items: center; color: #ffffff; font-size: 9px; font-weight: bold; margin-top: 2px; z-index: 5; }
    .gear-arrow-down { width: 0; height: 0; border-left: 5px solid transparent; border-right: 5px solid transparent; border-top: 8px solid #ffffff; margin-bottom: 1px; }
    .gear-slot { position: relative; width: 20px; height: 98px; background: #0d1318; border: 1px solid #1a2733; border-radius: 3px; box-shadow: inset 0 3px 6px rgba(0,0,0,0.9); }
    .gear-handle { position: absolute; left: -9px; width: 38px; height: 34px; transition: top 0.3s cubic-bezier(0.4, 0, 0.2, 1); display: flex; align-items: center; justify-content: center; z-index: 4; }
    .gear-handle.up { top: 4px; }
    .gear-handle.down { top: 60px; }
    .gear-wheel-left, .gear-wheel-right { position: absolute; width: 9px; height: 32px; background: radial-gradient(circle at 30% 30%, #d8e0e6, #788894 60%, #303d48 100%); border: 1px solid #1c2833; border-radius: 4px; box-shadow: 0 2px 4px rgba(0,0,0,0.6); }
    .gear-wheel-left { left: 0; }
    .gear-wheel-right { right: 0; }
    .gear-knob-body { position: absolute; left: 8px; width: 20px; height: 28px; background: linear-gradient(180deg, #3a4854, #1c2730); border: 1px solid #111a22; border-radius: 3px; }
    .gear-pointer { position: absolute; left: 12px; bottom: -4px; width: 0; height: 0; border-left: 5px solid transparent; border-right: 5px solid transparent; border-top: 7px solid #111a22; }
    .gear-screw { position: absolute; left: 6px; bottom: 5px; width: 10px; height: 10px; z-index: 5; }
    .gear-lights-container { position: absolute; left: 55px; top: 15px; display: flex; flex-direction: column; gap: 6px; }
    .gear-position-light { position: absolute; width: 10px; height: 10px; border-radius: 50%; border: 1px solid #333; left: 50%; transform: translateX(-50%); background: #222; transition: background-color 0.3s ease; }
    .gear-position-light.up-light { top: 0px; }
    .gear-position-light.dn-light { top: 18px; }
    .gear-position-light.active { background: #00ff66; box-shadow: 0 0 8px #00ff66; }

    .flaps-lever-plate { position: absolute; left: 0; top: 5px; width: 50px; height: 178px; background: linear-gradient(180deg, #485c6d 0%, #344758 100%); border: 2px solid #202e3b; border-radius: 6px; box-shadow: inset 0 1px 3px rgba(255,255,255,.2), 0 4px 8px rgba(0,0,0,.5); cursor: ns-resize; display: flex; flex-direction: column; align-items: center; padding: 6px 2px; box-sizing: border-box; }
    .flaps-scale-labels { position: absolute; left: 2px; right: 2px; top: 12px; height: 105px; display: flex; flex-direction: column; justify-content: space-between; color: #ffffff; font-size: 8px; font-weight: bold; pointer-events: none; padding: 0 2px; box-sizing: border-box; z-index: 2; }
    .f-lbl { text-shadow: 0 1px 2px rgba(0,0,0,0.8); }
    .flaps-slot { position: relative; width: 18px; height: 115px; background: #0d1318; border: 1px solid #1a2733; border-radius: 3px; box-shadow: inset 0 3px 6px rgba(0,0,0,0.9); margin-top: 2px; }
    .flaps-handle { position: absolute; left: -11px; width: 40px; height: 38px; transition: top 0.25s cubic-bezier(0.4, 0, 0.2, 1); display: flex; flex-direction: column; align-items: center; pointer-events: none; }
    .flaps-handle.pos-0 { top: 2px; }
    .flaps-handle.pos-1 { top: 23px; }
    .flaps-handle.pos-2 { top: 44px; }
    .flaps-handle.pos-3 { top: 65px; }
    .flaps-handle.pos-4 { top: 86px; }
    .flaps-handle-head { width: 32px; height: 22px; background: linear-gradient(180deg, #d8e0e6 0%, #788894 65%, #303d48 100%); border: 1px solid #1c2833; border-radius: 4px 4px 2px 2px; box-shadow: 0 2px 4px rgba(0,0,0,0.6); z-index: 3; }
    .flaps-center-button { position: absolute; top: 16px; width: 10px; height: 10px; background: radial-gradient(circle at 35% 35%, #e2e8ec, #8696a2 60%, #404f5b 100%); border: 1px solid #1c2833; border-radius: 50%; box-shadow: 0 1px 2px rgba(0,0,0,0.5); z-index: 4; }
    .flaps-shaft { position: absolute; top: 20px; width: 14px; height: 24px; background: linear-gradient(180deg, #2a3642, #11181f); border: 1px solid #080c10; border-radius: 1px; z-index: 2; }
    .flaps-screw { position: absolute; left: 6px; bottom: 5px; width: 10px; height: 10px; }

    .spoilers-lever-plate { position: absolute; left: 0; top: 5px; width: 50px; height: 178px; background: linear-gradient(180deg, #485c6d 0%, #344758 100%); border: 2px solid #202e3b; border-radius: 6px; box-shadow: inset 0 1px 3px rgba(255,255,255,.2), 0 4px 8px rgba(0,0,0,.5); cursor: pointer; display: flex; flex-direction: column; align-items: center; padding: 4px 2px; box-sizing: border-box; }
    .spoilers-title-lbl { color: #ffe36e; font-size: 6.5px; font-weight: bold; margin-bottom: 2px; text-shadow: 0 1px 2px rgba(0,0,0,0.8); letter-spacing: 0.1px; }
    .spoilers-scale-labels { position: absolute; left: 2px; right: 2px; top: 25px; height: 90px; display: flex; flex-direction: column; justify-content: space-between; color: #ffffff; font-size: 7.5px; font-weight: bold; pointer-events: none; padding: 0 2px; box-sizing: border-box; z-index: 2; }
    .s-lbl { text-shadow: 0 1px 2px rgba(0,0,0,0.8); }
    .spoilers-slot { position: relative; width: 16px; height: 115px; background: #0d1318; border: 1px solid #1a2733; border-radius: 3px; box-shadow: inset 0 3px 6px rgba(0,0,0,0.9); margin-top: 2px; }
    .spoilers-handle { position: absolute; left: -10px; width: 36px; height: 32px; transition: top 0.25s cubic-bezier(0.4, 0, 0.2, 1); display: flex; flex-direction: column; align-items: center; pointer-events: none; }
    .spoilers-handle.state-0 { top: 2px; }
    .spoilers-handle.state-1 { top: 44px; }
    .spoilers-handle.state-2 { top: 86px; }
    .spoilers-cap { width: 34px; height: 18px; background: linear-gradient(180deg, #1e252b 0%, #0d1216 100%); border: 1px solid #485c6d; border-radius: 6px 6px 3px 3px; box-shadow: 0 2px 5px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,.2); z-index: 3; }
    .spoilers-grip { position: absolute; top: 15px; width: 10px; height: 16px; background: linear-gradient(180deg, #a4b0bc, #566470); border: 1px solid #1a2733; border-radius: 2px; z-index: 2; }
    .spoilers-screw { position: absolute; left: 6px; bottom: 5px; width: 10px; height: 10px; }

    .trim-wheel-plate { position: absolute; left: 0; top: 5px; width: 60px; height: 178px; background: linear-gradient(180deg, #485c6d 0%, #344758 100%); border: 2px solid #202e3b; border-radius: 6px; box-shadow: inset 0 1px 3px rgba(255,255,255,.2), 0 4px 8px rgba(0,0,0,.5); display: flex; flex-direction: column; align-items: center; padding: 4px 2px; box-sizing: border-box; cursor: ns-resize; }
    .trim-title-lbl { color: #ffe36e; font-size: 6px; font-weight: bold; margin-bottom: 2px; text-shadow: 0 1px 2px rgba(0,0,0,0.8); letter-spacing: 0.1px; }
    .trim-wheel-housing { position: relative; width: 48px; height: 120px; background: #12181f; border: 2px solid #090d11; border-radius: 6px; overflow: hidden; box-shadow: inset 0 4px 8px rgba(0,0,0,0.9); margin-top: 4px; display: flex; justify-content: center; }
    .trim-rotating-drum { 
        position: absolute; 
        width: 42px; 
        height: 300px; 
        top: -90px; 
        background: repeating-linear-gradient(
            135deg,
            #ffffff,
            #ffffff 12px,
            #111111 12px,
            #111111 24px
        ); 
        border-radius: 20px; 
        box-shadow: inset 0 0 10px rgba(0,0,0,0.8); 
        transition: transform 0.05s linear; 
        display: flex; 
        flex-direction: column; 
        align-items: center; 
        justify-content: space-evenly; 
    }
    .drum-mark { font-size: 8px; font-weight: bold; color: #ff3333; background: rgba(0,0,0,0.7); padding: 1px 3px; border-radius: 2px; }
    .trim-center-pointer { position: absolute; top: 58px; width: 100%; height: 4px; background: #ff3333; box-shadow: 0 0 6px #ff3333; pointer-events: none; }
    .trim-center-pointer::before, .trim-center-pointer::after { content: ''; position: absolute; top: -3px; width: 0; height: 0; border-top: 5px solid transparent; border-bottom: 5px solid transparent; }
    .trim-center-pointer::before { left: 1px; border-left: 6px solid #ff3333; }
    .trim-center-pointer::after { right: 1px; border-right: 6px solid #ff3333; }
    .trim-screw { position: absolute; left: 6px; bottom: 5px; width: 10px; height: 10px; }

    #trim-binds-modal {
        display: none;
        position: absolute;
        top: 35px;
        left: 210px;
        width: 200px;
        background: rgba(18, 24, 30, 0.95);
        border: 2px solid #ffe36e;
        border-radius: 6px;
        padding: 10px;
        box-shadow: 0 8px 20px rgba(0,0,0,0.8);
        z-index: 1000000;
        color: white;
        font-size: 11px;
    }
    #trim-binds-modal.active { display: block; }
    .modal-title { font-weight: bold; color: #ffe36e; margin-bottom: 8px; text-align: center; }
    .bind-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .bind-btn { background: #283747; border: 1px solid #455a6d; color: white; padding: 3px 8px; border-radius: 3px; cursor: pointer; font-size: 10px; font-weight: bold; }
    .bind-btn:hover { background: #34495e; }
    .bind-btn.listening { background: #ffe36e; color: #111; }
    .close-btn { width: 100%; margin-top: 6px; background: #922b21; border-color: #c0392b; }
    .close-btn:hover { background: #a93226; }

    .eng-panel-plate {
        position: absolute;
        left: 0;
        top: 5px;
        width: 105px;
        height: 178px;
        background: linear-gradient(180deg, #485c6d 0%, #344758 100%);
        border: 2px solid #202e3b;
        border-radius: 6px;
        box-shadow: inset 0 1px 3px rgba(255,255,255,.2), 0 4px 8px rgba(0,0,0,.5);
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 4px;
        box-sizing: border-box;
    }
    .eng-panel-header { color: #ffffff; font-size: 10px; font-weight: bold; letter-spacing: 1px; margin-bottom: 2px; }
    .eng-master-container { position: absolute; top: 22px; width: 44px; height: 75px; display: flex; flex-direction: column; align-items: center; }
    .master-1-cont { left: 6px; }
    .master-2-cont { right: 6px; }
    .eng-master-lbl-top { color: #fff1a5; font-size: 6.5px; font-weight: bold; margin-bottom: 2px; white-space: nowrap; }
    .eng-labels-side { position: absolute; top: 16px; width: 100%; display: flex; justify-content: space-between; padding: 0 2px; box-sizing: border-box; pointer-events: none; font-size: 6px; color: #fff; font-weight: bold; }
    .eng-master-switch { position: absolute; top: 28px; width: 34px; height: 42px; background: linear-gradient(180deg, #2b353e 0%, #10161a 100%); border: 1.5px solid #05080a; border-radius: 4px; box-shadow: 0 3px 6px rgba(0,0,0,0.8); cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; transition: transform 0.25s ease; }
    .eng-master-switch.off { transform: translateY(6px); }
    .eng-master-switch.on { transform: translateY(-2px); border-color: #ffe36e; }
    .eng-switch-guard { position: absolute; top: -6px; width: 22px; height: 6px; background: #1a2733; border-radius: 2px; }
    .eng-switch-face { width: 28px; height: 30px; background: linear-gradient(180deg, #111b22 0%, #05080a 100%); border: 1px solid #334455; border-radius: 2px; display: flex; align-items: center; justify-content: center; text-align: center; }
    .eng-switch-face span { color: #ffffff; font-size: 7px; font-weight: bold; line-height: 8px; }
    .eng-master-switch.on .eng-switch-face span { color: #ffe36e; }

    .eng-mode-selector-area { position: absolute; bottom: 8px; left: 8px; right: 8px; height: 75px; display: flex; flex-direction: column; align-items: center; }
    .mode-title-lbl { color: #fff1a5; font-size: 7.5px; font-weight: bold; }
    .mode-norm-lbl { position: absolute; top: 18px; color: #fff; font-size: 6.5px; font-weight: bold; }
    .mode-crank-lbl { position: absolute; left: 2px; bottom: 18px; color: #fff; font-size: 6px; font-weight: bold; }
    .mode-start-lbl { position: absolute; right: 2px; bottom: 15px; color: #fff; font-size: 6px; font-weight: bold; text-align: center; line-height: 7px; }
    .mode-arc { position: absolute; bottom: 12px; width: 60px; height: 25px; border-top: 1px dashed rgba(255,255,255,0.6); border-radius: 30px 30px 0 0; pointer-events: none; }
    .mode-knob { position: absolute; bottom: 6px; width: 36px; height: 36px; border-radius: 50%; background: radial-gradient(circle, #edf0ef 0 45%, #8a969b 72%, #333b3f 100%); border: 2px solid #202e3b; box-shadow: 0 3px 5px rgba(0,0,0,0.7); cursor: pointer; transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
    .mode-knob.crank { transform: rotate(-45deg); }
    .mode-knob.norm { transform: rotate(0deg); }
    .mode-knob.ign { transform: rotate(45deg); }
    .mode-knob-indicator { position: absolute; top: 2px; left: 15px; width: 2px; height: 10px; background: #ffe36e; }
    .eng-screw { position: absolute; left: 6px; bottom: 5px; width: 10px; height: 10px; }

    .screw { position: absolute; width: 14px; height: 14px; border-radius: 50%; background: radial-gradient(circle at 40% 35%, #56554b, #292b25); border: 1px solid #161712; }
    .screw-1 { left: 20px; top: 5px; } .screw-2 { right: 20px; top: 5px; } .screw-3 { left: 20px; bottom: 8px; } .screw-4 { right: 20px; bottom: 8px; }

    .drag-handle { position: absolute; left: 50%; bottom: 6px; transform: translateX(-50%); color: rgba(255,255,255,.3); font-size: 11px; font-weight: bold; cursor: move; }
    .drag-handle.listening { color: #ffe36e; text-shadow: 0 0 10px rgba(255,216,80,.45); }
    .toggle-key-display { font-weight: normal; font-size: 10px; }
    `;
    document.head.appendChild(css);

    /* ============================================================
        DYNAMIC RESIZING & SCROLL-TO-ZOOM PANEL LOGIC
        ============================================================ */
    const BASE_WIDTH = 1610;
    const BASE_HEIGHT = 320;
    const panel = fcu.querySelector('.fcu-panel');

    function applyPanelWidth(w) {
        currentPanelWidth = Math.max(600, Math.min(2200, w));
        const scale = currentPanelWidth / BASE_WIDTH;
        panel.style.transform = 'scale(' + scale + ')';
    }

    fcu.addEventListener('wheel', (e) => {
        if (e.target.closest('.speed-knob') || e.target.closest('.heading-knob') || e.target.closest('.alt-knob') || e.target.closest('.vs-knob') || e.target.closest('.trim-wheel-plate') || e.target.closest('.flaps-lever-plate')) {
            return;
        }
        e.preventDefault();
        const delta = e.deltaY < 0 ? 50 : -50;
        currentPanelWidth += delta;
        applyPanelWidth(currentPanelWidth);
    }, { passive: false });

    applyPanelWidth(1090);

    /* ============================================================
        DISPLAY UPDATE & TRIM WHEEL ANIMATION LOGIC
        ============================================================ */
    const speedVal = fcu.querySelector('.speed-display .val');
    const headingVal = fcu.querySelector('.heading-display .val');
    const altVal = fcu.querySelector('.alt-display .val');
    const altUnit = fcu.querySelector('.unit-indicator');
    const vsVal = fcu.querySelector('.vs-display .val');
    const trimDrum = fcu.querySelector('.trim-rotating-drum');

    function updateDisplays() {
        if (state.isMach) {
            speedVal.textContent = state.speed.toFixed(2);
        } else {
            speedVal.textContent = Math.round(state.speed).toString().padStart(3, '0');
        }

        headingVal.textContent = Math.round(state.heading).toString().padStart(3, '0');

        if (state.metricAlt) {
            const meters = Math.round(state.altitude * 0.3048);
            altVal.textContent = meters.toString().padStart(5, '0');
            altUnit.textContent = 'M';
        } else {
            altVal.textContent = Math.round(state.altitude).toString().padStart(5, '0');
            altUnit.textContent = 'FT';
        }

        const vsSign = state.vs >= 0 ? '+' : '-';
        vsVal.textContent = vsSign + Math.abs(Math.round(state.vs)).toString().padStart(4, '0');

        const speedManagedVisible = state.managedSpeed && state.athr;
        fcu.querySelector('.spd-window .managed-dot').style.visibility = speedManagedVisible ? 'visible' : 'hidden';
        fcu.querySelector('.hdg-window .managed-dot').style.visibility = state.navMode ? 'visible' : 'hidden';
        fcu.querySelector('.alt-window .managed-dot').style.visibility = state.managedAltitude ? 'visible' : 'hidden';

        if (trimDrum) {
            const norm = trimValue / MAX_TRIM;
            const translateY = norm * 90;
            trimDrum.style.transform = `translateY(${translateY}px)`;
        }
    }
    updateDisplays();

    /* ============================================================
        GEOFS GAME INTEGRATION & CONTROLS
        ============================================================ */
    function triggerNativeInput(selectors, value) {
        for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (el) {
                el.value = value;
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('input', { bubbles: true }));
                break;
            }
        }
    }

    function updateGeoFSSpeed() {
        if (typeof geofs === 'undefined' || !geofs.autopilot) return;
        if (typeof geofs.autopilot.setSpeed === 'function') {
            geofs.autopilot.setSpeed(state.speed);
        } else {
            geofs.autopilot.speed = state.speed;
        }
    }

    function updateGeoFSHeading() {
        if (typeof geofs === 'undefined' || !geofs.autopilot) return;
        if (typeof geofs.autopilot.setMode === 'function') geofs.autopilot.setMode('HDG');
        if (typeof geofs.autopilot.setHeading === 'function') {
            geofs.autopilot.setHeading(state.heading);
        } else if (typeof geofs.autopilot.setCourse === 'function') {
            geofs.autopilot.setCourse(state.heading);
        } else {
            geofs.autopilot.heading = state.heading;
        }
        state.navMode = false;
        updateDisplays();
        triggerNativeInput(['[data-autopilot="heading"]', '.autopilot-heading', '#autopilotHdg', 'input[placeholder="HDG"]'], state.heading);
    }

    function engageNavMode() {
        state.navMode = true;
        if (typeof geofs !== 'undefined' && geofs.autopilot && typeof geofs.autopilot.setMode === 'function') {
            geofs.autopilot.setMode('NAV');
        }
        updateDisplays();
    }

    function updateGeoFSAltitude() {
        if (typeof geofs === 'undefined' || !geofs.autopilot) return;
        if (typeof geofs.autopilot.setAltitude === 'function') geofs.autopilot.setAltitude(state.altitude);
        else geofs.autopilot.altitude = state.altitude;
    }

    function updateGeoFSVS() {
        if (typeof geofs === 'undefined' || !geofs.autopilot) return;
        if (typeof geofs.autopilot.setVerticalSpeed === 'function') geofs.autopilot.setVerticalSpeed(state.vs);
        else geofs.autopilot.vs = state.vs;
    }

    function updateGearVisuals() {
        const gearHandle = fcu.querySelector('.gear-handle');
        const upLight = fcu.querySelector('.up-light');
        const dnLight = fcu.querySelector('.dn-light');

        if (state.gearDown) {
            gearHandle.classList.remove('up');
            gearHandle.classList.add('down');
            upLight.classList.remove('active');
            dnLight.classList.add('active');
        } else {
            gearHandle.classList.remove('down');
            gearHandle.classList.add('up');
            upLight.classList.add('active');
            dnLight.classList.remove('active');
        }
    }

    function updateParkBrakeVisuals() {
        const pknob = fcu.querySelector('.pbrake-knob');
        if (pknob) {
            if (state.parkBrakeOn) {
                pknob.classList.remove('off');
                pknob.classList.add('on');
            } else {
                pknob.classList.remove('on');
                pknob.classList.add('off');
            }
        }
    }

    const pbrakePlate = fcu.querySelector('.pbrake-plate');
    pbrakePlate.addEventListener('click', () => {
        state.parkBrakeOn = !state.parkBrakeOn;
        updateParkBrakeVisuals();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: ';', code: 'Semicolon', keyCode: 186, which: 186, bubbles: true }));
    });
    pbrakePlate.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.parkBrakeOn = !state.parkBrakeOn;
        updateParkBrakeVisuals();
    });
    updateParkBrakeVisuals();

    const gearLeverPlate = fcu.querySelector('.gear-lever-plate');
    gearLeverPlate.addEventListener('click', () => {
        if (typeof controls !== 'undefined' && controls.setters && controls.setters.setGear) {
            controls.setters.setGear.set();
        } else if (typeof geofs !== 'undefined' && geofs.aircraft && geofs.aircraft.instance) {
            const ac = geofs.aircraft.instance;
            if (typeof ac.setGear === 'function') ac.setGear(state.gearDown ? 0 : 1);
        }
        state.gearDown = !state.gearDown;
        updateGearVisuals();
    });
    gearLeverPlate.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.gearDown = !state.gearDown;
        updateGearVisuals();
    });
    updateGearVisuals();

    function updateFlapsVisuals() {
        const flapsHandle = fcu.querySelector('.flaps-handle');
        if (flapsHandle) flapsHandle.className = 'flaps-handle pos-' + state.flapsPosition;
    }

    const flapsLeverPlate = fcu.querySelector('.flaps-lever-plate');
    flapsLeverPlate.addEventListener('click', () => {
        state.flapsPosition = (state.flapsPosition + 1) % 5;
        updateFlapsVisuals();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', keyCode: 70, which: 70, bubbles: true }));
    });
    flapsLeverPlate.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        state.flapsPosition = (state.flapsPosition - 1 + 5) % 5;
        updateFlapsVisuals();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: ']', code: 'BracketRight', keyCode: 221, which: 221, bubbles: true }));
    });
    flapsLeverPlate.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (e.deltaY < 0) {
            state.flapsPosition = Math.min(4, state.flapsPosition + 1);
            updateFlapsVisuals();
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', keyCode: 70, which: 70, bubbles: true }));
        } else {
            state.flapsPosition = Math.max(0, state.flapsPosition - 1);
            updateFlapsVisuals();
            document.dispatchEvent(new KeyboardEvent('keydown', { key: ']', code: 'BracketRight', keyCode: 221, which: 221, bubbles: true }));
        }
    });
    updateFlapsVisuals();

    function applySpoilerState() {
        const spoilersHandle = fcu.querySelector('.spoilers-handle');
        if (spoilersHandle) spoilersHandle.className = 'spoilers-handle state-' + state.spoilerState;
        const setAirbrakes = window.controls?.setters?.setAirbrakes;
        if (state.spoilerState === 0 && window.controls?.airbrakes?.position > 0 && setAirbrakes) setAirbrakes.set();
        else if (state.spoilerState === 2 && window.controls?.airbrakes?.position === 0 && setAirbrakes) setAirbrakes.set();
    }

    const spoilersLeverPlate = fcu.querySelector('.spoilers-lever-plate');
    spoilersLeverPlate.addEventListener('click', () => { state.spoilerState = (state.spoilerState + 1) % 3; applySpoilerState(); });
    spoilersLeverPlate.addEventListener('contextmenu', (e) => { e.preventDefault(); state.spoilerState = (state.spoilerState - 1 + 3) % 3; applySpoilerState(); });
    applySpoilerState();

    function updateEngineVisuals() {
        const m1 = fcu.querySelector('.eng-master-switch[data-engine="1"]');
        const m2 = fcu.querySelector('.eng-master-switch[data-engine="2"]');
        const modeKnob = fcu.querySelector('.mode-knob');

        if (m1) {
            m1.classList.toggle('on', state.eng1Master);
            m1.classList.toggle('off', !state.eng1Master);
        }
        if (m2) {
            m2.classList.toggle('on', state.eng2Master);
            m2.classList.toggle('off', !state.eng2Master);
        }
        if (modeKnob) {
            modeKnob.className = 'mode-knob ' + (state.engMode === 'CRANK' ? 'crank' : state.engMode === 'IGN' ? 'ign' : 'norm');
        }

        if (state.eng1Master && state.eng2Master && state.engMode === 'IGN') {
            if (!state.enginesTriggered) {
                const event = new KeyboardEvent('keydown', { key: 'e', code: 'KeyE', keyCode: 69, which: 69, bubbles: true });
                document.dispatchEvent(event);
                state.enginesTriggered = true;
            }
        } else {
            state.enginesTriggered = false;
        }
    }

    fcu.querySelectorAll('.eng-master-switch').forEach(sw => {
        sw.addEventListener('click', () => {
            const engNum = sw.getAttribute('data-engine');
            if (engNum === '1') state.eng1Master = !state.eng1Master;
            if (engNum === '2') state.eng2Master = !state.eng2Master;
            updateEngineVisuals();
        });
    });

    const modeKnobEl = fcu.querySelector('.mode-knob');
    if (modeKnobEl) {
        modeKnobEl.addEventListener('click', () => {
            if (state.engMode === 'NORM') state.engMode = 'IGN';
            else if (state.engMode === 'IGN') state.engMode = 'CRANK';
            else state.engMode = 'NORM';
            updateEngineVisuals();
        });
    }
    updateEngineVisuals();

    function stepTrim(direction) {
        trimValue = Math.max(-MAX_TRIM, Math.min(MAX_TRIM, trimValue + direction * TRIM_STEP));
        updateDisplays();
    }

    let trimActiveUp = false;
    let trimActiveDown = false;
    let trimTimerUp = null;
    let trimTimerDown = null;

    const modal = fcu.querySelector('#trim-binds-modal');
    const bindUpBtn = fcu.querySelector('#bind-up-btn');
    const bindDownBtn = fcu.querySelector('#bind-down-btn');
    const bindResetBtn = fcu.querySelector('#bind-reset-btn');
    const trimWheelPlate = fcu.querySelector('.trim-wheel-plate');

    function updateModalLabels() {
        bindUpBtn.textContent = trimBindings.up.type === 'keyboard' ? trimBindings.up.code : `GP ${trimBindings.up.gamepadIndex} B${trimBindings.up.buttonIndex}`;
        bindDownBtn.textContent = trimBindings.down.type === 'keyboard' ? trimBindings.down.code : `GP ${trimBindings.down.gamepadIndex} B${trimBindings.down.buttonIndex}`;
        bindResetBtn.textContent = trimBindings.reset.type === 'keyboard' ? trimBindings.reset.code : `GP ${trimBindings.reset.gamepadIndex} B${trimBindings.reset.buttonIndex}`;
    }

    trimWheelPlate.addEventListener('click', (e) => {
        e.stopPropagation();
        modal.classList.toggle('active');
        updateModalLabels();
    });

    trimWheelPlate.addEventListener('wheel', (e) => {
        e.preventDefault();
        const dir = e.deltaY < 0 ? 1 : -1;
        stepTrim(dir);
    });

    fcu.querySelector('#close-modal-btn').addEventListener('click', () => {
        modal.classList.remove('active');
    });

    bindUpBtn.addEventListener('click', () => { listeningForTrimAction = 'up'; bindUpBtn.classList.add('listening'); bindUpBtn.textContent = 'PRESS...'; });
    bindDownBtn.addEventListener('click', () => { listeningForTrimAction = 'down'; bindDownBtn.classList.add('listening'); bindDownBtn.textContent = 'PRESS...'; });
    bindResetBtn.addEventListener('click', () => { listeningForTrimAction = 'reset'; bindResetBtn.classList.add('listening'); bindResetBtn.textContent = 'PRESS...'; });

    document.addEventListener('keydown', (e) => {
        ensureOverrides();

        if (listeningForTrimAction) {
            e.preventDefault();
            trimBindings[listeningForTrimAction] = { type: 'keyboard', code: e.code };
            saveTrimBindings();
            fcu.querySelectorAll('.bind-btn').forEach(b => b.classList.remove('listening'));
            listeningForTrimAction = null;
            updateModalLabels();
            return;
        }

        if (trimBindings.up.type === 'keyboard' && e.code === trimBindings.up.code && !trimActiveUp) {
            e.preventDefault();
            trimActiveUp = true;
            stepTrim(1);
            trimTimerUp = setInterval(() => stepTrim(1), TRIM_REPEAT_MS);
        } else if (trimBindings.down.type === 'keyboard' && e.code === trimBindings.down.code && !trimActiveDown) {
            e.preventDefault();
            trimActiveDown = true;
            stepTrim(-1);
            trimTimerDown = setInterval(() => stepTrim(-1), TRIM_REPEAT_MS);
        } else if (trimBindings.reset.type === 'keyboard' && e.code === trimBindings.reset.code && !isListeningForKey && document.activeElement.tagName !== 'INPUT') {
            trimValue = 0;
            updateDisplays();
        }
    });

    document.addEventListener('keyup', (e) => {
        if (trimBindings.up.type === 'keyboard' && e.code === trimBindings.up.code) {
            trimActiveUp = false;
            if (trimTimerUp) { clearInterval(trimTimerUp); trimTimerUp = null; }
        } else if (trimBindings.down.type === 'keyboard' && e.code === trimBindings.down.code) {
            trimActiveDown = false;
            if (trimTimerDown) { clearInterval(trimTimerDown); trimTimerDown = null; }
        }
    });

    if (window.geofs && window.geofs.api && window.geofs.api.addFrameCallback) {
        window.geofs.api.addFrameCallback(() => {
            ensureOverrides();
            updateDisplays();

            const pads = navigator.getGamepads ? navigator.getGamepads() : [];
            for (let gi = 0; gi < pads.length; gi++) {
                const pad = pads[gi];
                if (!pad) continue;

                if (listeningForTrimAction) {
                    for (let bi = 0; bi < pad.buttons.length; bi++) {
                        if (pad.buttons[bi].pressed) {
                            trimBindings[listeningForTrimAction] = { type: 'button', gamepadIndex: gi, buttonIndex: bi };
                            saveTrimBindings();
                            fcu.querySelectorAll('.bind-btn').forEach(b => b.classList.remove('listening'));
                            listeningForTrimAction = null;
                            updateModalLabels();
                            break;
                        }
                    }
                }

                for (const action of ['up', 'down', 'reset']) {
                    const b = trimBindings[action];
                    if (b && b.type === 'button' && b.gamepadIndex === gi) {
                        const isPressed = !!(pad.buttons[b.buttonIndex] && pad.buttons[b.buttonIndex].pressed);
                        if (action === 'up' && isPressed) stepTrim(1);
                        if (action === 'down' && isPressed) stepTrim(-1);
                        if (action === 'reset' && isPressed) { trimValue = 0; updateDisplays(); }
                    }
                }
            }

            const ac = window.geofs?.aircraft?.instance;
            if (!ac) return;
            const onGround = !!ac.groundContact;
            const setAirbrakes = window.controls?.setters?.setAirbrakes;
            if (state.spoilerState === 1) {
                if (onGround && state.wasOnGround === false && window.controls?.airbrakes?.position === 0 && setAirbrakes) {
                    setAirbrakes.set();
                }
                if (!onGround && state.wasOnGround === true && window.controls?.airbrakes?.position > 0 && setAirbrakes) {
                    setAirbrakes.set();
                }
            }
            state.wasOnGround = onGround;
        }, 'autoAirbrakesAndTrimSync');
    }

    /* ============================================================
        SYSTEM INTEGRATIONS (HOLD & PA BUTTONS)
        ============================================================ */
    initHoldSystem();

    const holdSysBtn = fcu.querySelector('.hold-sys-btn');
    holdSysBtn.addEventListener('click', () => {
        if (window._holdGeneratorPanel) {
            const isHidden = window._holdGeneratorPanel.style.display === 'none' || window._holdGeneratorPanel.style.display === '';
            window._holdGeneratorPanel.style.display = isHidden ? 'block' : 'none';
            holdSysBtn.classList.toggle('active', isHidden);
        }
    });

    const PA_RAW_URL = 'https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/pa-script.js';

    async function executeRemoteScript(url) {
        const response = await fetch(url, { cache: 'no-cache' });
        if (!response.ok) {
            throw new Error('Failed to load PA script: HTTP ' + response.status);
        }

        const scriptText = await response.text();

        const runner = new Function(
            'window',
            'document',
            'geofs',
            'controls',
            'ui',
            scriptText + '\nreturn true;'
        );

        return runner(window, document, window.geofs, window.controls, window.ui);
    }

    const paSysBtn = fcu.querySelector('.pa-sys-btn');
    paSysBtn.addEventListener('click', async () => {
        paSysBtn.classList.toggle('active');
        paSysBtn.disabled = true;
        paSysBtn.textContent = 'LOADING...';

        try {
            if (typeof window._paCustomToggle === 'function') {
                window._paCustomToggle();
                console.log('PA button executed local function.');
            } else {
                await executeRemoteScript(PA_RAW_URL);
                console.log('PA button executed remote GitHub raw script.');
            }
        } catch (err) {
            console.error('PA script failed:', err);
            alert('PA script failed: ' + err.message);
        } finally {
            paSysBtn.disabled = false;
            paSysBtn.textContent = 'PA';
        }
    });

    /* ============================================================
        EVENT BINDINGS & TOGGLE SHORTCUT
        ============================================================ */
    const dragHandle = fcu.querySelector('.drag-handle');
    let isDragging = false, startX, startY;

    dragHandle.addEventListener('mousedown', (e) => {
        if (e.button === 2) return;
        isDragging = true;
        startX = e.clientX - fcu.offsetLeft;
        startY = e.clientY - fcu.offsetTop;
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        fcu.style.left = (e.clientX - startX) + 'px';
        fcu.style.top = (e.clientY - startY) + 'px';
    });

    document.addEventListener('mouseup', () => { isDragging = false; });

    document.addEventListener('keydown', (e) => {
        if (isListeningForKey) {
            e.preventDefault();
            togglePanelKey = e.key.toUpperCase();
            localStorage.setItem('geofs-fcu-toggle-key', togglePanelKey);
            isListeningForKey = false;
            dragHandle.classList.remove('listening');
            dragHandle.innerHTML = `A320 FCU <span class="toggle-key-display">(${togglePanelKey})</span>`;
            return;
        }
        if (e.key.toUpperCase() === togglePanelKey && document.activeElement.tagName !== 'INPUT') {
            fcu.style.display = fcu.style.display === 'none' ? 'block' : 'none';
        }
    });

    fcu.querySelector('.speed-knob').addEventListener('wheel', (e) => {
        e.preventDefault();
        if (state.isMach) {
            state.speed += (e.deltaY < 0 ? 0.01 : -0.01);
            state.speed = Math.max(0.1, Math.min(0.99, state.speed));
        } else {
            state.speed += (e.deltaY < 0 ? 1 : -1);
            state.speed = Math.max(100, Math.min(399, state.speed));
        }
        state.managedSpeed = false;
        updateDisplays();
        updateGeoFSSpeed();
    });

    const headingKnob = fcu.querySelector('.heading-knob');
    headingKnob.addEventListener('wheel', (e) => {
        e.preventDefault();
        state.heading += (e.deltaY < 0 ? 1 : -1);
        if (state.heading > 360) state.heading = 1;
        if (state.heading < 1) state.heading = 360;
        state.navMode = false;
        updateDisplays();
        updateGeoFSHeading();
    });
    headingKnob.addEventListener('dblclick', () => {
        engageNavMode();
    });

    fcu.querySelector('.alt-knob').addEventListener('wheel', (e) => {
        e.preventDefault();
        const step = state.altStep;
        state.altitude += (e.deltaY < 0 ? step : -step);
        state.altitude = Math.max(100, Math.min(45000, state.altitude));
        state.managedAltitude = false;
        updateDisplays();
        updateGeoFSAltitude();
    });

    fcu.querySelector('.vs-knob').addEventListener('wheel', (e) => {
        e.preventDefault();
        state.vs += (e.deltaY < 0 ? 100 : -100);
        state.vs = Math.max(-6000, Math.min(6000, state.vs));
        updateDisplays();
        updateGeoFSVS();
    });

    fcu.querySelector('.ap1').addEventListener('click', () => {
        state.ap1 = !state.ap1;
        fcu.querySelector('.ap1').classList.toggle('active', state.ap1);
        updateAutoPilotState();
        updateAutothrottleState();
    });

    fcu.querySelector('.ap2').addEventListener('click', () => {
        state.ap2 = !state.ap2;
        fcu.querySelector('.ap2').classList.toggle('active', state.ap2);
        updateAutoPilotState();
        updateAutothrottleState();
    });

    fcu.querySelector('.athr').addEventListener('click', () => {
        state.athr = !state.athr;
        fcu.querySelector('.athr').classList.add('active', state.athr);
        initAutothrottleEngine();
        if (geofs.autothrottle) geofs.autothrottle.toggle();
        updateDisplays();
    });

    fcu.querySelector('.loc').addEventListener('click', () => {
        state.loc = !state.loc;
        fcu.querySelector('.loc').classList.toggle('active', state.loc);
    });

    fcu.querySelector('.spd-mach-btn').addEventListener('click', () => {
        state.isMach = !state.isMach;
        state.speed = state.isMach ? 0.78 : 250;
        updateDisplays();
        if (typeof geofs !== 'undefined' && geofs.autopilot) {
            if (typeof geofs.autopilot.setSpeedMode === 'function') {
                geofs.autopilot.setSpeedMode(state.isMach ? 'mach' : 'knots');
            }
        }
        updateGeoFSSpeed();
    });

    fcu.querySelector('.appr').addEventListener('click', () => {
        state.appr = !state.appr;
        fcu.querySelector('.appr').classList.toggle('active', state.appr);
        if (typeof geofs !== 'undefined' && geofs.autopilot && typeof geofs.autopilot.setApproachMode === 'function') {
            geofs.autopilot.setApproachMode(state.appr);
        }
    });

    fcu.querySelector('.exped').addEventListener('click', function () {
        state.exped = !state.exped;
        this.classList.toggle('active', state.exped);
        if (state.exped) {
            state.vs = state.vs < 0 ? -6000 : 6000;
            updateDisplays();
            updateGeoFSVS();
        }
    });

    fcu.querySelector('.metric-alt-btn').addEventListener('click', () => {
        state.metricAlt = !state.metricAlt;
        fcu.querySelector('.metric-alt-btn').classList.toggle('active', state.metricAlt);
        updateDisplays();
    });

    fcu.querySelector('.alt-step-toggle').addEventListener('click', () => {
        state.altStep = state.altStep === 100 ? 1000 : 100;
        fcu.querySelector('.step-100').classList.toggle('active', state.altStep === 100);
        fcu.querySelector('.step-1000').classList.toggle('active', state.altStep === 1000);
    });

    function updateAutoPilotState() {
        if (typeof geofs === 'undefined' || !geofs.autopilot) return;
        const shouldBeEnabled = state.ap1 || state.ap2;
        if (shouldBeEnabled && !geofs.autopilot.on) {
            if (typeof geofs.autopilot.turnOn === 'function') geofs.autopilot.turnOn();
            else geofs.autopilot.on = true;
        } else if (!shouldBeEnabled && geofs.autopilot.on) {
            if (typeof geofs.autopilot.turnOff === 'function') geofs.autopilot.turnOff();
            else geofs.autopilot.on = false;
        }
    }

    function updateAutothrottleState() {
        const shouldBeEnabled = state.ap1 || state.ap2;
        if (shouldBeEnabled && !state.athr) {
            state.athr = true;
            fcu.querySelector('.athr').classList.add('active');
            initAutothrottleEngine();
            if (geofs.autothrottle && !geofs.autothrottle.on) geofs.autothrottle.toggle();
            updateDisplays();
        } else if (!shouldBeEnabled && state.athr) {
            state.athr = false;
            fcu.querySelector('.athr').classList.remove('active');
            if (geofs.autothrottle && geofs.autothrottle.on) geofs.autothrottle.toggle();
            state.managedSpeed = false;
            updateDisplays();
        }
    }

    window._trim = {
        installed: true,
        getTrim() { return trimValue; },
        setTrim(v) { trimValue = Math.max(-MAX_TRIM, Math.min(MAX_TRIM, v)); updateDisplays(); },
        reset() { trimValue = 0; updateDisplays(); }
    };

})();
