// @ts-nocheck
"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import * as turf from "@turf/turf";
import "maplibre-gl/dist/maplibre-gl.css";

/* ---------- Base map (no keys) ---------- */
const BASE_STYLE = {
  version: 8,
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  sources: {
    osm: {
      type: "raster",
      tiles: [
        "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
        "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
        "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
      ],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
    sat: {
      type: "raster",
      tiles: [
        "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      attribution:
        "Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    },
    parcels: {
      type: "raster",
      tiles: [
        "https://tiles.arcgis.com/tiles/KzeiCaQsMoeCfoCq/arcgis/rest/services/Regrid_Nationwide_Parcel_Boundaries_v1/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      attribution: "Parcel boundaries © Regrid via Esri Living Atlas",
    },
  },
  layers: [
    { id: "osm", type: "raster", source: "osm", layout: { visibility: "visible" } },
    { id: "sat", type: "raster", source: "sat", layout: { visibility: "none" } },
    { id: "parcels", type: "raster", source: "parcels", layout: { visibility: "visible" }, paint: { "raster-opacity": 0.9 } },
  ],
};

/* ---------- Elevation tiles (Terrarium encoding) ---------- */
const TERRARIUM_URL =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

/* ---------- Colormap & alpha ---------- */
const ALPHA_THRESHOLD = 0.35; // hide weak pixels so map doesn’t wash out
function ramp(v) {
  const t = Math.max(0, Math.min(1, v));
  if (t < ALPHA_THRESHOLD) return [0, 0, 0, 0]; // transparent
  const c =
    t < 0.25 ? [0, 4 * t, 1] :
    t < 0.5  ? [0, 1, 1 - 4 * (t - 0.25)] :
    t < 0.75 ? [4 * (t - 0.5), 1, 0] :
               [1, 1 - 4 * (t - 0.75), 0];
  const a = Math.round(Math.pow((t - ALPHA_THRESHOLD) / (1 - ALPHA_THRESHOLD), 1.2) * 200) + 30;
  return [Math.round(c[0]*255), Math.round(c[1]*255), Math.round(c[2]*255), Math.min(a,255)];
}

/* ---------- Helpers: mercator math ---------- */
function lngLatToGlobalPixel(lon, lat, z) {
  const scale = 256 * Math.pow(2, z);
  const x = ((lon + 180) / 360) * scale;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return { x, y };
}
function globalPixelToLngLat(x, y, z) {
  const scale = 256 * Math.pow(2, z);
  const lon = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lng: lon, lat };
}
const tx = (lon, Z) => Math.floor(((lon + 180) / 360) * Math.pow(2, Z));
const ty = (lat, Z) => Math.floor(((1 - Math.log(Math.tan((lat*Math.PI)/180) + 1/Math.cos((lat*Math.PI)/180)) / Math.PI) / 2) * Math.pow(2, Z));

/* ========================================================= */

export default function Home() {
  const mapContainer = useRef(null);
  const mapRef = useRef(null);

  // UI state
  const [ready, setReady] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [pointsCount, setPointsCount] = useState(0);
  const [zoom, setZoom] = useState(11);
  const [basemap, setBasemap] = useState("streets"); // "streets" | "satellite"
  const [parcelsOn, setParcelsOn] = useState(true);
  const [parcelOpacity, setParcelOpacity] = useState(0.9);
  const [hasAOI, setHasAOI] = useState(false);
  const [hasHotspots, setHasHotspots] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [windDeg, setWindDeg] = useState(270);
  const [timeOfDay, setTimeOfDay] = useState("evening"); // "day" | "evening"
  const [scope, setScope] = useState("auto"); // "auto" | "aoi" | "viewport"

  // Development mask & hotspots UI
  const [excludeDev, setExcludeDev] = useState(true);
  const [devBuffer, setDevBuffer] = useState(80); // meters
  const [showHotspots, setShowHotspots] = useState(true);

  // Search UI
  const [searchQ, setSearchQ] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const searchAbort = useRef(null);
  const markerRef = useRef(null);

  // drawing (no plugin)
  const drawPts = useRef([]);
  const clickHandlerRef = useRef();
  const keyHandlerRef = useRef();

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: BASE_STYLE,
      center: [-84.324, 34.872],
      zoom: 11,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl(), "top-right");

    map.on("load", () => {
      map.addSource("aoi", { type: "geojson", data: emptyFC() });
      map.addSource("temp-line", { type: "geojson", data: emptyFC() });
      map.addSource("temp-points", { type: "geojson", data: emptyFC() });
      map.addSource("hotspots", { type: "geojson", data: emptyFC() });

      map.addLayer({ id: "aoi-fill", type: "fill", source: "aoi", paint: { "fill-color": "#3b82f6", "fill-opacity": 0.12 } });
      map.addLayer({ id: "aoi-stroke", type: "line", source: "aoi", paint: { "line-color": "#3b82f6", "line-width": 2 } });
      map.addLayer({ id: "temp-line-stroke", type: "line", source: "temp-line", paint: { "line-color": "#3b82f6", "line-width": 2 } });
      map.addLayer({ id: "temp-points-circles", type: "circle", source: "temp-points", paint: { "circle-color": "#3b82f6", "circle-radius": 4, "circle-stroke-color": "#fff", "circle-stroke-width": 1 } });
      map.addLayer({ id: "hotspots-layer", type: "circle", source: "hotspots", paint: { "circle-radius": 6, "circle-color": "#ef4444", "circle-stroke-color": "#000", "circle-stroke-width": 1 } });

      setReady(true);
    });

    map.on("zoom", () => setZoom(+map.getZoom().toFixed(1)));
    return () => map.remove();
  }, []);

  useEffect(() => {
    if (!ready || !mapRef.current) return;
    mapRef.current.setLayoutProperty("hotspots-layer", "visibility", showHotspots ? "visible" : "none");
  }, [ready, showHotspots]);

  /* ---------- helpers ---------- */
  function emptyFC() { return { type: "FeatureCollection", features: [] }; }
  function setAOI(poly) {
    (mapRef.current.getSource("aoi")).setData({ type: "FeatureCollection", features: [poly] });
    setHasAOI(true);
  }
  function updateTempLayers() {
    const map = mapRef.current;
    (map.getSource("temp-points")).setData({ type: "FeatureCollection", features: drawPts.current.map((p) => turf.point(p)) });
    (map.getSource("temp-line")).setData({ type: "FeatureCollection", features: drawPts.current.length > 1 ? [turf.lineString(drawPts.current)] : [] });
  }
  function clearTempLayers() {
    const map = mapRef.current;
    (map.getSource("temp-points")).setData(emptyFC());
    (map.getSource("temp-line")).setData(emptyFC());
  }
  function clearHotspots() {
    (mapRef.current.getSource("hotspots")).setData(emptyFC());
    setHasHotspots(false);
  }
  function getAOI() {
    const data = (mapRef.current.getSource("aoi"))._data;
    return data.features?.[0] || null;
  }

  /* ---------- drawing ---------- */
  function startDraw() {
    if (!ready) return;
    const map = mapRef.current;
    setAnalyzing(false);
    setIsDrawing(true);
    drawPts.current = [];
    setPointsCount(0);
    clearTempLayers();
    map.doubleClickZoom.disable();
    map.getCanvas().style.cursor = "crosshair";

    const onClick = (e) => {
      drawPts.current.push([e.lngLat.lng, e.lngLat.lat]);
      setPointsCount(drawPts.current.length);
      updateTempLayers();
    };
    map.on("click", onClick);
    clickHandlerRef.current = onClick;

    const onKey = (ev) => {
      if (ev.key === "Enter") finishDraw();
      if (ev.key === "Escape") clearAOI();
    };
    window.addEventListener("keydown", onKey);
    keyHandlerRef.current = onKey;
  }
  function finishDraw() {
    if (!ready) return;
    if (drawPts.current.length >= 3) {
      const ring = [...drawPts.current, drawPts.current[0]];
      const poly = turf.polygon([ring]);
      setAOI(poly);
    }
    stopDrawing();
  }
  function stopDrawing() {
    const map = mapRef.current;
    setIsDrawing(false);
    map.doubleClickZoom.enable();
    map.getCanvas().style.cursor = "";
    if (clickHandlerRef.current) map.off("click", clickHandlerRef.current);
    if (keyHandlerRef.current) window.removeEventListener("keydown", keyHandlerRef.current);
    clickHandlerRef.current = undefined;
    keyHandlerRef.current = undefined;
    drawPts.current = [];
    setPointsCount(0);
    clearTempLayers();
  }
  function clearAOI() {
    if (!ready) return;
    (mapRef.current.getSource("aoi")).setData(emptyFC());
    setHasAOI(false);
    stopDrawing();
    clearHotspots();
    removeHeatmap();
  }

  /* ---------- basemap/overlays ---------- */
  function toggleBasemap() {
    if (!ready) return;
    const map = mapRef.current;
    const toSat = basemap === "streets";
    map.setLayoutProperty("osm", "visibility", toSat ? "none" : "visible");
    map.setLayoutProperty("sat", "visibility", toSat ? "visible" : "none");
    setBasemap(toSat ? "satellite" : "streets");
  }
  function toggleParcels() {
    if (!ready) return;
    const map = mapRef.current;
    const toOn = map.getLayoutProperty("parcels", "visibility") !== "visible";
    map.setLayoutProperty("parcels", "visibility", toOn ? "visible" : "none");
    setParcelsOn(toOn);
    if (toOn && basemap === "satellite") {
      map.setLayoutProperty("sat", "visibility", "none");
      map.setLayoutProperty("osm", "visibility", "visible");
      setBasemap("streets");
    }
  }
  function setParcelsOpacity(val) {
    if (!ready) return;
    setParcelOpacity(val);
    mapRef.current.setPaintProperty("parcels", "raster-opacity", val);
  }

  /* ---------- SEARCH (Photon & coordinates) ---------- */
  function tryParseCoords(q) {
    const m = q.trim().match(/^(-?\d+(\.\d+)?)\s*[, ]\s*(-?\d+(\.\d+)?)/);
    if (!m) return null;
    const a = parseFloat(m[1]);
    const b = parseFloat(m[3]);
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lon: b };
    if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return { lat: b, lon: a };
    return null;
  }
  async function searchPhoton(q) {
    if (searchAbort.current) searchAbort.current.abort();
    const ac = new AbortController();
    searchAbort.current = ac;
    setSearchLoading(true);
    try {
      const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lang=en&limit=8`;
      const res = await fetch(url, { signal: ac.signal });
      const json = await res.json();
      const feats = (json.features || []);
      const list = feats.map((f) => {
        const p = f.properties || {};
        const name = [p.name, p.housenumber, p.street, p.city, p.state, p.country].filter(Boolean).join(", ");
        const extent = p.extent;
        return { name: name || p.osm_value || "Result", lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], extent };
      });
      setSuggestions(list);
    } catch (e) {
      if (e?.name !== "AbortError") setSuggestions([]);
    } finally {
      setSearchLoading(false);
    }
  }
  function applyResult(item) {
    const map = mapRef.current;
    if (markerRef.current) markerRef.current.remove();
    markerRef.current = new maplibregl.Marker({ color: "#2563eb" }).setLngLat([item.lon, item.lat]).addTo(map);
    if (item.extent) map.fitBounds([[item.extent[0], item.extent[1]], [item.extent[2], item.extent[3]]], { padding: 40, duration: 600 });
    else map.flyTo({ center: [item.lon, item.lat], zoom: 15, speed: 0.8 });
    setSuggestions([]);
  }
  function onSearchInput(q) {
    setSearchQ(q);
    const coords = tryParseCoords(q);
    if (coords) { applyResult({ lat: coords.lat, lon: coords.lon }); return; }
    if (q.trim().length < 3) { setSuggestions([]); return; }
    searchPhoton(q);
  }
  function onSearchEnter() {
    if (suggestions.length > 0) applyResult(suggestions[0]);
    else {
      const coords = tryParseCoords(searchQ);
      if (coords) applyResult({ lat: coords.lat, lon: coords.lon });
      else if (searchQ.trim().length >= 3) searchPhoton(searchQ);
    }
  }

  /* ---------- Overpass development mask (roads + buildings + residential landuse) ---------- */
  async function buildDevMaskCanvas(
    bbox, z, originX, originY, W, H, metersPerPixel, bufferM
  ) {
    try {
      const [w, s, e, n] = [bbox[0], bbox[1], bbox[2], bbox[3]];
      const q = `[out:json][timeout:25];
        (
          way["building"](${s},${w},${n},${e});
          relation["building"](${s},${w},${n},${e});

          way["landuse"]["landuse"~"residential|commercial|industrial|retail|parking"](${s},${w},${n},${e});
          relation["landuse"]["landuse"~"residential|commercial|industrial|retail|parking"](${s},${w},${n},${e});

          way["amenity"~"school|university|hospital|parking"](${s},${w},${n},${e});
          relation["amenity"~"school|university|hospital|parking"](${s},${w},${n},${e});

          way["leisure"~"pitch|golf_course"](${s},${w},${n},${e});
          relation["leisure"~"pitch|golf_course"](${s},${w},${n},${e});

          way["highway"]["highway"~"motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|track"](${s},${w},${n},${e});
        );
        out geom;`;
      const url = "https://overpass-api.de/api/interpreter?data=" + encodeURIComponent(q);
      const res = await fetch(url);
      const json = await res.json();

      const c = document.createElement("canvas");
      c.width = W; c.height = H;
      const ctx = c.getContext("2d");
      ctx.clearRect(0,0,W,H);

      const px = (lon, lat) => {
        const gp = lngLatToGlobalPixel(lon, lat, z);
        return { x: gp.x - originX, y: gp.y - originY };
      };

      const pxBuffer = Math.max(1, Math.round(bufferM / metersPerPixel));
      ctx.fillStyle = "rgba(255,255,255,1)";
      ctx.strokeStyle = "rgba(255,255,255,1)";
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      for (const el of (json.elements || [])) {
        if (!el.geometry) continue;
        const g = el.geometry;
        const tags = el.tags || {};
        const isRoad = !!tags.highway;
        const isPoly = !!tags.building || !!tags.landuse || !!tags.amenity || !!tags.leisure;

        if (isPoly) {
          ctx.beginPath();
          g.forEach((pt, i) => {
            const p = px(pt.lon, pt.lat);
            if (i===0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
          });
          ctx.closePath();
          ctx.fill();
          if (pxBuffer > 1) {
            ctx.lineWidth = pxBuffer * 2;
            ctx.stroke();
          }
        } else if (isRoad) {
          ctx.beginPath();
          g.forEach((pt, i) => {
            const p = px(pt.lon, pt.lat);
            if (i===0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
          });
          let w = pxBuffer;
          const hw = String(tags.highway);
          if (/motorway|trunk|primary/.test(hw)) w = Math.round(pxBuffer * 1.6);
          else if (/secondary|tertiary/.test(hw)) w = Math.round(pxBuffer * 1.3);
          else if (/residential|unclassified|service|track/.test(hw)) w = Math.round(pxBuffer * 1.1);
          ctx.lineWidth = Math.max(2, w);
          ctx.stroke();
        }
      }
      return c;
    } catch {
      return null; // Overpass failed; skip mask
    }
  }

  /* ---------- analysis (AOI or viewport) ---------- */
  async function analyzeTerrain() {
    if (!ready) return;
    setAnalyzing(true);
    clearHotspots();
    removeHeatmap();

    const map = mapRef.current;
    const aoi = getAOI();
    const useAOI = scope === "aoi" || (scope === "auto" && aoi);

    // pick area to analyze
    let bbox;
    if (useAOI && aoi) bbox = turf.bbox(aoi);
    else {
      const b = map.getBounds();
      bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    }

    // resolution
    const z = Math.max(12, Math.min(14, Math.floor(zoom)));

    // tiles covering bbox
    const minTX = tx(bbox[0], z), maxTX = tx(bbox[2], z);
    const minTY = ty(bbox[3], z), maxTY = ty(bbox[1], z);
    const tileSize = 256;
    const tilesX = maxTX - minTX + 1;
    const tilesY = maxTY - minTY + 1;

    // image georeference = exact tile envelope
    const tl = globalPixelToLngLat(minTX*tileSize,          minTY*tileSize,          z);
    const tr = globalPixelToLngLat((maxTX+1)*tileSize,      minTY*tileSize,          z);
    const br = globalPixelToLngLat((maxTX+1)*tileSize,      (maxTY+1)*tileSize,      z);
    const bl = globalPixelToLngLat(minTX*tileSize,          (maxTY+1)*tileSize,      z);
    const imgCoords = [
      [tl.lng, tl.lat],
      [tr.lng, tr.lat],
      [br.lng, br.lat],
      [bl.lng, bl.lat],
    ];

    // mosaic buffers
    const W = tilesX * tileSize, H = tilesY * tileSize;
    const originX = minTX * tileSize, originY = minTY * tileSize;
    const elev = new Float32Array(W * H);

    // load & decode Terrarium tiles
    async function loadTile(x, y) {
      const url = TERRARIUM_URL.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.referrerPolicy = "no-referrer";
      const done = new Promise((res, rej) => {
        img.onload = () => res(img);
        img.onerror = () => rej(new Error(`tile ${x}/${y} failed`));
      });
      img.src = url;
      try { await done; } catch { return null; }
      const c = document.createElement("canvas");
      c.width = tileSize; c.height = tileSize;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, tileSize, tileSize);
    }

    for (let tyI = 0; tyI < tilesY; tyI++) {
      for (let txI = 0; txI < tilesX; txI++) {
        const X = minTX + txI, Y = minTY + tyI;
        const data = await loadTile(X, Y);
        if (!data) continue;
        const offX = txI * tileSize, offY = tyI * tileSize;
        const arr = data.data;
        for (let j = 0, p = 0; j < tileSize; j++) {
          const row = (offY + j) * W + offX;
          for (let i = 0; i < tileSize; i++) {
            const R = arr[p], G = arr[p+1], B = arr[p+2];
            elev[row + i] = (R * 256 + G + B / 256) - 32768;
            p += 4;
          }
        }
      }
    }

    // meters per pixel
    const latMid = (bbox[1] + bbox[3]) / 2;
    const metersPerPixel = 156543.03392 * Math.cos(latMid * Math.PI/180) / Math.pow(2, z);

    // slope & aspect
    const slope = new Float32Array(W * H);
    const aspect = new Float32Array(W * H);
    for (let y = 1; y < H-1; y++) {
      for (let x = 1; x < W-1; x++) {
        const i = y*W + x;
        const dzdx = (elev[i+1] - elev[i-1]) / (2 * metersPerPixel);
        const dzdy = (elev[i+W] - elev[i-W]) / (2 * metersPerPixel);
        const s = Math.atan(Math.sqrt(dzdx*dzdx + dzdy*dzdy)) * 180/Math.PI;
        slope[i] = s;
        let a = Math.atan2(-dzdx, dzdy) * 180/Math.PI;
        if (a < 0) a += 360;
        aspect[i] = a;
      }
    }

    // TPI + aspect variance (9x9)
    const win = 4;
    const tpi = new Float32Array(W * H);
    const avar = new Float32Array(W * H);
    for (let y = win; y < H-win; y++) {
      for (let x = win; x < W-win; x++) {
        let sum = 0, count = 0, sumCos = 0, sumSin = 0;
        for (let yy = -win; yy <= win; yy++) {
          const row = (y+yy)*W;
          for (let xx = -win; xx <= win; xx++) {
            const idx = row + (x+xx);
            sum += elev[idx]; count++;
            const th = aspect[idx] * Math.PI/180;
            sumCos += Math.cos(th); sumSin += Math.sin(th);
          }
        }
        const idx0 = y*W + x;
        const mean = sum / count;
        tpi[idx0] = elev[idx0] - mean;
        const R = Math.sqrt(sumCos*sumCos + sumSin*sumSin) / count;
        avar[idx0] = 1 - R;
      }
    }

    // scoring
    const S = new Float32Array(W * H);
    const leeward = (windDeg + 180) % 360;
    const Wt = { bench: 1.2, saddle: 1.6, wind: 1.2, thermal: 1.0 };
    const sumW = Wt.bench + Wt.saddle + Wt.wind + Wt.thermal;
    for (let i = 0; i < W*H; i++) {
      const s = slope[i] || 0;
      let bench = 0; if (s >= 2 && s <= 12) bench = 1 - Math.abs(s - 6) / 10;
      const t = Math.abs(tpi[i] || 0);
      const tNorm = Math.max(0, 1 - (t / 12));
      const sad = Math.max(0, Math.min(1, tNorm * (avar[i] || 0)));
      const a = aspect[i] || 0;
      const diff = Math.abs(((a - leeward + 540) % 360) - 180);
      const wind = 1 - diff / 180;
      const thermal = (timeOfDay === "day") ? (1 + Math.cos((a - 180) * Math.PI/180)) / 2 : (1 + Math.cos(a * Math.PI/180)) / 2;
      S[i] = Math.max(0, Math.min(1, (Wt.bench*bench + Wt.saddle*sad + Wt.wind*wind + Wt.thermal*thermal) / sumW ));
    }

    // optional AOI mask
    if (useAOI && aoi) {
      const mask = document.createElement("canvas");
      mask.width = W; mask.height = H;
      const mctx = mask.getContext("2d");
      mctx.fillStyle = "#fff";
      mctx.beginPath();
      const ring = aoi.geometry.coordinates[0];
      ring.forEach(([lon, lat], idx) => {
        const gp = lngLatToGlobalPixel(lon, lat, z);
        const x = Math.round(gp.x - originX);
        const y = Math.round(gp.y - originY);
        if (idx === 0) mctx.moveTo(x, y); else mctx.lineTo(x, y);
      });
      mctx.closePath(); mctx.fill();
      const maskData = mctx.getImageData(0,0,W,H).data;
      for (let i=0, p=0; i<W*H; i++, p+=4) if (maskData[p+3] === 0) S[i] = 0;
    }

    // optional development mask
    if (excludeDev) {
      const devMask = await buildDevMaskCanvas(bbox, z, originX, originY, W, H, metersPerPixel, devBuffer);
      if (devMask) {
        const dctx = devMask.getContext("2d");
        const d = dctx.getImageData(0,0,W,H).data;
        for (let i=0, p=0; i<W*H; i++, p+=4) if (d[p+3] > 0) S[i] = 0;
      }
    }

    // draw heatmap pixels
    const heat = document.createElement("canvas");
    heat.width = W; heat.height = H;
    const hctx = heat.getContext("2d");
    const imgData = hctx.createImageData(W, H);
    for (let i = 0, k = 0; i < W*H; i++) {
      const [r,g,b,a] = ramp(S[i]);
      imgData.data[k++] = r; imgData.data[k++] = g; imgData.data[k++] = b; imgData.data[k++] = a;
    }
    hctx.putImageData(imgData, 0, 0);

    // add/update image source
    const dataUrl = heat.toDataURL("image/png");
    if (!map.getSource("suitability")) {
      map.addSource("suitability", { type: "image", url: dataUrl, coordinates: imgCoords });
      map.addLayer({ id: "suitability-layer", type: "raster", source: "suitability", paint: { "raster-opacity": 0.68 } }, "hotspots-layer");
    } else {
      const src = map.getSource("suitability");
      src.updateImage({ url: dataUrl, coordinates: imgCoords });
    }

    // spaced hotspots
    const pts = [];
    const stride = 8, minSepM = 150;
    for (let y = 8; y < H-8; y += stride) {
      for (let x = 8; x < W-8; x += stride) {
        const i = y*W + x;
        let isMax = true;
        for (let yy = -8; yy <= 8 && isMax; yy+=4) for (let xx = -8; xx <= 8; xx+=4) {
          if (xx===0 && yy===0) continue;
          if (S[i] < S[(y+yy)*W + (x+xx)]) { isMax = false; break; }
        }
        if (!isMax || S[i] < 0.5) continue;
        const gx = originX + x, gy = originY + y;
        const ll = globalPixelToLngLat(gx, gy, z);
        const p = turf.point([ll.lng, ll.lat], { score: S[i] });
        if (useAOI && aoi && !turf.booleanPointInPolygon(p, aoi)) continue;
        let ok = true;
        for (const q of pts) if (turf.distance(p, q, { units: "meters" }) < minSepM) { ok = false; break; }
        if (ok) pts.push(p);
      }
    }
    pts.sort((a,b) => (b.properties.score - a.properties.score));
    (map.getSource("hotspots")).setData(turf.featureCollection(pts.slice(0, 20)));
    setHasHotspots(pts.length > 0);

    setAnalyzing(false);
    map.fitBounds([[bbox[0], bbox[1]],[bbox[2], bbox[3]]], { padding: 30, duration: 600 });
  }

  function removeHeatmap() {
    const map = mapRef.current;
    if (map.getLayer("suitability-layer")) map.removeLayer("suitability-layer");
    if (map.getSource("suitability")) map.removeSource("suitability");
  }

  /* ---------- UI helpers ---------- */
  const canFinish = ready && isDrawing && pointsCount >= 3;
  const canClear = ready && (hasAOI || isDrawing || hasHotspots || analyzing);

  /* ---------- UI ---------- */
  return (
    <div className="w-screen h-screen">
      <div ref={mapContainer} className="w-full h-full" />

      {/* CONTROL PANEL */}
      <div className="absolute top-4 left-4 rounded-xl shadow-xl ring-1 ring-black/10 p-4 space-y-3 pointer-events-auto max-w-sm max-h-[80vh] overflow-auto z-50 bg-white text-gray-900">
        <div className="font-semibold">DeerScout — Terrain (Beta)</div>

        {/* SEARCH */}
        <div className="relative">
          <input
            value={searchQ}
            onChange={(e) => onSearchInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onSearchEnter(); }}
            placeholder="Search address, road, city, or 34.87,-84.32"
            className="w-full border rounded px-3 py-2 text-sm bg-white text-gray-900 placeholder:text-gray-500"
          />
          {searchLoading && <div className="absolute right-2 top-2 text-xs text-gray-600">…</div>}
          {suggestions.length > 0 && (
            <div className="absolute left-0 right-0 mt-1 bg-white rounded border shadow max-h-56 overflow-auto z-50">
              {suggestions.map((s, i) => (
                <button key={i} className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100" onClick={() => applyResult(s)}>
                  {s.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="text-xs font-medium">Zoom: <b>{zoom}</b></div>

        {/* Row 1: Basemap & Parcels */}
        <div className="flex flex-wrap gap-2">
          <button onClick={toggleBasemap} disabled={!ready} className="px-3 py-2 rounded bg-gray-900 text-white">
            {basemap === "streets" ? "Satellite" : "Streets"}
          </button>
          <button
            onClick={toggleParcels}
            disabled={!ready}
            className={`px-3 py-2 rounded ${parcelsOn ? "bg-green-600 text-white" : "bg-gray-200 text-gray-900"}`}
          >
            {parcelsOn ? "Parcels: On" : "Parcels: Off"}
          </button>
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium">Parcels Opacity</label>
            <input
              type="range"
              min={0.2}
              max={1}
              step={0.1}
              value={parcelOpacity}
              onChange={(e) => setParcelsOpacity(parseFloat(e.target.value))}
              className="w-24"
            />
          </div>
        </div>

        {/* Row 2: Wind / Time / Scope */}
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm font-medium">Wind</label>
          <select
            className="border rounded px-2 py-1 text-sm bg-white text-gray-900"
            value={windDeg}
            onChange={(e) => setWindDeg(parseInt(e.target.value, 10))}
          >
            <option value={0}>N</option><option value={45}>NE</option><option value={90}>E</option>
            <option value={135}>SE</option><option value={180}>S</option><option value={225}>SW</option>
            <option value={270}>W</option><option value={315}>NW</option>
          </select>

          <label className="text-sm font-medium ml-1">Time</label>
          <select
            className="border rounded px-2 py-1 text-sm bg-white text-gray-900"
            value={timeOfDay}
            onChange={(e) => setTimeOfDay(e.target.value)}
          >
            <option value="day">Day (upslope)</option>
            <option value="evening">Evening (downslope)</option>
          </select>

          <label className="text-sm font-medium ml-1">Scope</label>
          <select
            className="border rounded px-2 py-1 text-sm bg-white text-gray-900"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="auto">Auto (AOI if drawn)</option>
            <option value="aoi">AOI only</option>
            <option value="viewport">Viewport</option>
          </select>
        </div>

        {/* Row 3: Development mask & Hotspots */}
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium flex items-center gap-2">
            <input type="checkbox" checked={excludeDev} onChange={(e)=>setExcludeDev(e.target.checked)} />
            Exclude development (roads + buildings + residential)
          </label>
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium w-32">Dev buffer (m)</label>
            <input
              type="range"
              min={20}
              max={120}
              step={10}
              value={devBuffer}
              onChange={(e)=>setDevBuffer(parseInt(e.target.value,10))}
              className="w-40"
            />
            <span className="text-sm font-medium">{devBuffer}</span>
          </div>
          <label className="text-sm font-medium flex items-center gap-2">
            <input type="checkbox" checked={showHotspots} onChange={(e)=>setShowHotspots(e.target.checked)} />
            Show hotspots
          </label>
        </div>

        {/* Row 4: Draw + Analyze */}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={startDraw}
            disabled={!ready || isDrawing}
            className="px-3 py-2 rounded bg-blue-600 text-white disabled:opacity-50"
          >
            Start Drawing
          </button>

          <button
            onClick={finishDraw}
            disabled={!canFinish}
            className={`px-3 py-2 rounded ${
              canFinish
                ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                : "bg-gray-300 text-gray-600 cursor-not-allowed"
            }`}
          >
            Finish (Enter)
          </button>

          <button
            onClick={clearAOI}
            disabled={!canClear}
            className={`px-3 py-2 rounded ${
              canClear
                ? "bg-rose-600 hover:bg-rose-700 text-white"
                : "bg-gray-300 text-gray-600 cursor-not-allowed"
            }`}
          >
            Clear
          </button>

          <button
            onClick={analyzeTerrain}
            disabled={!ready || analyzing}
            className="px-3 py-2 rounded bg-black text-white"
          >
            {analyzing ? "Analyzing…" : "Analyze Terrain"}
          </button>
        </div>

        {/* Legend */}
        <div className="text-xs text-gray-900">
          <div className="mb-1 font-medium">Suitability</div>
          <div
            className="h-3 rounded w-full"
            style={{ background: "linear-gradient(90deg, rgba(0,0,0,0) 0%, #00aaff 15%, #00ffcc 35%, #ffff66 65%, #ff7f00 85%, #ff0000 100%)" }}
          />
          <div className="flex justify-between text-[10px] text-gray-600">
            <span>low</span><span>high</span>
          </div>
          <p className="mt-2">
            Heatmap blends benches (2–12°), saddles/pinches, leeward slope for wind, and thermals
            (day = upslope, evening = downslope). Dev mask removes built-up & roads within the buffer.
          </p>
        </div>
      </div>
    </div>
  );
}
