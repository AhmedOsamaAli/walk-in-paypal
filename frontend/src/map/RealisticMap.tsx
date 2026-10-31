import { useEffect, useEffectEvent, useRef, useState } from "react";
import { GeoJSONSource, LngLatBounds, Map, Marker, NavigationControl, setWorkerCount, setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import type { GapRow, HeatCell, Walk } from "../api/types";
import type { MapPoint } from "./controller";
import { gapPins, type Pin } from "./pins";
import { realisticFeatures } from "./realistic";

setWorkerUrl(workerUrl);
setWorkerCount(1);
const SOURCE = "walkin-evidence";

interface Props {
  site: MapPoint;
  walk: Walk | null;
  gap: GapRow | null;
  cells: HeatCell[];
  pinnable: boolean;
  onPick: (lat: number, lon: number) => void;
  onPin: (pin: Pin, keyboard: boolean) => void;
  onError: (message: string) => void;
}

export function RealisticMap({ site, walk, gap, cells, pinnable, onPick, onPin, onError }: Props) {
  const element = useRef<HTMLDivElement>(null);
  const controller = useRef<Map | null>(null);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const failure = useEffectEvent(onError);
  const pick = useEffectEvent((lat: number, lon: number) => { if (pinnable) onPick(lat, lon); });
  const select = useEffectEvent(onPin);
  const initial = useEffectEvent(() => site);

  useEffect(() => {
    if (!element.current) return;
    let map: Map;
    try {
      const point = initial();
      map = new Map({
        container: element.current, style: "https://tiles.openfreemap.org/styles/bright",
        center: [point.lon, point.lat], zoom: 16, pitch: 50, bearing: -15,
        canvasContextAttributes: { antialias: false }, attributionControl: { compact: true },
      });
    } catch (error) {
      console.error("The optional 3D map could not start", error);
      failure("3D is unavailable on this device. The 2D evidence map is still available.");
      return;
    }
    controller.current = map;
    let loaded = false;
    const timeout = window.setTimeout(() => {
      if (!loaded) failure("The 3D map did not load in time. Check your connection or use the 2D map.");
    }, 25_000);
    map.addControl(new NavigationControl({ visualizePitch: true }), "top-right");
    map.on("error", (event) => {
      console.error("Optional 3D map data failed", event.error);
      if (!loaded) failure("The 3D map provider could not load. The 2D map has not been changed.");
      else setNotice("Some 3D map tiles could not load. Try zooming out, or return to the 2D map.");
    });
    map.on("webglcontextlost", () => { failure("The device lost its 3D graphics context. Return to the 2D map."); });
    map.on("load", () => {
      loaded = true;
      window.clearTimeout(timeout);
      const layers = map.getStyle().layers;
      const building = layers.find((layer) => layer.type === "fill" && layer["source-layer"] === "building");
      if (building && "source" in building) {
        map.addLayer({
          id: "walkin-buildings", type: "fill-extrusion", source: building.source, "source-layer": "building", minzoom: 14.5,
          filter: ["all", ["!=", ["get", "hide_3d"], true], [">", ["coalesce", ["get", "render_height"], 0], 0]],
          paint: { "fill-extrusion-color": "#c8cec5", "fill-extrusion-height": ["coalesce", ["get", "render_height"], 0],
            "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0], "fill-extrusion-opacity": .88 },
        }, layers.find((layer) => layer.type === "symbol")?.id);
      } else setNotice("This map style has no building-height data. Real streets and the survey overlays still show.");
      map.addSource(SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "walkin-taste", source: SOURCE, type: "fill", filter: ["==", ["get", "kind"], "taste"],
        paint: { "fill-color": "#7258c4", "fill-opacity": ["get", "strength"] } });
      map.addLayer({ id: "walkin-reach", source: SOURCE, type: "fill", filter: ["==", ["get", "kind"], "reach"],
        paint: { "fill-color": "#0066f2", "fill-opacity": .08 } });
      map.addLayer({ id: "walkin-outline", source: SOURCE, type: "line", filter: ["==", ["get", "kind"], "reach"],
        paint: { "line-color": "#005ce6", "line-width": 2, "line-dasharray": [3, 2] } });
      map.addLayer({ id: "walkin-site", source: SOURCE, type: "circle", filter: ["==", ["get", "kind"], "site"],
        paint: { "circle-color": "#ffd400", "circle-radius": 8, "circle-stroke-color": "#173451", "circle-stroke-width": 2 } });
      setReady(true);
    });
    map.on("click", (event) => { pick(event.lngLat.lat, event.lngLat.lng); });
    const observer = new ResizeObserver(() => { map.resize(); });
    observer.observe(element.current);
    return () => {
      window.clearTimeout(timeout);
      observer.disconnect();
      map.remove();
      controller.current = null;
    };
  }, []);

  useEffect(() => {
    const map = controller.current;
    if (!map || !ready) return;
    const source = map.getSource(SOURCE);
    if (!(source instanceof GeoJSONSource)) throw new Error("The 3D evidence source is unavailable.");
    void source.setData(realisticFeatures(site, walk, gap, cells)).catch((error: unknown) => {
      console.error("The 3D survey overlays could not be updated", error);
      failure("The survey overlays could not be updated in 3D. Use the 2D evidence map.");
    });
    const pins = gap ? gapPins(gap).pins : [];
    const markers = pins.map((pin) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "realistic-pin";
      button.dataset.role = pin.role;
      button.textContent = pin.mark;
      button.setAttribute("aria-label", `${pin.mark}: ${pin.name}`);
      button.addEventListener("click", (event) => { event.stopPropagation(); select(pin, event.detail === 0); });
      return new Marker({ element: button }).setLngLat([pin.lon, pin.lat]).addTo(map);
    });
    return () => { for (const marker of markers) marker.remove(); };
  }, [ready, site, walk, gap, cells]);

  useEffect(() => {
    const map = controller.current;
    if (!map || !ready) return;
    const bounds = new LngLatBounds([site.lon, site.lat], [site.lon, site.lat]);
    for (const [lat, lon] of walk?.ring ?? []) bounds.extend([lon, lat]);
    if (walk?.ring.length) map.fitBounds(bounds, { padding: 70, maxZoom: 16.8, duration: 0 });
    else map.jumpTo({ center: [site.lon, site.lat], zoom: 16 });
  }, [ready, site.lat, site.lon, walk]);

  return <div className="realistic-view">
    <div ref={element} className="realistic-canvas" aria-label="Optional 3D map of real streets and mapped buildings" />
    {!ready ? <p className="realistic-notice" role="status">Loading the optional 3D map…</p> : null}
    {notice ? <p className="realistic-notice" role="alert">{notice}</p> : null}
    {ready ? <button className="realistic-locate" type="button" onClick={() => {
      controller.current?.jumpTo({ center: [site.lon, site.lat], zoom: 16.8, pitch: 50 });
    }}>Zoom to site</button> : null}
    <p className="realistic-disclosure">Mapped building shapes; heights may be estimated. Coverage varies. Not live imagery.</p>
  </div>;
}
