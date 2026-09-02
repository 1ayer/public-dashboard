import L from "leaflet";
import "leaflet/dist/leaflet.css";

const CATEGORY_COLORS = {
  "회의·교육": "#1376d2",
  "문화·행사": "#7958b3",
  "실내체육": "#21866f",
  "구기·라켓": "#e58134",
  "다목적공간": "#2d8fa4",
  "야외·휴양": "#639b3c",
  "기타": "#6f7f8b",
};

function cellSizeForZoom(zoom) {
  if (zoom <= 6) return 0.55;
  if (zoom === 7) return 0.28;
  if (zoom === 8) return 0.14;
  if (zoom === 9) return 0.07;
  return 0;
}

function cluster(items, zoom) {
  const cellSize = cellSizeForZoom(zoom);
  if (!cellSize) return items.map((item) => ({ lat: item.lat, lng: item.lng, items: [item] }));
  const cells = new Map();
  items.forEach((item) => {
    const key = `${Math.floor(item.lat / cellSize)}:${Math.floor(item.lng / cellSize)}`;
    const entry = cells.get(key) || { lat: 0, lng: 0, items: [] };
    entry.lat += item.lat;
    entry.lng += item.lng;
    entry.items.push(item);
    cells.set(key, entry);
  });
  return [...cells.values()].map((entry) => ({
    lat: entry.lat / entry.items.length,
    lng: entry.lng / entry.items.length,
    items: entry.items,
  }));
}

export class FacilityMap {
  constructor(element, { onSelect, onNearbyChange, onTileError }) {
    this.onSelect = onSelect;
    this.onNearbyChange = onNearbyChange;
    this.facilities = [];
    this.renderer = L.canvas({ padding: 0.4 });
    this.map = L.map(element, { preferCanvas: true, zoomControl: true }).setView([36.3, 127.8], 7);
    this.layers = L.layerGroup().addTo(this.map);
    this.userLayer = L.layerGroup().addTo(this.map);
    const tiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    });
    let tileErrors = 0;
    tiles.on("tileerror", () => {
      tileErrors += 1;
      if (tileErrors === 3) onTileError?.();
    });
    tiles.addTo(this.map);
    this.map.on("zoomend moveend", () => {
      this.draw();
      this.emitNearby();
    });
  }

  setFacilities(facilities, { fit = false } = {}) {
    this.facilities = facilities.filter((item) => item.mapValid);
    this.draw();
    if (fit && this.facilities.length) {
      const bounds = L.latLngBounds(this.facilities.map((item) => [item.lat, item.lng]));
      this.map.fitBounds(bounds, { padding: [24, 24], maxZoom: 11, animate: false });
    }
    if (!this.facilities.length) this.map.setView([36.3, 127.8], 7, { animate: false });
    this.emitNearby();
  }

  draw() {
    this.layers.clearLayers();
    if (!this.facilities.length) return;
    const zoom = this.map.getZoom();
    const paddedBounds = this.map.getBounds().pad(0.25);
    const visible = zoom >= 10
      ? this.facilities.filter((item) => paddedBounds.contains([item.lat, item.lng]))
      : this.facilities;
    cluster(visible, zoom).forEach((point) => {
      if (point.items.length === 1) {
        const item = point.items[0];
        const marker = L.circleMarker([item.lat, item.lng], {
          renderer: this.renderer,
          radius: 5,
          weight: 1.5,
          color: "#ffffff",
          fillColor: CATEGORY_COLORS[item.category] || CATEGORY_COLORS["기타"],
          fillOpacity: 0.9,
        });
        marker.bindTooltip(item.name, { direction: "top", opacity: 0.94 });
        marker.on("click", () => this.onSelect(item.id));
        marker.addTo(this.layers);
        return;
      }
      const count = point.items.length;
      const radius = Math.min(25, 9 + Math.log2(count) * 2.2);
      const marker = L.circleMarker([point.lat, point.lng], {
        renderer: this.renderer,
        radius,
        weight: 2,
        color: "#ffffff",
        fillColor: "#102a43",
        fillOpacity: 0.86,
      });
      marker.bindTooltip(`${count.toLocaleString("ko-KR")}개 시설`, { direction: "top" });
      marker.on("click", () => this.map.setView([point.lat, point.lng], Math.min(12, zoom + 2)));
      marker.addTo(this.layers);
    });
  }

  emitNearby() {
    if (!this.onNearbyChange) return;
    const center = this.map.getCenter();
    const nearby = [...this.facilities]
      .sort((a, b) => center.distanceTo([a.lat, a.lng]) - center.distanceTo([b.lat, b.lng]))
      .slice(0, 6);
    this.onNearbyChange(nearby);
  }

  showUserLocation(location) {
    this.userLayer.clearLayers();
    L.circleMarker([location.lat, location.lng], {
      renderer: this.renderer,
      radius: 8,
      weight: 3,
      color: "#ffffff",
      fillColor: "#e24a5a",
      fillOpacity: 1,
    }).bindTooltip("내 위치").addTo(this.userLayer);
    this.map.setView([location.lat, location.lng], 12);
  }

  focus(item) {
    if (!item?.mapValid) return;
    this.map.setView([item.lat, item.lng], Math.max(12, this.map.getZoom()));
  }

  invalidateSize() {
    this.map.invalidateSize();
  }
}
