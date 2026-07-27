// ==UserScript==

// @name         FR24 Georeferenced Polygon Drawer

// @namespace    DRDO_ITR_FR24

// @version      4.1

// @description  Real-time georeferenced SVG polygon overlay on Flightradar24 with fixed viewport sync and robust coordinate extraction.

// @author       Katyayani,Manisha,Kishore,Rohit,Jaydev,Ankita

// @match        https://www.flightradar24.com/*

// @grant        unsafeWindow

// @run-at       document-start

// ==/UserScript==



(function () {

  'use strict';



  const EARTH_R = 6378137;

  const DEG2RAD = Math.PI / 180;



  let geoCoordinates = [];

  let svgEl   = null;

  let polyEl  = null;

  let centreEl = null;

  let resEl    = null;

  let ptsEl    = null;



  // ═══════════════════════════════════════════════════════════════

  // 1. IMPROVED COORDINATE PARSER (Fixes missing coordinates)

  // ═══════════════════════════════════════════════════════════════

  function parseDMSToDD(s) {

    if (!s) return NaN;

    s = s.trim();



    // Plain decimal number — return as-is

    if (!isNaN(s) && s !== '') return parseFloat(s);



    // Hemisphere direction letter

    const dirMatch = s.match(/[NSEWnsew]/i);

    const dir = dirMatch ? dirMatch[0].toUpperCase() : '';



    // Strip out letters so negative signs and decimals parse cleanly

    let cleanSrc = s.replace(/[NSEWnsew]/ig, '').trim();



    // Extract numbers safely

    const nums = cleanSrc.match(/-?\d+(?:\.\d+)?/g);

    if (!nums || nums.length === 0) return NaN;

    if (nums.length === 1) {

       let val = parseFloat(nums[0]);

       if (dir === 'S' || dir === 'W') val = -Math.abs(val);

       return val;

    }



    const deg = parseFloat(nums[0]);

    const min = parseFloat(nums[1]) || 0;

    const sec = nums.length >= 3 ? parseFloat(nums[2]) : 0;



    let dd = Math.abs(deg) + min / 60 + sec / 3600;

    if (deg < 0 || dir === 'S' || dir === 'W') dd = -dd;

    return dd;

  }



  function parseCoordinates(rawText) {

    const coords = [];

    const errors = [];

    const lines  = rawText.split('\n').map(l => l.trim()).filter(Boolean);



    for (const line of lines) {

      let lat = NaN, lon = NaN;



      // Handle split patterns via Delimiters (Comma or Tabs/Multiple spaces)

      let parts = [];

      if (line.includes(',')) {

          // Explicit comma strategy

          const commaIdx = line.search(/[NSns]\s*,/i) !== -1 ? line.indexOf(',', line.search(/[NSns]/i)) : line.indexOf(',');

          parts = [line.slice(0, commaIdx), line.slice(commaIdx + 1)];

      } else {

          // Spaces/Hemisphere splits

          const splitMatch = line.match(/^(.*?[NSns])\s+(.*[EWew].*)$/i);

          if (splitMatch) {

              parts = [splitMatch[1], splitMatch[2]];

          } else {

              // Raw separation fallback split by middle chunks

              parts = line.split(/\s{2,}/); // split by double spaces

              if(parts.length < 2) parts = line.split('\t'); // tab fallback

          }

      }



      if (parts.length >= 2) {

          lat = parseDMSToDD(parts[0]);

          lon = parseDMSToDD(parts[1]);

      }



      if (!isNaN(lat) && !isNaN(lon)) {

        coords.push([lat, lon]);

      } else {

        errors.push(line);

      }

    }

    return { coords, errors };

  }



  // ═══════════════════════════════════════════════════════════════

  // 2. WGS-84 → WEB MERCATOR (EPSG:3857)

  // ═══════════════════════════════════════════════════════════════

  function toMercator(lat, lon) {

    return [

      lon * DEG2RAD * EARTH_R,

      Math.log(Math.tan(Math.PI / 4 + (lat * DEG2RAD) / 2)) * EARTH_R

    ];

  }



  // ═══════════════════════════════════════════════════════════════

  // 3. GET FR24 MAP VIEW STATE (Synchronized targeting)

  // ═══════════════════════════════════════════════════════════════

  function getViewState() {

    const win = unsafeWindow;



    // Strategy A: Mapbox Engine fallback (FR24 modern stack asset maps)

    try {

        if (win.MapboxGL || win.mapboxgl) {

            const maps = win.mapboxgl.Map.MapboxGLMaps || [];

            if(maps.length && maps[0]) {

                const m = maps[0];

                const c = m.getCenter(), zoom = m.getZoom();

                return { lat: c.lat, lon: c.lng, res: mercRes(c.lat, zoom), zoom, src: 'Mapbox', mapObj: m };

            }

        }

    } catch(_) {}



    // Strategy B: FR24 Global Map variable binding

    try {

      if (win.FR24 && win.FR24.map) {

        const map = win.FR24.map;

        if (typeof map.getCenter === 'function') {

            const c = map.getCenter(), zoom = map.getZoom();

            return { lat: c.lat, lon: c.lng, res: mercRes(c.lat, zoom), zoom, src: 'FR24', mapObj: map };

        }

      }

    } catch (_) {}



    // Strategy C: Leaflet Fallback lookup

    try {

      if (win.L) {

        for (const el of document.querySelectorAll('.leaflet-container')) {

          const map = el._leaflet_map;

          if (map && map.getCenter) {

            const c = map.getCenter(), zoom = map.getZoom();

            return { lat: c.lat, lon: c.lng, res: mercRes(c.lat, zoom), zoom, src: 'Leaflet', mapObj: map };

          }

        }

      }

    } catch (_) {}



    // Strategy D: Static Fallback URL reading

    const m = location.pathname.match(/\/([-\d.]+),([-\d.]+)\/(\d+)/);

    if (m) {

      const lat = parseFloat(m[1]), lon = parseFloat(m[2]), zoom = parseInt(m[3], 10);

      return { lat, lon, res: mercRes(lat, zoom), zoom, src: 'URL' };

    }



    return null;

  }



  function mercRes(lat, zoom) {

    return (156543.03 * Math.cos(lat * DEG2RAD)) / Math.pow(2, zoom);

  }



  // ═══════════════════════════════════════════════════════════════

  // 4. LAT/LON → REAL SCREEN PIXEL (Fixed Matrix Mapping)

  // ═══════════════════════════════════════════════════════════════

  function latLonToScreen(lat, lon, view) {

    // If Mapbox/Leaflet direct conversion matrix is reachable, use it to stop floating slips

    if (view.mapObj) {

        try {

            if (view.src === 'Mapbox' && typeof view.mapObj.project === 'function') {

                const pt = view.mapObj.project([lon, lat]);

                return [pt.x, pt.y];

            }

            if (view.src === 'Leaflet' && typeof view.mapObj.latLngToContainerPoint === 'function') {

                const pt = view.mapObj.latLngToContainerPoint([lat, lon]);

                return [pt.x, pt.y];

            }

        } catch(e) { /* Fallback to standard projection equation if call fails */ }

    }



    // Mathematical Mercator Fallback

    const [mx, my] = toMercator(lat, lon);

    const [cx, cy] = toMercator(view.lat, view.lon);



    // Track canvas bounds explicitly instead of assuming screen window center sizes

    const mapCanvas = document.querySelector('.mapboxgl-canvas, .leaflet-container, canvas') || document.body;

    const rect = mapCanvas.getBoundingClientRect();



    const W = rect.width, H = rect.height;

    return [

      (W / 2) + (mx - cx) / view.res,

      (H / 2) - (my - cy) / view.res

    ];

  }



  // ═══════════════════════════════════════════════════════════════

  // 5. SVG OVERLAY CONFIGURATION

  // ═══════════════════════════════════════════════════════════════

  function setupSVG() {

    if (svgEl) return;

    svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');

    Object.assign(svgEl.style, {

      position: 'fixed', top: '0', left: '0',

      width: '100vw', height: '100vh',

      zIndex: '9998', pointerEvents: 'none'

    });

    polyEl = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');

    polyEl.setAttribute('fill',          'rgba(0,255,120,0.18)');

    polyEl.setAttribute('stroke',       '#00e87a');

    polyEl.setAttribute('stroke-width', '2.5');

    svgEl.appendChild(polyEl);

    document.body.appendChild(svgEl);

  }



  // ═══════════════════════════════════════════════════════════════

  // 6. ANIMATION RENDERING

  // ═══════════════════════════════════════════════════════════════

  function renderLoop() {

    requestAnimationFrame(renderLoop);

    if (geoCoordinates.length < 3) { updateStatus(null); return; }

    const view = getViewState();

    if (!view) { updateStatus(null); return; }



    const pts = geoCoordinates.map(([lat, lon]) => latLonToScreen(lat, lon, view));

    polyEl.setAttribute('points', pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));

    updateStatus(view);

  }



  // ═══════════════════════════════════════════════════════════════

  // 7. USER INTERFACE

  // ═══════════════════════════════════════════════════════════════

  function injectUI() {

    const panel = document.createElement('div');

    panel.id = 'fr24pgon-panel';

    Object.assign(panel.style, {

      position: 'fixed', top: '60px', left: '8px',

      zIndex: '99999',

      background: 'rgba(18,18,18,0.93)',

      color: '#ddd',

      padding: '10px 12px 12px',

      borderRadius: '6px',

      fontFamily: 'Consolas,"Courier New",monospace',

      fontSize: '11px',

      width: '280px',

      boxShadow: '0 4px 20px rgba(0,0,0,0.8)',

      border: '1px solid #2a2a2a',

      lineHeight: '1.5',

    });



    panel.innerHTML = `

      <div style="font-size:12px;font-weight:bold;color:#ccc;margin-bottom:6px;">

        Polygon Coordinate Input

      </div>

      <div style="color:#777;font-size:10px;margin-bottom:4px;">

        DMS &nbsp;&#8594;&nbsp; <span style="color:#a0a0a0;">21&deg; 36' 15" N, 87&deg; 28' 34" E</span><br>

        DD &nbsp;&nbsp;&#8594;&nbsp; <span style="color:#a0a0a0;">21.60416667, 87.47611111</span><br>

        One coordinate pair per line.

      </div>

      <textarea id="fr24pgon-input" rows="8" spellcheck="false"

        placeholder="Paste or type coordinates here..."

        style="

          width:100%;box-sizing:border-box;

          background:#0d0d0d;color:#00e87a;

          border:1px solid #333;border-radius:4px;

          padding:5px 6px;resize:vertical;

          font-family:Consolas,'Courier New',monospace;

          font-size:11px;outline:none;margin-top:4px;

         bridge-transform: none;"></textarea>

      <div id="fr24pgon-liveinfo" style="

        font-size:10px;color:#666;margin:3px 0 5px;min-height:14px;

      "></div>

      <button id="fr24pgon-update" style="

        width:100%;padding:7px 0;

        background:#c0392b;color:#fff;

        border:none;border-radius:4px;

        cursor:pointer;font-weight:bold;font-size:12px;

        letter-spacing:0.3px;

      ">&bull; Update Polygon</button>

      <button id="fr24pgon-clear" style="

        margin-top:4px;width:100%;padding:5px 0;

        background:#1e1e1e;color:#888;

        border:1px solid #333;border-radius:4px;

        cursor:pointer;font-size:11px;

      ">&#10006; Clear</button>

      <div style="margin-top:8px;border-top:1px solid #2a2a2a;padding-top:6px;font-size:10px;color:#666;">

        <div id="fr24pgon-centre">Centre: &#8212;</div>

        <div id="fr24pgon-res">Resolution: &#8212;</div>

        <div id="fr24pgon-pts">Points: 0</div>

      </div>

    `;



    document.body.appendChild(panel);

    centreEl = document.getElementById('fr24pgon-centre');

    resEl    = document.getElementById('fr24pgon-res');

    ptsEl    = document.getElementById('fr24pgon-pts');



    document.getElementById('fr24pgon-update').addEventListener('click', onUpdate);

    document.getElementById('fr24pgon-clear').addEventListener('click', onClear);

    document.getElementById('fr24pgon-input').addEventListener('input', onLivePreview);

  }



  function onLivePreview() {

    const raw  = document.getElementById('fr24pgon-input').value;

    const info = document.getElementById('fr24pgon-liveinfo');

    if (!info || raw.trim() === '') { if (info) info.textContent = ''; return; }

    const { coords, errors } = parseCoordinates(raw);

    if (coords.length === 0) {

      info.style.color = '#e67e22';

      info.textContent = '\u26a0 No valid coordinates detected';

    } else if (coords.length < 3) {

      info.style.color = '#e67e22';

      info.textContent = `\u26a0 ${coords.length} point(s) — need \u22653`;

    } else {

      info.style.color = '#00e87a';

      info.textContent = `\u2713 ${coords.length} point(s) mapped${errors.length ? ' (' + errors.length + ' skipped)' : ''}`;

    }

  }



  function onUpdate() {

    const raw = document.getElementById('fr24pgon-input').value;

    const { coords, errors } = parseCoordinates(raw);



    if (coords.length < 3) {

      let msg = `Need at least 3 coordinate pairs.\nParsed successfully: ${coords.length}`;

      if (errors.length > 0) {

        msg += `\n\nLines that failed to parse:\n${errors.map(e => '  \u2022 ' + e).join('\n')}`;

      }

      alert(msg);

      return;

    }



    geoCoordinates = coords;

    onLivePreview();

  }



  function onClear() {

    geoCoordinates = [];

    if (polyEl)   polyEl.setAttribute('points', '');

    if (ptsEl)    ptsEl.textContent = 'Points: 0';

    if (centreEl) { centreEl.textContent = 'Centre: \u2014'; centreEl.style.color = '#666'; }

    if (resEl)    resEl.textContent = 'Resolution: \u2014';

    const info = document.getElementById('fr24pgon-liveinfo');

    if (info) info.textContent = '';

    const ta = document.getElementById('fr24pgon-input');

    if (ta) ta.value = '';

  }



  function updateStatus(view) {

    if (!centreEl) return;

    if (!view || geoCoordinates.length < 3) {

      centreEl.textContent = geoCoordinates.length < 3 ? 'Centre: Add \u22653 points first' : 'Centre: Syncing map...';

      centreEl.style.color = '#666';

      resEl.textContent    = 'Resolution: \u2014';

      ptsEl.textContent    = `Points: ${geoCoordinates.length}`;

    } else {

      centreEl.textContent = `Centre: ${view.lat.toFixed(4)}\u00b0N, ${view.lon.toFixed(4)}\u00b0E (${view.src})`;

      centreEl.style.color = '#00e87a';

      resEl.textContent    = `Resolution: ${view.res.toFixed(2)} m/px`;

      ptsEl.textContent    = `Points: ${geoCoordinates.length}`;

    }

  }



  const boot = setInterval(() => {

    if (document.body) {

      clearInterval(boot);

      setupSVG();

      injectUI();

      renderLoop();

    }

  }, 200);



})();