import test from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineMeters, etaSeconds, offsetPoint, bearingDegrees, isValidCoord,
} from '../src/lib/geo.js';

const BLR = { lat: 12.9716, lng: 77.5946 };

test('haversine: identical points are zero apart', () => {
  assert.equal(haversineMeters(BLR, BLR), 0);
});

test('haversine: matches a known distance', () => {
  // Bengaluru → Chennai, ~290 km great-circle.
  const chennai = { lat: 13.0827, lng: 80.2707 };
  const km = haversineMeters(BLR, chennai) / 1000;
  assert.ok(km > 284 && km < 296, `expected ~290km, got ${km.toFixed(1)}km`);
});

test('haversine: one degree of latitude is ~111 km', () => {
  const north = { lat: BLR.lat + 1, lng: BLR.lng };
  const km = haversineMeters(BLR, north) / 1000;
  assert.ok(Math.abs(km - 111.19) < 0.5, `got ${km.toFixed(2)}km`);
});

test('haversine: symmetric', () => {
  const other = { lat: 13.05, lng: 77.7 };
  assert.equal(
    haversineMeters(BLR, other).toFixed(6),
    haversineMeters(other, BLR).toFixed(6)
  );
});

test('offsetPoint: moving N then S returns to origin', () => {
  const north = offsetPoint(BLR, 1000, 0);
  const back = offsetPoint(north, 1000, 180);
  assert.ok(haversineMeters(BLR, back) < 0.5);
});

test('offsetPoint: distance moved matches the request', () => {
  for (const bearing of [0, 45, 90, 180, 270, 315]) {
    const moved = offsetPoint(BLR, 2500, bearing);
    const actual = haversineMeters(BLR, moved);
    assert.ok(Math.abs(actual - 2500) < 1, `bearing ${bearing}: got ${actual.toFixed(2)}m`);
  }
});

test('offsetPoint: bearing 0 goes north, 90 goes east', () => {
  assert.ok(offsetPoint(BLR, 1000, 0).lat > BLR.lat);
  assert.ok(offsetPoint(BLR, 1000, 90).lng > BLR.lng);
  assert.ok(offsetPoint(BLR, 1000, 180).lat < BLR.lat);
  assert.ok(offsetPoint(BLR, 1000, 270).lng < BLR.lng);
});

test('bearingDegrees: round-trips through offsetPoint', () => {
  for (const expected of [0, 30, 90, 175, 250, 359]) {
    const target = offsetPoint(BLR, 3000, expected);
    const actual = bearingDegrees(BLR, target);
    assert.ok(Math.abs(actual - expected) < 0.5, `expected ${expected}, got ${actual.toFixed(2)}`);
  }
});

test('etaSeconds: 30 km at 30 km/h takes an hour', () => {
  const target = offsetPoint(BLR, 30_000, 90);
  const seconds = etaSeconds(BLR, target, 30);
  assert.ok(Math.abs(seconds - 3600) < 5, `got ${seconds}s`);
});

test('etaSeconds: doubling speed halves the time', () => {
  const target = offsetPoint(BLR, 10_000, 45);
  const slow = etaSeconds(BLR, target, 20);
  const fast = etaSeconds(BLR, target, 40);
  assert.ok(Math.abs(slow / fast - 2) < 0.01);
});

test('isValidCoord: rejects out-of-range and non-finite values', () => {
  assert.ok(isValidCoord(0, 0));
  assert.ok(isValidCoord(-90, 180));
  assert.ok(!isValidCoord(91, 0));
  assert.ok(!isValidCoord(0, 181));
  assert.ok(!isValidCoord(NaN, 0));
  assert.ok(!isValidCoord(undefined, 0));
  assert.ok(!isValidCoord('12.9', 77.5));
});
