/** Pure geospatial helpers. No I/O — safe to unit test. */

const R_EARTH_M = 6_371_000;
const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in metres between two {lat, lng} points. */
export function haversineMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Straight-line ETA in seconds at an assumed average speed.
 *
 * Deliberately not a routing engine. A real deployment would call OSRM/Valhalla
 * here; the interface (points in, seconds out) is the same, so swapping it is a
 * one-function change.
 */
export function etaSeconds(from, to, avgSpeedKmh) {
  const metres = haversineMeters(from, to);
  const metresPerSecond = (avgSpeedKmh * 1000) / 3600;
  return Math.round(metres / metresPerSecond);
}

/** Move `metres` from a point along a bearing in degrees. Used by the simulator. */
export function offsetPoint({ lat, lng }, metres, bearingDeg) {
  const bearing = toRad(bearingDeg);
  const angular = metres / R_EARTH_M;
  const lat1 = toRad(lat);
  const lng1 = toRad(lng);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) +
      Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2)
    );

  return { lat: (lat2 * 180) / Math.PI, lng: (((lng2 * 180) / Math.PI + 540) % 360) - 180 };
}

/** Bearing in degrees from `a` to `b`. */
export function bearingDegrees(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function isValidCoord(lat, lng) {
  return (
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  );
}
