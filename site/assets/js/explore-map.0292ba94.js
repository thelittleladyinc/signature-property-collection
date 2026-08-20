/*
 * The /explore page's Mapbox map — the whole business on one map: counties,
 * all 37 towns with live median asking prices, Christine's local spots with
 * her videos and Google reviews, her active listings as price bubbles, her
 * sold homes, 3D terrain and buildings, satellite, a cinematic tour,
 * draw-an-area search, "15 minutes from here" isochrones, and an Ask-the-Map
 * bar that takes typed or spoken questions.
 *
 * Sibling of build/tools/mapbox_preview_template.html (the standalone
 * preview Christine approved 2026-08-20, "lets do it all!"). Same features,
 * same brand, two deliberate differences: the token comes from
 * /.netlify/functions/mapbox-token (set MAPBOX_PUBLIC_TOKEN in Netlify env
 * vars; until then this page shows a friendly note, not a broken map), and
 * every dataset is fetched from this site's own endpoints instead of being
 * embedded. When changing a feature here, change the preview template too.
 *
 * NOTHING here touches the Leaflet county map, the sold-homes map, or any
 * Google-powered panel — this is an addition, not a replacement.
 */
(function () {
  'use strict';
  var host = document.getElementById('spc-explore');
  if (!host) return;

  var GL_JS = 'https://api.mapbox.com/mapbox-gl-js/v3.8.0/mapbox-gl.js';
  var GL_CSS = 'https://api.mapbox.com/mapbox-gl-js/v3.8.0/mapbox-gl.css';
  var DARK = 'mapbox://styles/mapbox/dark-v11';
  var SAT = 'mapbox://styles/mapbox/satellite-streets-v12';
  var HOME_VIEW = { center: [-104.93, 40.36], zoom: 8.1, pitch: 0, bearing: 0 };
  var ZOOM_THUMBS = 11;

  // Baked by build.py next to the container: {"Loveland": {medianList, activeCount}, ...}
  var MARKET = (window.SPC_EXPLORE_MARKET || {});

  var GLYPHS = {
    golf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="21" x2="6" y2="3"/><path d="M6 3 L17 7 L6 11 Z" fill="currentColor" stroke="none"/><circle cx="6" cy="21" r="1.6" fill="currentColor" stroke="none"/></svg>',
    restaurant: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v8a2 2 0 0 0 4 0V3"/><line x1="8" y1="11" x2="8" y2="21"/><path d="M16 3c-1.6 1-2.4 2.6-2.4 4.4S14.4 11 16 11.6V21"/></svg>',
    winery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3h8l-.7 5a3.3 3.3 0 0 1-6.6 0Z"/><line x1="12" y1="13" x2="12" y2="19"/><line x1="9" y1="21" x2="15" y2="21"/></svg>',
    trail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 19l6-9 3 4 2-3 7 8Z"/></svg>',
    lake: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9c2.5 0 2.5 2 5 2s2.5-2 5-2 2.5 2 5 2 2.5-2 3-2"/><path d="M3 15c2.5 0 2.5 2 5 2s2.5-2 5-2 2.5 2 5 2 2.5-2 3-2"/></svg>',
    downtown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V8l5-3v16"/><path d="M9 21V11l6-3v13"/><path d="M15 21V12l5 2v7"/></svg>',
    scenic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3"/><path d="M3 21c2-5 5.5-7 9-7s7 2 9 7"/></svg>',
    event: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21l5-13 8 5Z"/><line x1="9" y1="8" x2="10.5" y2="4"/><circle cx="11" cy="3" r="1.4" fill="currentColor" stroke="none"/></svg>',
    spot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z"/><circle cx="12" cy="10" r="2.4"/></svg>'
  };
  var FILTER_GROUPS = [
    { key: '', label: 'Everywhere' },
    { key: 'eat', label: 'Where I eat' },
    { key: 'drink', label: 'Wine & drinks' },
    { key: 'outdoors', label: 'Outdoors' },
    { key: 'town', label: 'Around town' }
  ];
  var ASK_GROUPS = [
    { key: 'eat', chip: 'Where I eat', words: /coffee|cafe|restaurant|food|eat|dining|dinner|lunch|breakfast/ },
    { key: 'drink', chip: 'Wine & drinks', words: /wine|winery|brewery|drinks?|bar\b/ },
    { key: 'outdoors', chip: 'Outdoors', words: /trail|hik(e|ing)|lake|golf|outdoor|park|mountain|fish/ },
    { key: 'town', chip: 'Around town', words: /downtown|events?|shops?|walkab|main street/ }
  ];
  var RIVERS = [
    { name: 'Cache la Poudre River', at: [-105.03, 40.53], rotate: -14 },
    { name: 'South Platte River', at: [-104.55, 40.395], rotate: -8 }
  ];
  var TOUR_NAMES = [
    'Horsetooth Reservoir', "Devil's Backbone Open Space", 'Sweet Heart Winery',
    'Downtown Loveland', 'Windsor Lake & Boardwalk Park', '24 Carrot Bistro',
    'Beaver Meadows Resort Ranch'
  ];

  var DATA = { counties: null, towns: [], spots: [] };
  var map, spots = [], markers = [], soldMarkers = [], hoverPop = null, cardPop = null;
  var hoveredCounty = null, satOn = false, tiltOn = false, layerEventsBound = false;
  var soldState = 'off', soldPins = [], myListings = [], listingMarkers = [];
  var draw = { active: false, done: false, pts: [] };
  var iso = { feature: null, label: '' };
  var tour = { on: false, i: 0, timer: null };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function notice(html) {
    host.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;height:100%;padding:32px;text-align:center;background:#141415">' +
      '<p style="color:rgba(248,246,244,.85);font-size:15px;line-height:1.8;max-width:460px;margin:0">' + html + '</p></div>';
    if (dbgEl) host.appendChild(dbgEl);
  }

  // ?mapdebug=1: a small on-page log of every boot step, so a phone
  // screenshot IS the diagnosis. Shows nothing unless asked for by URL.
  var dbgEl = null;
  if (new URLSearchParams(location.search).has('mapdebug')) {
    dbgEl = document.createElement('div');
    dbgEl.style.cssText = 'position:absolute;top:8px;left:8px;right:8px;z-index:2147483001;' +
      'background:rgba(0,0,0,.85);color:#9fc7a8;font:11px/1.7 ui-monospace,Menlo,monospace;' +
      'padding:10px 12px;pointer-events:none;white-space:pre-wrap;word-break:break-all';
    dbgEl.textContent = 'map debug\n';
  }
  function dbg(line) {
    if (!dbgEl) return;
    if (!dbgEl.parentNode && host) host.appendChild(dbgEl);
    dbgEl.textContent += line + '\n';
  }

  /* ---------------- styles (scoped under #spc-explore) ---------------- */
  var CSS = '' +
    '#spc-explore{position:relative;background:#141415;overflow:hidden}' +
    '#spc-explore .xm-map{position:absolute;inset:0}' +
    /* The site stylesheet's global `img{max-width:100%}` and friends must
       never leak into Mapbox's internals — a constrained canvas or control
       image shifts everything off its true position. */
    '#spc-explore .mapboxgl-canvas{max-width:none!important}' +
    '#spc-explore .mapboxgl-map img{max-width:none}' +
    '#spc-explore .brand-pill{position:absolute;top:14px;left:14px;z-index:21;display:flex;align-items:center;gap:10px;cursor:pointer;border:1px solid rgba(248,246,244,.16);background:rgba(20,20,21,.86);backdrop-filter:blur(8px);color:#F8F6F4;padding:7px 14px 7px 12px;box-shadow:0 8px 30px rgba(0,0,0,.4)}' +
    '#spc-explore .brand-pill .script{font-family:"Corinthia",cursive;font-size:26px;line-height:1;color:#BA8C84}' +
    '#spc-explore .brand-pill .dot{width:7px;height:7px;border-radius:50%;background:#BA8C84;flex:0 0 auto}' +
    '#spc-explore .brand-pill .dot.ok{background:#9fc7a8}' +
    '#spc-explore .brand-pill .caret{font-size:10px;color:rgba(248,246,244,.6)}' +
    '#spc-explore .xm-panel{position:absolute;top:62px;left:14px;z-index:21;max-width:300px;display:none;background:rgba(20,20,21,.9);backdrop-filter:blur(8px);border:1px solid rgba(248,246,244,.14);padding:16px 18px;color:#F8F6F4;box-shadow:0 12px 40px rgba(0,0,0,.45)}' +
    '#spc-explore .xm-panel.open{display:block}' +
    '#spc-explore .xm-panel .wordmark{font-size:9.5px;letter-spacing:.26em;text-transform:uppercase;margin:0 0 8px;font-weight:600}' +
    '#spc-explore .xm-panel .tag{font-family:"Libre Baskerville",Georgia,serif;font-style:italic;font-size:12.5px;line-height:1.65;color:rgba(248,246,244,.82);margin:0 0 12px}' +
    '#spc-explore .xm-panel .status{font-size:10.5px;color:rgba(248,246,244,.55);margin:0;line-height:1.6}' +
    '#spc-explore .xm-panel .status .ok{color:#9fc7a8}' +
    '#spc-explore .xm-panel .status .warn{color:#BA8C84}' +
    '#spc-explore .xm-panel .legend{margin:12px 0 0;padding:10px 0 0;border-top:1px solid rgba(248,246,244,.12);font-size:10.5px;color:rgba(248,246,244,.7);line-height:1.9}' +
    '#spc-explore .xm-panel .legend b{color:#F8F6F4;font-weight:600}' +
    '#spc-explore .chipbar{position:absolute;bottom:14px;left:50%;transform:translateX(-50%);z-index:20;display:flex;gap:6px;max-width:calc(100% - 24px);overflow-x:auto;padding:6px;background:rgba(20,20,21,.78);backdrop-filter:blur(8px);border:1px solid rgba(248,246,244,.14);scrollbar-width:none}' +
    '#spc-explore .chipbar::-webkit-scrollbar{display:none}' +
    '#spc-explore .chip{flex:0 0 auto;border:1px solid rgba(248,246,244,.3);background:transparent;color:#F8F6F4;font-family:"Poppins",sans-serif;font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;padding:7px 11px;cursor:pointer}' +
    '#spc-explore .chip:hover{border-color:#BA8C84;color:#BA8C84}' +
    '#spc-explore .chip.on{background:#B86F7A;border-color:#B86F7A;color:#F8F6F4}' +
    '#spc-explore .askbar{position:absolute;top:14px;left:50%;transform:translateX(-50%);z-index:21;display:flex;align-items:center;background:rgba(20,20,21,.88);backdrop-filter:blur(8px);border:1px solid rgba(248,246,244,.18);box-shadow:0 8px 30px rgba(0,0,0,.4);width:min(430px,calc(100% - 320px))}' +
    '#spc-explore .askbar input{flex:1;min-width:0;background:transparent;border:none;outline:none;color:#F8F6F4;font-family:"Poppins",sans-serif;font-size:12.5px;padding:11px 12px}' +
    '#spc-explore .askbar input::placeholder{color:rgba(248,246,244,.4)}' +
    '#spc-explore .askbar button{border:none;background:transparent;color:#BA8C84;cursor:pointer;padding:10px 12px;display:flex;align-items:center}' +
    '#spc-explore .askbar button svg{width:15px;height:15px}' +
    '#spc-explore .askbar button:hover{color:#F8F6F4}' +
    '#spc-explore .askbar button.go{background:#B86F7A;color:#F8F6F4;font-family:"Poppins",sans-serif;font-size:10.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;padding:11px 14px}' +
    '#spc-explore .askbar button.mic.listening{color:#B86F7A;animation:xm-blink 1s ease-in-out infinite alternate}' +
    '@keyframes xm-blink{from{opacity:1}to{opacity:.35}}' +
    '#spc-explore .ctrls{position:absolute;top:14px;right:14px;z-index:20;display:flex;flex-direction:column;gap:8px}' +
    '#spc-explore .ctrl-btn{display:flex;align-items:center;gap:8px;cursor:pointer;background:rgba(20,20,21,.86);backdrop-filter:blur(8px);color:#F8F6F4;border:1px solid rgba(248,246,244,.16);padding:11px 15px;font-family:"Poppins",sans-serif;font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase}' +
    '#spc-explore .ctrl-btn svg{width:15px;height:15px;flex:0 0 auto}' +
    '#spc-explore .ctrl-btn:hover{border-color:#BA8C84;color:#BA8C84}' +
    '#spc-explore .ctrl-btn.on{background:#B86F7A;border-color:#B86F7A;color:#F8F6F4}' +
    '#spc-explore .xm-foot{position:absolute;bottom:58px;right:14px;z-index:20;display:flex;flex-direction:column;gap:6px;align-items:flex-end}' +
    '#spc-explore .xm-foot button{border:1px solid rgba(248,246,244,.14);cursor:pointer;background:rgba(20,20,21,.8);color:rgba(248,246,244,.75);padding:8px 12px;font-family:"Poppins",sans-serif;font-size:10px;letter-spacing:.08em;text-transform:uppercase}' +
    '#spc-explore .xm-foot button:hover{color:#BA8C84;border-color:#BA8C84}' +
    '#spc-explore .toast{position:absolute;top:70px;left:50%;transform:translateX(-50%);z-index:40;background:rgba(20,20,21,.92);border:1px solid rgba(184,111,122,.6);color:#F8F6F4;font-size:12px;padding:12px 18px;max-width:min(480px,calc(100% - 40px));box-shadow:0 12px 40px rgba(0,0,0,.5);display:none;text-align:center;line-height:1.6}' +
    '#spc-explore .toast.open{display:block}' +
    '#spc-explore .tour-card{position:absolute;bottom:70px;left:50%;transform:translateX(-50%);z-index:25;width:min(520px,calc(100% - 40px));background:rgba(20,20,21,.9);backdrop-filter:blur(8px);border:1px solid rgba(184,111,122,.5);padding:18px 22px;color:#F8F6F4;display:none;box-shadow:0 16px 50px rgba(0,0,0,.5)}' +
    '#spc-explore .tour-card.open{display:block}' +
    '#spc-explore .tour-card h3{font-family:"Libre Baskerville",Georgia,serif;font-weight:400;font-size:19px;margin:0 0 6px;color:#F8F6F4}' +
    '#spc-explore .tour-card p{font-family:"Libre Baskerville",Georgia,serif;font-style:italic;font-size:13px;line-height:1.7;color:rgba(248,246,244,.82);margin:0}' +
    '#spc-explore .tour-card .tour-n{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#BA8C84;margin:0 0 8px;font-family:"Poppins",sans-serif;font-style:normal}' +
    '#spc-explore .draw-hint{position:absolute;top:70px;left:50%;transform:translateX(-50%);z-index:26;display:none;gap:10px;align-items:center;background:rgba(20,20,21,.92);border:1px solid rgba(184,111,122,.6);color:#F8F6F4;font-size:12px;padding:10px 14px;box-shadow:0 12px 40px rgba(0,0,0,.5)}' +
    '#spc-explore .draw-hint.open{display:flex}' +
    '#spc-explore .draw-hint button{border:1px solid rgba(248,246,244,.4);background:transparent;color:#F8F6F4;font-family:"Poppins",sans-serif;font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;padding:6px 10px;cursor:pointer}' +
    '#spc-explore .draw-hint button.go{background:#B86F7A;border-color:#B86F7A}' +
    '#spc-explore .draw-results{position:absolute;bottom:64px;left:14px;z-index:24;width:min(300px,calc(100% - 28px));max-height:46%;overflow-y:auto;display:none;background:rgba(20,20,21,.92);backdrop-filter:blur(8px);border:1px solid rgba(184,111,122,.55);color:#F8F6F4;padding:16px 18px;box-shadow:0 16px 50px rgba(0,0,0,.5)}' +
    '#spc-explore .draw-results.open{display:block}' +
    '#spc-explore .draw-results h3{font-family:"Libre Baskerville",Georgia,serif;font-weight:400;font-size:17px;margin:0 0 10px;color:#F8F6F4}' +
    '#spc-explore .draw-results .dr-line{font-size:12px;line-height:1.8;color:rgba(248,246,244,.85);margin:0}' +
    '#spc-explore .draw-results .dr-line b{color:#F8F6F4}' +
    '#spc-explore .draw-results a.dr-listing{display:block;font-size:12px;color:#BA8C84;text-decoration:none;padding:3px 0}' +
    '#spc-explore .draw-results a.dr-listing:hover{color:#F8F6F4}' +
    '#spc-explore .draw-results .dr-actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}' +
    '#spc-explore .draw-results .dr-actions a,#spc-explore .draw-results .dr-actions button{border:1px solid rgba(248,246,244,.45);background:transparent;color:#F8F6F4;text-decoration:none;cursor:pointer;font-family:"Poppins",sans-serif;font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;padding:8px 11px}' +
    '#spc-explore .draw-results .dr-actions a{background:#B86F7A;border-color:#B86F7A}' +
    '#spc-explore .draw-results .dr-actions a:hover,#spc-explore .draw-results .dr-actions button:hover{border-color:#BA8C84;color:#BA8C84}' +
    '#spc-explore.drawing .mapboxgl-canvas-container{cursor:crosshair!important}' +
    '#spc-explore .spc-pin{cursor:pointer}' +
    '#spc-explore .spc-pin-inner{width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#141415;border:2px solid #B86F7A;color:#F8F6F4;box-shadow:0 2px 10px rgba(0,0,0,.55);transition:transform .15s ease,border-color .15s ease;position:relative}' +
    '#spc-explore .spc-pin-inner svg{width:17px;height:17px}' +
    '#spc-explore .spc-pin:hover .spc-pin-inner{transform:scale(1.18);border-color:#F8F6F4}' +
    '#spc-explore .spc-pin.approx .spc-pin-inner{border-style:dashed;opacity:.85}' +
    '#spc-explore .spc-pin.has-video .spc-pin-inner{background:#B86F7A;border-color:#F8F6F4}' +
    '#spc-explore .spc-pin.has-video .spc-pin-inner::after{content:"";position:absolute;inset:-2px;border-radius:50%;border:2px solid #B86F7A;animation:xm-pulse 2.6s ease-out infinite;pointer-events:none}' +
    '@keyframes xm-pulse{0%{transform:scale(1);opacity:.8}70%{transform:scale(1.9);opacity:0}100%{transform:scale(1.9);opacity:0}}' +
    '#spc-explore .spc-badge{position:absolute;right:-5px;top:-5px;width:15px;height:15px;border-radius:50%;background:#141415;border:1.5px solid #F8F6F4;display:flex;align-items:center;justify-content:center}' +
    '#spc-explore .spc-badge svg{width:8px;height:8px;color:#F8F6F4}' +
    '#spc-explore .spc-badge.star{background:#F8F6F4}' +
    '#spc-explore .spc-badge.star svg{color:#B86F7A}' +
    '#spc-explore .spc-thumb{display:none;position:relative;width:76px;height:44px;border:2px solid #B86F7A;box-shadow:0 4px 16px rgba(0,0,0,.6);background:#000}' +
    '#spc-explore .spc-thumb img{width:100%;height:100%;object-fit:cover;display:block}' +
    '#spc-explore .spc-thumb::after{content:"";position:absolute;inset:0;margin:auto;width:0;height:0;border-left:12px solid rgba(248,246,244,.95);border-top:7px solid transparent;border-bottom:7px solid transparent;filter:drop-shadow(0 1px 3px rgba(0,0,0,.8))}' +
    '#spc-explore .spc-pin:hover .spc-thumb{border-color:#F8F6F4}' +
    '#spc-explore.zoomed-thumbs .spc-pin.has-video .spc-pin-inner{display:none}' +
    '#spc-explore.zoomed-thumbs .spc-pin.has-video .spc-thumb{display:block}' +
    '#spc-explore .spc-listing{cursor:pointer;background:#F8F6F4;color:#141415;font-family:"Poppins",sans-serif;font-weight:700;font-size:12px;letter-spacing:.01em;padding:5px 10px;border:2px solid #B86F7A;border-radius:14px;box-shadow:0 3px 12px rgba(0,0,0,.55);white-space:nowrap;transition:transform .15s ease,background .15s ease}' +
    '#spc-explore .spc-listing:hover{transform:scale(1.12);background:#B86F7A;color:#F8F6F4}' +
    '#spc-explore .spc-listing.pending{border-style:dashed;opacity:.9}' +
    '#spc-explore.hide-listings .spc-listing{display:none}' +
    '#spc-explore .spc-sold{width:16px;height:16px;border-radius:50%;cursor:pointer;background:#F8F6F4;border:3px solid #B86F7A;box-shadow:0 2px 8px rgba(0,0,0,.55);transition:transform .15s ease}' +
    '#spc-explore .spc-sold:hover{transform:scale(1.35)}' +
    '#spc-explore.hide-sold .spc-sold{display:none}' +
    '#spc-explore.only-eat .spc-pin:not(.cat-restaurant),' +
    '#spc-explore.only-drink .spc-pin:not(.cat-winery),' +
    '#spc-explore.only-outdoors .spc-pin:not(.cat-trail):not(.cat-lake):not(.cat-scenic):not(.cat-golf),' +
    '#spc-explore.only-town .spc-pin:not(.cat-downtown):not(.cat-event):not(.cat-spot){display:none}' +
    '#spc-explore .river-label{font-family:"Corinthia",cursive;font-size:26px;color:#7FA9BA;text-shadow:0 1px 6px rgba(0,0,0,.9);white-space:nowrap;pointer-events:none}' +
    '.mapboxgl-popup.spc-tip .mapboxgl-popup-content{background:#141415;color:#F8F6F4;border:1px solid rgba(184,111,122,.55);padding:8px;font-family:"Poppins",sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5)}' +
    '.mapboxgl-popup.spc-tip .mapboxgl-popup-tip{border-top-color:#141415;border-bottom-color:#141415}' +
    '.spc-tip-img{display:block;width:190px;height:107px;object-fit:cover;margin-bottom:7px}' +
    '.spc-tip-name{font-size:12px;font-weight:600;letter-spacing:.02em;display:block;padding:0 2px 2px}' +
    '.spc-tip-sub{font-size:10px;color:#BA8C84;display:block;padding:0 2px 2px}' +
    '.mapboxgl-popup.spc-card{z-index:30}' +
    '.mapboxgl-popup.spc-card .mapboxgl-popup-content{background:#141415;color:#F8F6F4;width:min(360px,86vw);border:1px solid rgba(184,111,122,.55);padding:0;font-family:"Poppins",sans-serif;box-shadow:0 24px 70px rgba(0,0,0,.65)}' +
    '.mapboxgl-popup.spc-card .mapboxgl-popup-tip{border-top-color:#141415;border-bottom-color:#141415}' +
    '.mapboxgl-popup.spc-card .mapboxgl-popup-close-button{color:#F8F6F4;font-size:22px;right:6px;top:2px;z-index:2}' +
    '.spc-card-video{aspect-ratio:16/9;background:#000}' +
    '.spc-card-video iframe{width:100%;height:100%;display:block;border:0}' +
    '.spc-card-photo{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;background:#222}' +
    '.spc-card-body{padding:16px 18px 18px}' +
    '.spc-card-body h3{font-family:"Libre Baskerville",Georgia,serif;font-weight:400;font-size:19px;margin:0 0 4px;color:#F8F6F4}' +
    '.spc-card-city{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#BA8C84;margin:0 0 10px}' +
    '.spc-card-body p.blurb{font-size:12.5px;line-height:1.7;color:rgba(248,246,244,.85);margin:0 0 10px}' +
    '.spc-card-body blockquote{margin:0 0 12px;padding:8px 12px;border-left:3px solid #B86F7A;font-family:"Libre Baskerville",Georgia,serif;font-style:italic;font-size:12.5px;line-height:1.65;color:rgba(248,246,244,.9)}' +
    '.spc-card-credit{font-size:10.5px;color:rgba(248,246,244,.5);margin:0 0 12px}' +
    '.spc-card-approx{font-size:10.5px;color:#BA8C84;margin:0 0 12px}' +
    '.spc-card-facts{font-size:12px;color:rgba(248,246,244,.85);margin:0 0 12px;letter-spacing:.02em}' +
    '.spc-card-facts b{color:#F8F6F4}' +
    '.spc-card-actions{display:flex;flex-wrap:wrap;gap:8px}' +
    '.spc-card-actions a,.spc-card-actions button{border:1px solid rgba(248,246,244,.45);background:transparent;cursor:pointer;color:#F8F6F4;text-decoration:none;font-family:"Poppins",sans-serif;font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;padding:8px 11px}' +
    '.spc-card-actions a:hover,.spc-card-actions button:hover{border-color:#B86F7A;color:#B86F7A}' +
    '.mapboxgl-popup.spc-town .mapboxgl-popup-content{background:#F8F6F4;color:#141415;padding:16px 18px;font-family:"Poppins",sans-serif;border:none;box-shadow:0 16px 50px rgba(0,0,0,.5)}' +
    '.mapboxgl-popup.spc-town .mapboxgl-popup-tip{border-top-color:#F8F6F4;border-bottom-color:#F8F6F4}' +
    '.spc-town-name{font-family:"Libre Baskerville",Georgia,serif;font-size:18px;margin:0 0 2px}' +
    '.spc-town-county{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#B86F7A;margin:0 0 12px}' +
    '.spc-town-market{font-size:12px;color:#3c3c3e;margin:-6px 0 12px}' +
    '.spc-town-market b{color:#141415}' +
    '.spc-town-links{display:flex;gap:8px;flex-wrap:wrap}' +
    '.spc-town-links a{font-size:10px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;text-decoration:none;padding:8px 11px}' +
    '.spc-town-links a.dark{background:#141415;color:#F8F6F4}' +
    '.spc-town-links a.line{border:1px solid #141415;color:#141415}' +
    '.spc-town-links a:hover{background:#B86F7A;border-color:#B86F7A;color:#F8F6F4}' +
    '.spc-town-links button{border:1px solid #141415;background:transparent;color:#141415;cursor:pointer;font-family:"Poppins",sans-serif;font-size:10px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;padding:8px 11px}' +
    '.spc-town-links button:hover{background:#B86F7A;border-color:#B86F7A;color:#F8F6F4}' +
    /* Full-screen mode: the map takes the whole viewport, app-style. dvh so
       iOS Safari's collapsing chrome doesn't leave a dead strip. */
    '#spc-explore.xm-full{position:fixed;inset:0;z-index:2147483000;height:100dvh}' +
    'body.xm-lock{overflow:hidden}' +
    '@media (max-width:860px){#spc-explore .askbar{top:60px;width:min(430px,calc(100% - 28px))}}' +
    /* Phones: controls become a thumb-reach strip along the bottom (labels
       kept — icon-only buttons tested as guesswork), the filter chips hug the
       very bottom edge with safe-area padding for the iPhone home bar, and
       results cards become a full-width bottom sheet instead of a floating
       box. Mapbox's own zoom/attribution controls move up out of the way. */
    '@media (max-width:640px){' +
      '#spc-explore .brand-pill .script{font-size:22px}' +
      '#spc-explore .toast,#spc-explore .draw-hint{top:108px}' +
      '#spc-explore .ctrls{top:auto;bottom:calc(56px + env(safe-area-inset-bottom,0px));left:0;right:0;flex-direction:row;overflow-x:auto;padding:6px 10px;gap:6px;scrollbar-width:none}' +
      '#spc-explore .ctrls::-webkit-scrollbar{display:none}' +
      '#spc-explore .ctrl-btn{padding:10px 12px;flex:0 0 auto;font-size:10px;white-space:nowrap}' +
      '#spc-explore .ctrl-btn svg{width:13px;height:13px}' +
      '#spc-explore .chipbar{bottom:0;left:0;right:0;transform:none;max-width:none;border-left:none;border-right:none;padding:6px 10px calc(6px + env(safe-area-inset-bottom,0px))}' +
      '#spc-explore .chip{padding:10px 13px}' +
      '#spc-explore .draw-results{left:0;right:0;bottom:0;width:100%;max-height:58%;border-left:none;border-right:none;padding-bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:31}' +
      '#spc-explore .tour-card{bottom:calc(116px + env(safe-area-inset-bottom,0px))}' +
      '#spc-explore .xm-foot{bottom:calc(116px + env(safe-area-inset-bottom,0px))}' +
      '#spc-explore .mapboxgl-ctrl-bottom-right{bottom:calc(108px + env(safe-area-inset-bottom,0px))}' +
      '#spc-explore .mapboxgl-ctrl-bottom-left{bottom:calc(108px + env(safe-area-inset-bottom,0px))}' +
    '}';

  var MARKUP = '' +
    '<div class="xm-map" id="xm-map"></div>' +
    '<button class="brand-pill" id="xm-pill" aria-expanded="false"><span class="script">The Little Lady</span><span class="dot" id="xm-dot"></span><span class="caret">▾</span></button>' +
    '<div class="xm-panel" id="xm-panel">' +
      '<p class="wordmark">Signature Property Collection</p>' +
      '<p class="tag">Northern Colorado, from someone who actually goes there.</p>' +
      '<p class="status" id="xm-status"></p>' +
      '<p class="legend"><b>Price bubbles</b> — my listings for sale right now<br>' +
      '<b>Rose pulsing pins</b> — places with my videos (zoom in and they become the video)<br>' +
      '<b>★ pins</b> — places I\'ve reviewed on Google<br>' +
      '<b>Cream dots</b> — homes I\'ve sold (toggle on the right)<br>' +
      '<b>Draw Search Area</b> — outline any shape, see what\'s inside it</p>' +
    '</div>' +
    '<div class="askbar"><button class="mic" id="xm-mic" title="Speak your search" aria-label="Speak your search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="21"/></svg></button>' +
    '<input id="xm-ask" autocomplete="off" spellcheck="false" placeholder="Try: &#8220;Loveland under $600K near trails&#8221;">' +
    '<button class="go" id="xm-go">Ask</button></div>' +
    '<div class="ctrls">' +
      '<button class="ctrl-btn" id="xm-3d"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M2 20 L9 7 L13 14 L16 9 L22 20 Z"/></svg><span>3D Terrain</span></button>' +
      '<button class="ctrl-btn" id="xm-sat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14 0 18M12 3c-3 3.5-3 14 0 18"/></svg><span>Satellite</span></button>' +
      '<button class="ctrl-btn" id="xm-mine"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z"/><path d="M9.5 10.5 L12 8 L14.5 10.5"/><path d="M10.2 10.2v3h3.6v-3"/></svg><span>My Listings</span></button>' +
      '<button class="ctrl-btn" id="xm-draw"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8 L11 4 L20 7 L17 16 L7 19 Z" stroke-dasharray="3 2"/><circle cx="4" cy="8" r="1.6" fill="currentColor" stroke="none"/><circle cx="11" cy="4" r="1.6" fill="currentColor" stroke="none"/><circle cx="20" cy="7" r="1.6" fill="currentColor" stroke="none"/><circle cx="17" cy="16" r="1.6" fill="currentColor" stroke="none"/><circle cx="7" cy="19" r="1.6" fill="currentColor" stroke="none"/></svg><span>Draw Search Area</span></button>' +
      '<button class="ctrl-btn" id="xm-sold-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11 L12 3 L21 11"/><path d="M5 10v10h14V10"/><path d="M9 21v-6h6v6"/></svg><span>Homes I\'ve Sold</span></button>' +
      '<button class="ctrl-btn" id="xm-tour"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg><span>Fly the Tour</span></button>' +
      '<button class="ctrl-btn" id="xm-reset"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg><span>Reset View</span></button>' +
      '<button class="ctrl-btn" id="xm-share"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 8h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-3"/><path d="M4 14 L14 4"/><path d="M9 4h5v5"/></svg><span>Copy Link</span></button>' +
      '<button class="ctrl-btn" id="xm-full-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H4v5"/><path d="M15 4h5v5"/><path d="M9 20H4v-5"/><path d="M15 20h5v-5"/></svg><span>Full Screen</span></button>' +
    '</div>' +
    '<div class="tour-card" id="xm-tour-card"><p class="tour-n" id="xm-tour-n"></p><h3 id="xm-tour-name"></h3><p id="xm-tour-blurb"></p></div>' +
    '<div class="toast" id="xm-toast"></div>' +
    '<div class="draw-hint" id="xm-draw-hint"><span>Click the map to outline your area</span><button class="go" id="xm-draw-finish">Finish</button><button id="xm-draw-cancel">Cancel</button></div>' +
    '<div class="draw-results" id="xm-results"></div>' +
    '<div class="chipbar" id="xm-chips"></div>';

  function $(id) { return document.getElementById(id); }

  /* ---------------- boot: token + data, then Mapbox ---------------- */
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // mapbox-gl.css must be APPLIED before the map is constructed — without it
  // the canvas, markers and popups all render unpositioned ("nothing is
  // centered", Christine, 2026-08-20, on her phone: dynamically-injected
  // stylesheets load async, and on a slow connection the 2MB GL script can
  // win the race against its own CSS). The boot below awaits this promise;
  // a 4s timeout keeps a hung CDN from blanking the page forever.
  var glCssReady = new Promise(function (resolve) {
    var link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = GL_CSS;
    link.onload = resolve; link.onerror = resolve;
    document.head.appendChild(link);
    setTimeout(resolve, 4000);
  });
  var style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  // ?uitest=1 renders the overlay UI with no map and no network, so the
  // layout is verifiable in a browser before shipping — this repo's hard
  // rule after the card-photo incident ("everything that can only be
  // verified in a browser needs a browser"). No data flows; visitors never
  // hit it unless they type the parameter themselves.
  if (new URLSearchParams(location.search).has('uitest')) {
    host.innerHTML = MARKUP;
    return;
  }

  Promise.all([
    fetch('/.netlify/functions/mapbox-token').then(function (r) { return r.json(); }).catch(function () { return null; }),
    fetch('/assets/data/county-search.json').then(function (r) { return r.json(); }).catch(function () { return null; }),
    fetch('/assets/data/noco-counties.geojson').then(function (r) { return r.json(); }).catch(function () { return null; }),
    loadScript(GL_JS).then(function () { return true; }).catch(function () { return false; }),
    glCssReady
  ]).then(function (loaded) {
    var tok = loaded[0], countySearch = loaded[1], countiesRaw = loaded[2], glOk = loaded[3];
    dbg('token fetch: ' + (tok ? (tok.token ? 'ok (pk…' + String(tok.token).slice(-6) + ')' : JSON.stringify(tok)) : 'FAILED'));
    dbg('mapbox-gl.js: ' + (glOk && typeof mapboxgl !== 'undefined' ? 'loaded ✓ v' + (mapboxgl.version || '?') : 'FAILED'));
    dbg('county data: ' + (countySearch ? 'ok' : 'FAILED') + ' · county shapes: ' + (countiesRaw ? 'ok' : 'FAILED'));
    if (!tok || !tok.token) {
      notice('The interactive map is warming up — the Mapbox key isn\'t configured yet. ' +
        'Meanwhile, every community is covered in the <a href="/communities/index.html" style="color:#BA8C84">area guides</a>.');
      return;
    }
    if (!glOk || typeof mapboxgl === 'undefined' || !countySearch || !countiesRaw) {
      notice('The map couldn\'t load just now — please refresh, or browse the <a href="/communities/index.html" style="color:#BA8C84">area guides</a>.');
      return;
    }
    // Normalize the Census property name so every layer reads `name`.
    DATA.counties = {
      type: 'FeatureCollection',
      features: (countiesRaw.features || []).map(function (f) {
        return { type: 'Feature', properties: { name: (f.properties || {}).NAME || '' }, geometry: f.geometry };
      })
    };
    var counties = (countySearch && countySearch.counties) || {};
    Object.keys(counties).forEach(function (cname) {
      ((counties[cname] || {}).towns || []).forEach(function (t) {
        if (typeof t.lat !== 'number') return;
        var row = { name: t.name, county: cname, lat: t.lat, lng: t.lng, url: t.url };
        var m = MARKET[t.name];
        if (m && typeof m.medianList === 'number') { row.medianList = m.medianList; row.activeCount = m.activeCount; }
        DATA.towns.push(row);
      });
    });
    host.innerHTML = MARKUP;
    startMap(tok.token);
  });

  function startMap(token) {
    mapboxgl.accessToken = token;
    map = new mapboxgl.Map({
      container: $('xm-map'), style: DARK,
      center: HOME_VIEW.center, zoom: HOME_VIEW.zoom, pitch: 0, bearing: 0,
      attributionControl: true, cooperativeGestures: true
    });
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-right');

    // A rejected token or a URL restriction that doesn't cover this domain
    // fails as a silent black rectangle unless someone says so out loud.
    // 2026-08-20, Christine from her phone: "the map isnt showing" -- and
    // nothing on the page explained why. Now it does: the first auth-shaped
    // error tears the map down and names the two possible causes.
    var authFailed = false;
    map.on('error', function (e) {
      dbg('map error: ' + ((e && e.error && (e.error.message || e.error.status)) || 'unknown'));
      var msg = (e && e.error && (e.error.message || '')) + ' ' + (e && e.error && e.error.status || '');
      if (authFailed || !/401|403|Unauthorized|Forbidden|access token/i.test(msg)) return;
      authFailed = true;
      notice('The map key was rejected by Mapbox. Two possible causes: the token in ' +
        'MAPBOX_PUBLIC_TOKEN is no longer valid, or its URL restriction doesn’t ' +
        'include this exact domain (www counts as its own entry). ' +
        'Meanwhile, every community is covered in the ' +
        '<a href="/communities/index.html" style="color:#BA8C84">area guides</a>.');
    });
    map.on('load', function () { dbg('map loaded ✓'); });
    map.on('style.load', function () { dbg('style loaded ✓'); });

    map.on('style.load', addStyleLayers);
    map.on('load', function () {
      buildChips();
      buildRiverLabels();
      syncZoomClass();
      fetchLiveSpots();
      fetchMyListings();
    });
    map.on('zoom', syncZoomClass);
    ['dragstart', 'wheel'].forEach(function (ev) { map.on(ev, stopTour); });

    $('xm-pill').addEventListener('click', function () {
      var open = $('xm-panel').classList.toggle('open');
      $('xm-pill').setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    $('xm-3d').addEventListener('click', toggle3D);
    $('xm-sat').addEventListener('click', toggleSat);
    $('xm-mine').addEventListener('click', toggleMine);
    $('xm-sold-btn').addEventListener('click', toggleSold);
    $('xm-tour').addEventListener('click', function () { tour.on ? stopTour() : startTour(); });
    $('xm-reset').addEventListener('click', function () {
      stopTour();
      map.flyTo({ center: HOME_VIEW.center, zoom: HOME_VIEW.zoom, pitch: tiltOn ? 55 : 0, bearing: 0, duration: 2200 });
    });
    $('xm-share').addEventListener('click', copyViewLink);
    $('xm-full-btn').addEventListener('click', toggleFull);
    $('xm-draw').addEventListener('click', function () {
      if (draw.active) cancelDraw();
      else if (draw.done) clearArea();
      else startDraw();
    });
    $('xm-draw-finish').addEventListener('click', finishDraw);
    $('xm-draw-cancel').addEventListener('click', cancelDraw);
    setupAskBar();

    // Esc backs out of whatever is open — drawing, then the tour, then any
    // open card, then full-screen mode.
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (draw.active) { cancelDraw(); return; }
      if (tour.on) { stopTour(); return; }
      if (cardPop || hoverPop) { closeCard(); hideTip(); return; }
      if (host.classList.contains('xm-full')) toggleFull();
    });

    applyDeepLink();
  }

  /* App mode: the map takes the whole screen. On phones this is the
     difference between "a map on a page" and "the map" — and inside it the
     two-finger courtesy gesture is dropped, because a full-screen map IS the
     scroll surface. */
  function toggleFull() {
    var on = host.classList.toggle('xm-full');
    document.body.classList.toggle('xm-lock', on);
    var btn = $('xm-full-btn');
    btn.classList.toggle('on', on);
    var span = btn.querySelector('span');
    if (span) span.textContent = on ? 'Exit Full Screen' : 'Full Screen';
    try {
      if (map.cooperativeGestures && map.cooperativeGestures.disable) {
        on ? map.cooperativeGestures.disable() : map.cooperativeGestures.enable();
      }
    } catch (err) { /* older GL builds: gesture handler stays as configured */ }
    setTimeout(function () { map.resize(); }, 60);
  }

  /* Deep links: /explore.html?town=Erie&filter=eat&ask=... — the URLs that
     go in YouTube descriptions and texts to buyers, opening the map already
     flown and filtered. `view=lng,lat,zoom` restores a copied view. */
  function applyDeepLink() {
    var p = new URLSearchParams(location.search);
    var view = (p.get('view') || '').split(',').map(parseFloat);
    if (view.length === 3 && view.every(isFinite)) {
      map.jumpTo({ center: [view[0], view[1]], zoom: view[2] });
    }
    var townName = (p.get('town') || '').toLowerCase();
    if (townName) {
      var t = townCenter(townName);
      if (t) map.flyTo({ center: [t.lng, t.lat], zoom: 12.2, duration: 2600 });
    }
    var filter = (p.get('filter') || '').toLowerCase();
    if (FILTER_GROUPS.some(function (g) { return g.key === filter && filter; })) {
      // Chips exist after buildChips(), which ran before this.
      Array.prototype.forEach.call($('xm-chips').querySelectorAll('.chip'), function (c) {
        var g = FILTER_GROUPS.filter(function (x) { return x.label === c.textContent; })[0];
        c.classList.toggle('on', !!g && g.key === filter);
      });
      host.classList.add('only-' + filter);
    }
    var ask = p.get('ask');
    if (ask) {
      $('xm-ask').value = ask;
      // Let the town/spot data land first so the answer is complete.
      setTimeout(runAsk, 1200);
    }
  }

  function copyViewLink() {
    var c = map.getCenter();
    var url = location.origin + location.pathname +
      '?view=' + c.lng.toFixed(5) + ',' + c.lat.toFixed(5) + ',' + map.getZoom().toFixed(2);
    var done = function () { toast('Link copied — paste it in a text or a video description.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { window.prompt('Copy this link:', url); });
    } else {
      window.prompt('Copy this link:', url);
    }
  }

  function syncZoomClass() {
    host.classList.toggle('zoomed-thumbs', map.getZoom() >= ZOOM_THUMBS);
  }

  var toastTimer = null;
  function toast(msg, ms) {
    var el = $('xm-toast');
    el.textContent = msg;
    el.classList.add('open');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('open'); }, ms || 5000);
  }

  /* ---------------- layers ---------------- */
  function addStyleLayers() {
    if (!map.getSource('dem')) {
      map.addSource('dem', { type: 'raster-dem', url: 'mapbox://mapbox.mapbox-terrain-dem-v1', tileSize: 512, maxzoom: 14 });
    }
    if (!map.getLayer('spc-hillshade')) {
      map.addLayer({
        id: 'spc-hillshade', type: 'hillshade', source: 'dem',
        paint: { 'hillshade-exaggeration': satOn ? 0.15 : 0.32, 'hillshade-shadow-color': '#0a0a0b', 'hillshade-highlight-color': '#3a3a3e', 'hillshade-accent-color': '#141415' }
      });
    }
    if (tiltOn) map.setTerrain({ source: 'dem', exaggeration: 1.5 });
    map.setFog({ range: [0.6, 9], color: satOn ? '#20242c' : '#17171a', 'high-color': '#22303c', 'horizon-blend': 0.06, 'star-intensity': 0.12 });

    if (!map.getLayer('spc-3d-buildings') && map.getSource('composite')) {
      map.addLayer({
        id: 'spc-3d-buildings', type: 'fill-extrusion', source: 'composite',
        'source-layer': 'building', minzoom: 13.2,
        filter: ['==', ['get', 'extrude'], 'true'],
        paint: {
          'fill-extrusion-color': satOn ? '#8a8a8e' : '#3a3a40',
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13.2, 0, 14.2, ['get', 'height']],
          'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 13.2, 0, 14.2, ['get', 'min_height']],
          'fill-extrusion-opacity': 0.72
        }
      });
    }

    if (!map.getSource('counties')) {
      map.addSource('counties', { type: 'geojson', data: DATA.counties, generateId: true });
    }
    if (!map.getLayer('county-fill')) {
      map.addLayer({
        id: 'county-fill', type: 'fill', source: 'counties',
        paint: {
          'fill-color': '#B86F7A',
          'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.16, 0.05]
        }
      });
      map.addLayer({
        id: 'county-line', type: 'line', source: 'counties',
        paint: { 'line-color': '#F8F6F4', 'line-width': 1.1, 'line-opacity': 0.55 }
      });
      map.addLayer({
        id: 'county-label', type: 'symbol', source: 'counties',
        layout: {
          'text-field': ['upcase', ['get', 'name']],
          'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
          'text-size': 13, 'text-letter-spacing': 0.22
        },
        paint: { 'text-color': '#F8F6F4', 'text-opacity': 0.75, 'text-halo-color': 'rgba(0,0,0,.7)', 'text-halo-width': 1.2 },
        maxzoom: 10
      });
    }

    if (!map.getSource('draw-poly')) {
      map.addSource('draw-poly', { type: 'geojson', data: drawFeature() });
    }
    if (!map.getLayer('draw-fill')) {
      map.addLayer({ id: 'draw-fill', type: 'fill', source: 'draw-poly', paint: { 'fill-color': '#B86F7A', 'fill-opacity': 0.14 } });
      map.addLayer({ id: 'draw-line', type: 'line', source: 'draw-poly', paint: { 'line-color': '#F8F6F4', 'line-width': 2, 'line-dasharray': [2, 1.5] } });
    }
    if (!map.getSource('iso')) {
      map.addSource('iso', { type: 'geojson', data: isoFeature() });
    }
    if (!map.getLayer('iso-fill')) {
      map.addLayer({ id: 'iso-fill', type: 'fill', source: 'iso', paint: { 'fill-color': '#7FA9BA', 'fill-opacity': 0.16 } });
      map.addLayer({ id: 'iso-line', type: 'line', source: 'iso', paint: { 'line-color': '#7FA9BA', 'line-width': 2, 'line-opacity': 0.85 } });
    }

    if (!map.getSource('towns')) {
      map.addSource('towns', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: DATA.towns.map(function (t) {
            return {
              type: 'Feature',
              properties: {
                name: t.name, county: t.county, url: t.url,
                medianList: t.medianList || 0, activeCount: t.activeCount || 0,
                priceLabel: t.medianList ? fmtPrice(t.medianList) : ''
              },
              geometry: { type: 'Point', coordinates: [t.lng, t.lat] }
            };
          })
        }
      });
    }
    if (!map.getLayer('town-dot')) {
      map.addLayer({
        id: 'town-dot', type: 'circle', source: 'towns',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 2.5, 11, 5],
          'circle-color': '#F8F6F4', 'circle-opacity': 0.9,
          'circle-stroke-color': '#B86F7A', 'circle-stroke-width': 1.5
        }
      });
      map.addLayer({
        id: 'town-name', type: 'symbol', source: 'towns',
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['DIN Pro Regular', 'Arial Unicode MS Regular'],
          'text-size': 11.5, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-letter-spacing': 0.04
        },
        paint: { 'text-color': '#F8F6F4', 'text-opacity': 0.85, 'text-halo-color': 'rgba(0,0,0,.8)', 'text-halo-width': 1.2 },
        minzoom: 8.4
      });
      map.addLayer({
        id: 'town-price', type: 'symbol', source: 'towns',
        filter: ['!=', ['get', 'priceLabel'], ''],
        layout: {
          'text-field': ['get', 'priceLabel'],
          'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
          'text-size': 10.5, 'text-offset': [0, 2.3], 'text-anchor': 'top', 'text-letter-spacing': 0.06
        },
        paint: { 'text-color': '#BA8C84', 'text-halo-color': 'rgba(0,0,0,.85)', 'text-halo-width': 1.2 },
        minzoom: 9
      });
    }
    bindLayerEvents();
  }

  function bindLayerEvents() {
    if (layerEventsBound) return;
    layerEventsBound = true;
    map.on('click', function (e) {
      if (!draw.active) return;
      draw.pts.push([e.lngLat.lng, e.lngLat.lat]);
      syncDraw();
    });
    map.on('dblclick', function (e) {
      if (!draw.active) return;
      e.preventDefault();
      finishDraw();
    });
    map.on('mousemove', 'county-fill', function (e) {
      map.getCanvas().style.cursor = 'pointer';
      if (!e.features.length) return;
      if (hoveredCounty !== null) map.setFeatureState({ source: 'counties', id: hoveredCounty }, { hover: false });
      hoveredCounty = e.features[0].id;
      map.setFeatureState({ source: 'counties', id: hoveredCounty }, { hover: true });
    });
    map.on('mouseleave', 'county-fill', function () {
      map.getCanvas().style.cursor = '';
      if (hoveredCounty !== null) map.setFeatureState({ source: 'counties', id: hoveredCounty }, { hover: false });
      hoveredCounty = null;
    });
    map.on('click', 'county-fill', function (e) {
      if (!e.features.length || tour.on || draw.active) return;
      var b = geomBounds(e.features[0].geometry);
      if (b) map.fitBounds(b, { padding: 70, pitch: tiltOn ? 55 : 0, duration: 1800 });
    });
    map.on('mouseenter', 'town-dot', function () { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'town-dot', function () { map.getCanvas().style.cursor = ''; });
    map.on('click', 'town-dot', function (e) {
      if (!e.features.length || draw.active) return;
      var p = e.features[0].properties;
      var coords = e.features[0].geometry.coordinates;
      closeCard();
      var market = '';
      if (p.medianList && Number(p.medianList) > 0) {
        market = '<p class="spc-town-market">Median asking <b>' + fmtPrice(Number(p.medianList)) + '</b>' +
          (Number(p.activeCount) > 0 ? ' · <b>' + esc(p.activeCount) + '</b> active listings' : '') + '</p>';
      }
      cardPop = new mapboxgl.Popup({ className: 'spc-town', offset: 12 })
        .setLngLat(coords)
        .setHTML(
          '<p class="spc-town-name">' + esc(p.name) + '</p>' +
          '<p class="spc-town-county">' + esc(p.county) + ' County</p>' +
          market +
          '<div class="spc-town-links">' +
            '<a class="dark" href="/search-homes.html?city=' + encodeURIComponent(p.name) + '&minPrice=950000">See Homes</a>' +
            '<a class="line" href="' + esc(p.url) + '">Town Guide</a>' +
            '<button data-iso-lng="' + coords[0] + '" data-iso-lat="' + coords[1] + '" data-iso-label="' + esc(p.name) + '">15 Min</button>' +
          '</div>')
        .addTo(map);
      wireCardActions(cardPop);
    });
  }

  function geomBounds(geom) {
    var b = null;
    function extend(c) { if (!b) b = new mapboxgl.LngLatBounds(c, c); else b.extend(c); }
    function walk(coords) {
      if (typeof coords[0] === 'number') { extend(coords); return; }
      coords.forEach(walk);
    }
    if (geom && geom.coordinates) walk(geom.coordinates);
    return b;
  }

  /* ---------------- spots ---------------- */
  function townCenter(name) {
    var k = String(name || '').toLowerCase();
    for (var i = 0; i < DATA.towns.length; i++) {
      if (DATA.towns[i].name.toLowerCase() === k) return DATA.towns[i];
    }
    return null;
  }

  function makeNudger() {
    var used = {};
    return function (lat, lng) {
      var key = lat.toFixed(4) + ',' + lng.toFixed(4);
      var n = used[key] || 0;
      used[key] = n + 1;
      if (!n) return [lng, lat];
      var a = (n - 1) * (Math.PI * 2 / 6);
      return [lng + Math.sin(a) * 0.00029, lat + Math.cos(a) * 0.00022];
    };
  }

  function resolveSpots(rawSpots) {
    var nudge = makeNudger();
    spots = [];
    rawSpots.forEach(function (s) {
      var lat = s.lat, lng = s.lng, approx = false;
      if (typeof lat !== 'number' || typeof lng !== 'number') {
        var tc = townCenter(s.searchCity || s.city);
        if (!tc) return;
        lat = tc.lat; lng = tc.lng; approx = true;
      }
      var pos = nudge(lat, lng);
      spots.push(Object.assign({}, s, { _lnglat: pos, _approx: approx }));
    });
  }

  function spotCategory(s) {
    return String(s.category || 'spot').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }

  function buildMarkers() {
    markers.forEach(function (m) { m.remove(); });
    markers = [];
    spots.forEach(function (s) {
      var cat = spotCategory(s);
      var hasReview = !!(s.googleReviewUrl || s.reviewQuote);
      var el = document.createElement('div');
      el.className = 'spc-pin cat-' + cat + (s.videoId ? ' has-video' : '') + (s._approx ? ' approx' : '');
      var badge = s.videoId
        ? '<span class="spc-badge"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>'
        : hasReview
          ? '<span class="spc-badge star"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8Z"/></svg></span>'
          : '';
      var thumb = s.videoId
        ? '<span class="spc-thumb"><img src="https://i.ytimg.com/vi/' + encodeURIComponent(s.videoId) + '/mqdefault.jpg" alt="" loading="lazy"></span>'
        : '';
      el.innerHTML = '<div class="spc-pin-inner">' + (GLYPHS[cat] || GLYPHS.spot) + badge + '</div>' + thumb;
      var mk = new mapboxgl.Marker({ element: el, anchor: 'center' }).setLngLat(s._lnglat).addTo(map);
      el.addEventListener('mouseenter', function () { showTip(s); });
      el.addEventListener('mouseleave', hideTip);
      el.addEventListener('click', function (e) { e.stopPropagation(); hideTip(); openCard(s); });
      markers.push(mk);
    });
    updateStatus();
  }

  function showTip(s) {
    hideTip();
    var inner = s.videoId
      ? '<img class="spc-tip-img" src="https://i.ytimg.com/vi/' + encodeURIComponent(s.videoId) + '/mqdefault.jpg" alt="">' +
        '<span class="spc-tip-name">&#9654; ' + esc(s.name) + '</span>'
      : '<span class="spc-tip-name">&#9733; ' + esc(s.name) + '</span>';
    var sub = '<span class="spc-tip-sub">' + esc(s.city) + '</span>';
    hoverPop = new mapboxgl.Popup({ className: 'spc-tip', closeButton: false, closeOnClick: false, offset: 26 })
      .setLngLat(s._lnglat).setHTML(inner + sub).addTo(map);
  }
  function hideTip() { if (hoverPop) { hoverPop.remove(); hoverPop = null; } }
  function closeCard() { if (cardPop) { cardPop.remove(); cardPop = null; } }

  function openCard(s) {
    closeCard();
    var html = '';
    if (s.videoId) {
      html += '<div class="spc-card-video"><iframe src="https://www.youtube-nocookie.com/embed/' +
        encodeURIComponent(s.videoId) + '?rel=0" title="' + esc(s.videoTitle || s.name) +
        '" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>';
    }
    html += '<div class="spc-card-body"><h3>' + esc(s.name) + '</h3>' +
      '<p class="spc-card-city">' + esc(s.city) + '</p>';
    if (s.blurb) html += '<p class="blurb">' + esc(s.blurb) + '</p>';
    if (s.reviewQuote) html += '<blockquote>“' + esc(s.reviewQuote) + '”</blockquote>';
    var credit = s.videoSource ? 'Video: ' + s.videoSource
      : s.videoId ? 'Filmed by Christine — The Little Lady Sells Homes'
      : 'Reviewed by Christine — The Little Lady Sells Homes';
    html += '<p class="spc-card-credit">' + esc(credit) + '</p>';
    html += '<div class="spc-card-actions">';
    if (s.searchCity) html += '<a href="/search-homes.html?city=' + encodeURIComponent(s.searchCity) + '&minPrice=950000">Homes Near Here</a>';
    var g = s.googleReviewUrl || s.googlePostUrl;
    if (g) html += '<a href="' + esc(g) + '" target="_blank" rel="noopener">On Google</a>';
    if (s.cityHref) html += '<a href="' + esc(s.cityHref) + '">About ' + esc(s.city) + '</a>';
    if (!s._approx) {
      html += '<button data-iso-lng="' + s._lnglat[0] + '" data-iso-lat="' + s._lnglat[1] +
        '" data-iso-label="' + esc(s.name) + '">15 Min From Here</button>';
    }
    html += '</div></div>';
    cardPop = new mapboxgl.Popup({ className: 'spc-card', offset: 24, maxWidth: 'none' })
      .setLngLat(s._lnglat).setHTML(html).addTo(map);
    wireCardActions(cardPop);
  }

  function fetchLiveSpots() {
    fetch('/.netlify/functions/local-spots')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !Array.isArray(data.spots) || !data.spots.length) return;
        resolveSpots(data.spots);
        buildMarkers();
      })
      .catch(function () { updateStatus(); });
  }

  function updateStatus() {
    var el = $('xm-status');
    if (!el) return;
    el.innerHTML = spots.length
      ? '<span class="ok">&#10003;</span> ' + spots.length + ' local spots on the map.'
      : 'Local spots are loading…';
    $('xm-dot').classList.toggle('ok', spots.length > 0);
  }

  /* ---------------- her active listings ---------------- */
  function fmtPrice(p) {
    if (typeof p !== 'number') return 'For Sale';
    if (p >= 1e6) return '$' + (p / 1e6).toFixed(p % 1e6 >= 5e4 ? 2 : 1).replace(/\.?0+$/, '') + 'M';
    return '$' + Math.round(p / 1000) + 'K';
  }

  function fetchMyListings() {
    fetch('/.netlify/functions/my-listings-geo')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var pins = (data && data.pins) || [];
        if (!pins.length) return;
        myListings = pins.filter(function (p) { return typeof p.lat === 'number' && typeof p.lng === 'number'; });
        buildListingMarkers();
        $('xm-mine').classList.add('on');
        if (data.pending) setTimeout(fetchMyListings, 12000);
      })
      .catch(function () { /* toggle explains itself when clicked */ });
  }

  function buildListingMarkers() {
    listingMarkers.forEach(function (m) { m.remove(); });
    listingMarkers = [];
    myListings.forEach(function (p) {
      var el = document.createElement('div');
      var pending = /pending|contract/i.test(String(p.status || ''));
      el.className = 'spc-listing' + (pending ? ' pending' : '');
      el.textContent = fmtPrice(p.price) + (pending ? ' · Pending' : '');
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        if (draw.active) return;
        openListingCard(p);
      });
      listingMarkers.push(new mapboxgl.Marker({ element: el, anchor: 'center' }).setLngLat([p.lng, p.lat]).addTo(map));
    });
  }

  function openListingCard(p) {
    closeCard();
    var facts = [];
    if (p.beds != null) facts.push('<b>' + esc(p.beds) + '</b> bd');
    if (p.baths != null) facts.push('<b>' + esc(p.baths) + '</b> ba');
    if (p.sqft != null) facts.push('<b>' + Number(p.sqft).toLocaleString() + '</b> sqft');
    var html =
      '<img class="spc-card-photo" alt="" loading="lazy" src="/.netlify/functions/listing-photo?id=' +
        encodeURIComponent(p.listingId || '') + '&i=0" onerror="this.style.display=\'none\'">' +
      '<div class="spc-card-body">' +
        '<h3>' + esc(fmtPrice(p.price)) + '</h3>' +
        '<p class="spc-card-city">' + esc(p.address || '') + ' · ' + esc(p.city || '') +
          (p.status ? ' · ' + esc(p.status) : '') + '</p>' +
        (facts.length ? '<p class="spc-card-facts">' + facts.join(' &nbsp;·&nbsp; ') + '</p>' : '') +
        '<p class="spc-card-credit">Listed by Christine — The Little Lady Sells Homes</p>' +
        '<div class="spc-card-actions">' +
          (p.url ? '<a href="' + esc(p.url) + '">View This Home</a>' : '') +
          '<a href="https://www.google.com/maps/@' + p.lat + ',' + p.lng +
            ',120a,60y,45t/data=!3m1!1e3" target="_blank" rel="noopener">Bird&#8217;s-Eye 3D</a>' +
          '<button data-iso-lng="' + p.lng + '" data-iso-lat="' + p.lat +
            '" data-iso-label="' + esc(p.address || 'this home') + '">15 Min From Here</button>' +
        '</div>' +
      '</div>';
    cardPop = new mapboxgl.Popup({ className: 'spc-card', offset: 18, maxWidth: 'none' })
      .setLngLat([p.lng, p.lat]).setHTML(html).addTo(map);
    wireCardActions(cardPop);
  }

  function toggleMine() {
    if (!myListings.length) {
      toast('My listings are still loading — one moment.');
      fetchMyListings();
      return;
    }
    var hidden = host.classList.toggle('hide-listings');
    $('xm-mine').classList.toggle('on', !hidden);
  }

  /* ---------------- sold homes ---------------- */
  function toggleSold() {
    var btn = $('xm-sold-btn');
    if (soldState === 'on') {
      soldState = 'off';
      btn.classList.remove('on');
      host.classList.add('hide-sold');
      return;
    }
    if (soldState === 'off' && soldMarkers.length) {
      soldState = 'on';
      btn.classList.add('on');
      host.classList.remove('hide-sold');
      return;
    }
    if (soldState === 'loading') return;
    soldState = 'loading';
    fetch('/.netlify/functions/sold-homes-geocode')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var pins = (data && data.pins) || [];
        if (!pins.length) throw new Error('no pins');
        pins.forEach(function (p) {
          if (typeof p.lat !== 'number' || typeof p.lng !== 'number') return;
          var el = document.createElement('div');
          el.className = 'spc-sold';
          el.title = p.address + (p.year ? ' · Sold ' + p.year : '');
          el.addEventListener('click', function (e) {
            e.stopPropagation();
            closeCard();
            var html = '<div class="spc-card-body"><h3>' + esc(p.address) + '</h3>' +
              '<p class="spc-card-city">' + esc(p.city || '') + (p.year ? ' · Sold ' + esc(p.year) : '') + '</p></div>';
            if (p.videoId) {
              html = '<div class="spc-card-video"><iframe src="https://www.youtube-nocookie.com/embed/' +
                encodeURIComponent(p.videoId) + '?rel=0" title="' + esc(p.title || p.address) +
                '" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>' +
                '<div class="spc-card-body"><h3>' + esc(p.address) + '</h3>' +
                '<p class="spc-card-city">' + esc(p.city || '') + (p.year ? ' · Sold ' + esc(p.year) : '') + '</p>' +
                '<p class="spc-card-credit">Tour filmed by Christine — The Little Lady Sells Homes</p></div>';
            }
            cardPop = new mapboxgl.Popup({ className: 'spc-card', offset: 14, maxWidth: 'none' })
              .setLngLat([p.lng, p.lat]).setHTML(html).addTo(map);
          });
          soldMarkers.push(new mapboxgl.Marker({ element: el, anchor: 'center' }).setLngLat([p.lng, p.lat]).addTo(map));
          soldPins.push(p);
        });
        soldState = 'on';
        $('xm-sold-btn').classList.add('on');
        host.classList.remove('hide-sold');
        if (data.pending) toast('A few sold homes are still being located — toggle again in a minute for the rest.');
      })
      .catch(function () {
        soldState = 'off';
        toast('The sold-homes layer couldn’t load — try again in a moment.');
      });
  }

  /* ---------------- draw-an-area search ---------------- */
  function drawFeature() {
    var pts = draw.pts;
    var geom = pts.length >= 3
      ? { type: 'Polygon', coordinates: [pts.concat([pts[0]])] }
      : { type: 'LineString', coordinates: pts };
    return { type: 'Feature', properties: {}, geometry: pts.length ? geom : { type: 'LineString', coordinates: [] } };
  }

  function syncDraw() {
    var src = map.getSource('draw-poly');
    if (src) src.setData(drawFeature());
  }

  function setDrawLabel(text) {
    var span = $('xm-draw').querySelector('span');
    if (span) span.textContent = text;
  }

  function startDraw() {
    stopTour(); closeCard(); hideTip();
    draw.active = true; draw.done = false; draw.pts = [];
    syncDraw();
    host.classList.add('drawing');
    $('xm-draw-hint').classList.add('open');
    $('xm-results').classList.remove('open');
    $('xm-draw').classList.add('on');
    setDrawLabel('Cancel Drawing');
    map.doubleClickZoom.disable();
  }

  function cancelDraw() { endDrawMode(); clearArea(); }

  function endDrawMode() {
    draw.active = false;
    host.classList.remove('drawing');
    $('xm-draw-hint').classList.remove('open');
    map.doubleClickZoom.enable();
  }

  function clearArea() {
    draw.pts = []; draw.done = false;
    syncDraw();
    $('xm-results').classList.remove('open');
    $('xm-draw').classList.remove('on');
    setDrawLabel('Draw Search Area');
  }

  function finishDraw() {
    if (draw.pts.length < 3) { toast('Click at least three points to outline an area.'); return; }
    endDrawMode();
    draw.done = true;
    syncDraw();
    setDrawLabel('Clear Area');
    renderInsideCard('In Your Area', analyzeArea(draw.pts), clearArea);
  }

  function pointInPoly(lng, lat, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function analyzeArea(ring) {
    var inPoly = function (lng, lat) { return pointInPoly(lng, lat, ring); };
    return {
      listings: myListings.filter(function (p) { return inPoly(p.lng, p.lat); }),
      spots: spots.filter(function (s) { return inPoly(s._lnglat[0], s._lnglat[1]); }),
      sold: soldPins.filter(function (p) { return inPoly(p.lng, p.lat); }),
      towns: DATA.towns.filter(function (t) { return inPoly(t.lng, t.lat); })
    };
  }

  function renderInsideCard(title, r, onClear) {
    var el = $('xm-results');
    var html = '<h3>' + esc(title) + '</h3>';
    if (r.listings.length) {
      html += '<p class="dr-line"><b>' + r.listings.length + '</b> of my listings:</p>';
      r.listings.forEach(function (p) {
        html += '<a class="dr-listing" href="' + esc(p.url || '#') + '">' +
          esc(fmtPrice(p.price)) + ' — ' + esc(p.address || '') + ', ' + esc(p.city || '') + '</a>';
      });
    } else {
      html += '<p class="dr-line">None of my listings are inside this outline right now.</p>';
    }
    html += '<p class="dr-line"><b>' + r.spots.length + '</b> of my local spots · <b>' +
      (soldPins.length ? r.sold.length : '—') + '</b> homes I’ve sold' +
      (soldPins.length ? '' : ' <i>(turn on the sold layer to count them)</i>') + '</p>';
    html += '<div class="dr-actions">';
    if (r.towns.length) {
      var names = r.towns.map(function (t) { return t.name; });
      var q = names.length === 1 ? 'city=' + encodeURIComponent(names[0])
                                 : 'cities=' + encodeURIComponent(names.join(','));
      html += '<a href="/search-homes.html?' + q + '&minPrice=950000">Search MLS Homes Here</a>';
    } else {
      html += '<p class="dr-line" style="width:100%"><i>Stretch the outline over a town to search MLS homes in it.</i></p>';
    }
    html += '<button id="xm-dr-clear">Clear</button></div>' +
      // The lead net. Every portal map converts attention into contacts;
      // this one converts it into a conversation with the person who
      // actually filmed the places on it.
      '<div class="dr-actions" style="margin-top:8px"><a href="/contact.html" style="width:100%;text-align:center">Ask Christine About This Area</a></div>';
    el.innerHTML = html;
    el.classList.add('open');
    el.querySelector('#xm-dr-clear').addEventListener('click', onClear);
  }

  /* ---------------- isochrone ---------------- */
  function isoFeature() {
    return iso.feature || { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } };
  }

  function syncIso() {
    var src = map.getSource('iso');
    if (src) src.setData(isoFeature());
  }

  function openIso(lng, lat, label) {
    closeCard();
    toast('Tracing a 15-minute drive from ' + label + '…', 3000);
    fetch('https://api.mapbox.com/isochrone/v1/mapbox/driving/' + lng + ',' + lat +
      '?contours_minutes=15&polygons=true&denoise=1&access_token=' + encodeURIComponent(mapboxgl.accessToken))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var f = data && data.features && data.features[0];
        if (!f || !f.geometry || !f.geometry.coordinates || !f.geometry.coordinates[0]) {
          throw new Error('no isochrone');
        }
        iso.feature = f; iso.label = label;
        syncIso();
        var ring = f.geometry.coordinates[0];
        var b = null;
        ring.forEach(function (c) { b = b ? b.extend(c) : new mapboxgl.LngLatBounds(c, c); });
        map.fitBounds(b, { padding: 80, duration: 1800 });
        renderInsideCard('Within a 15-minute drive of ' + label, analyzeArea(ring), clearIso);
      })
      .catch(function () {
        toast('Couldn’t trace the drive-time area — try again in a moment.');
      });
  }

  function clearIso() {
    iso.feature = null; iso.label = '';
    syncIso();
    $('xm-results').classList.remove('open');
  }

  function wireCardActions(pop) {
    var root = pop.getElement();
    if (!root) return;
    Array.prototype.forEach.call(root.querySelectorAll('[data-iso-lng]'), function (btn) {
      btn.addEventListener('click', function () {
        openIso(parseFloat(btn.dataset.isoLng), parseFloat(btn.dataset.isoLat), btn.dataset.isoLabel || 'here');
      });
    });
  }

  /* ---------------- Ask the Map ---------------- */
  function parsePrice(text, patterns) {
    for (var i = 0; i < patterns.length; i++) {
      var m = text.match(patterns[i]);
      if (m) {
        var n = parseFloat(m[1].replace(/,/g, ''));
        var unit = (m[2] || '').toLowerCase();
        if (unit.indexOf('m') === 0) n *= 1e6;
        else if (unit.indexOf('k') === 0 || unit.indexOf('thousand') === 0) n *= 1e3;
        else if (n < 10) n *= 1e6;
        else if (n < 10000) n *= 1e3;
        return Math.round(n);
      }
    }
    return null;
  }

  function parseAsk(raw) {
    var text = String(raw || '').toLowerCase();
    var town = null;
    DATA.towns.forEach(function (t) {
      if (text.indexOf(t.name.toLowerCase()) !== -1 && (!town || t.name.length > town.name.length)) town = t;
    });
    var maxPrice = parsePrice(text, [
      /(?:under|below|less than|up to|max(?:imum)?(?: of)?)\s*\$?\s*([\d.,]+)\s*(k|m|million|thousand)?/,
      /\$\s*([\d.,]+)\s*(k|m|million|thousand)?\s*(?:or less|and under|max)/
    ]);
    var minPrice = parsePrice(text, [
      /(?:over|above|at least|starting at|minimum(?: of)?)\s*\$?\s*([\d.,]+)\s*(k|m|million|thousand)?/
    ]);
    var groups = ASK_GROUPS.filter(function (g) { return g.words.test(text); });
    return { town: town, maxPrice: maxPrice, minPrice: minPrice, groups: groups, raw: raw };
  }

  function runAsk() {
    var raw = $('xm-ask').value.trim();
    if (!raw) return;
    var q = parseAsk(raw);
    var el = $('xm-results');
    var html = '<h3>Here’s what I can show you</h3>';

    if (q.town) {
      map.flyTo({ center: [q.town.lng, q.town.lat], zoom: 12.2, pitch: tiltOn ? 55 : 0, duration: 2600 });
      html += '<p class="dr-line">Flying to <b>' + esc(q.town.name) + '</b>' +
        (q.town.medianList ? ' — median asking ' + esc(fmtPrice(q.town.medianList)) : '') + '.</p>';
    } else {
      html += '<p class="dr-line">I didn’t catch a town name — I know the ' + DATA.towns.length + ' towns on this map.</p>';
    }

    if (q.groups.length) {
      var chipsHost = $('xm-chips');
      ASK_GROUPS.forEach(function (g) { host.classList.remove('only-' + g.key); });
      Array.prototype.forEach.call(chipsHost.querySelectorAll('.chip'), function (c) {
        c.classList.toggle('on', c.textContent === q.groups[0].chip);
      });
      host.classList.add('only-' + q.groups[0].key);
      html += '<p class="dr-line">Showing my <b>' + esc(q.groups[0].chip) + '</b> spots' +
        (q.groups.length > 1 ? ' (start there — you also mentioned ' + esc(q.groups[1].chip.toLowerCase()) + ')' : '') + '.</p>';
    }

    var params = [];
    if (q.town) params.push('city=' + encodeURIComponent(q.town.name));
    if (q.maxPrice) { params.push('maxPrice=' + q.maxPrice); params.push('minPrice=350000'); params.push('noFloor=true'); }
    else if (q.minPrice) {
      params.push('minPrice=' + q.minPrice);
      if (q.minPrice < 950000) params.push('noFloor=true');
    } else params.push('minPrice=950000');
    var priceWords = q.maxPrice ? ' under ' + fmtPrice(q.maxPrice)
      : q.minPrice ? ' over ' + fmtPrice(q.minPrice) : '';
    html += '<div class="dr-actions">' +
      '<a href="/search-homes.html?' + params.join('&') + '">Homes' +
      (q.town ? ' in ' + esc(q.town.name) : '') + esc(priceWords) + '</a>';
    if (q.town) {
      html += '<a href="' + esc(q.town.url) + '">Walkability &amp; What’s Near ' + esc(q.town.name) + '</a>';
    }
    html += '<button id="xm-dr-clear">Close</button></div>';
    el.innerHTML = html;
    el.classList.add('open');
    el.querySelector('#xm-dr-clear').addEventListener('click', function () { el.classList.remove('open'); });
  }

  function setupAskBar() {
    var input = $('xm-ask');
    var mic = $('xm-mic');
    $('xm-go').addEventListener('click', runAsk);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') runAsk(); });

    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { mic.style.display = 'none'; return; }
    var rec = null;
    mic.addEventListener('click', function () {
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.lang = 'en-US';
      rec.interimResults = false;
      mic.classList.add('listening');
      rec.onresult = function (e) {
        var said = e.results[0] && e.results[0][0] && e.results[0][0].transcript;
        if (said) { input.value = said; runAsk(); }
      };
      rec.onend = function () { mic.classList.remove('listening'); rec = null; };
      rec.onerror = function () { mic.classList.remove('listening'); rec = null; };
      rec.start();
    });
  }

  /* ---------------- chips / rivers / 3D / satellite / tour ---------------- */
  function buildChips() {
    var chipsHost = $('xm-chips');
    chipsHost.innerHTML = '';
    FILTER_GROUPS.forEach(function (g, i) {
      var b = document.createElement('button');
      b.className = 'chip' + (i === 0 ? ' on' : '');
      b.textContent = g.label;
      b.addEventListener('click', function () {
        chipsHost.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('on'); });
        b.classList.add('on');
        FILTER_GROUPS.forEach(function (x) { if (x.key) host.classList.remove('only-' + x.key); });
        if (g.key) host.classList.add('only-' + g.key);
      });
      chipsHost.appendChild(b);
    });
  }

  function buildRiverLabels() {
    RIVERS.forEach(function (r) {
      var el = document.createElement('div');
      el.className = 'river-label';
      el.style.transform = 'rotate(' + r.rotate + 'deg)';
      el.textContent = r.name;
      new mapboxgl.Marker({ element: el, anchor: 'center' }).setLngLat(r.at).addTo(map);
    });
  }

  function toggle3D() {
    tiltOn = !tiltOn;
    $('xm-3d').classList.toggle('on', tiltOn);
    if (tiltOn) {
      map.setTerrain({ source: 'dem', exaggeration: 1.5 });
      map.easeTo({ pitch: 58, duration: 1400 });
    } else {
      map.easeTo({ pitch: 0, bearing: 0, duration: 1200 });
      setTimeout(function () { if (!tiltOn) map.setTerrain(null); }, 1300);
    }
  }

  function toggleSat() {
    satOn = !satOn;
    $('xm-sat').classList.toggle('on', satOn);
    map.setStyle(satOn ? SAT : DARK); // style.load handler re-adds everything
  }

  function tourStops() {
    var byName = {};
    spots.forEach(function (s) { byName[s.name] = s; });
    return TOUR_NAMES.map(function (n) { return byName[n]; }).filter(Boolean);
  }

  function startTour() {
    var stops = tourStops();
    if (!stops.length) { toast('The tour starts once the spots finish loading.'); return; }
    tour.on = true; tour.i = 0;
    $('xm-tour').classList.add('on');
    $('xm-tour').querySelector('span').textContent = 'Stop Tour';
    closeCard(); hideTip();
    if (!tiltOn) toggle3D();
    flyStop(stops);
  }

  function flyStop(stops) {
    if (!tour.on) return;
    var s = stops[tour.i];
    $('xm-tour-n').textContent = 'Stop ' + (tour.i + 1) + ' of ' + stops.length;
    $('xm-tour-name').textContent = s.name;
    $('xm-tour-blurb').textContent = s.blurb || '';
    $('xm-tour-card').classList.add('open');
    map.flyTo({
      center: s._lnglat, zoom: s._approx ? 12.3 : 14.1,
      pitch: 58, bearing: (tour.i % 2 ? 35 : -35),
      duration: 6000, curve: 1.5, essential: true
    });
    tour.timer = setTimeout(function () {
      tour.i += 1;
      if (tour.i >= stops.length) {
        stopTour();
        map.flyTo({ center: HOME_VIEW.center, zoom: HOME_VIEW.zoom, pitch: 55, duration: 4000 });
      } else flyStop(stops);
    }, 9200);
  }

  function stopTour() {
    if (!tour.on) return;
    tour.on = false;
    clearTimeout(tour.timer);
    $('xm-tour-card').classList.remove('open');
    $('xm-tour').classList.remove('on');
    $('xm-tour').querySelector('span').textContent = 'Fly the Tour';
  }
})();
