/**
 * Tests for existingBridge.ts helpers - specifically the semver-greater
 * compare used to gate the "Update available" banner.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { semverGreater } = require("../dist/main/existingBridge");

test("semverGreater: trivial newer", () => {
  assert.equal(semverGreater("0.2.0", "0.1.0"), true);
  assert.equal(semverGreater("1.0.0", "0.9.9"), true);
});

test("semverGreater: equal is NOT greater", () => {
  assert.equal(semverGreater("0.1.0", "0.1.0"), false);
});

test("semverGreater: handles missing minor/patch", () => {
  assert.equal(semverGreater("2", "1"), true);
  assert.equal(semverGreater("1.2", "1.1"), true);
  assert.equal(semverGreater("1.0.0", "1"), false);
});

test("semverGreater: strips leading v and prerelease suffix", () => {
  assert.equal(semverGreater("v0.2.0", "0.1.9"), true);
  assert.equal(semverGreater("0.2.0-beta.1", "0.1.99"), true);
  // Prerelease compared against itself is "equal" under our loose impl.
  assert.equal(semverGreater("0.2.0-rc.1", "0.2.0-rc.2"), false);
});

test("semverGreater: older returns false", () => {
  assert.equal(semverGreater("0.1.0", "0.2.0"), false);
});
