/**
 * Tests for parsePairingPlain, the fallback parser for `openclaw pairing
 * list telegram` plain-text output (used when --json isn't recognized).
 *
 * The shape of the upstream output isn't ironclad - it has changed once
 * already, dropping the 4-char minimum on codes. The tests below pin the
 * loose contract: header lines and divider lines must be skipped, code +
 * numeric senderId must be extracted, and a parenthesized label is optional.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { parsePairingPlain } = require("../dist/main/ipcHandlers");

test("parsePairingPlain: skips header + divider, extracts code and senderId", () => {
  const txt = [
    "CODE       SENDER               AGE",
    "----       ------               ---",
    "a1b2c3d4   123456789 (Alice)    2m",
    "ef99       987654321 (Bob)      10m",
  ].join("\n");
  const out = parsePairingPlain(txt);
  assert.equal(out.length, 2);
  assert.equal(out[0].code, "a1b2c3d4");
  assert.equal(out[0].senderId, "123456789");
  assert.equal(out[0].label, "Alice");
  assert.equal(out[1].code, "ef99");
  assert.equal(out[1].senderId, "987654321");
  assert.equal(out[1].label, "Bob");
});

test("parsePairingPlain: accepts 3-character codes", () => {
  const out = parsePairingPlain("abc   42\n");
  assert.equal(out.length, 1);
  assert.equal(out[0].code, "abc");
  assert.equal(out[0].senderId, "42");
});

test("parsePairingPlain: accepts underscores and hyphens in codes", () => {
  const out = parsePairingPlain("foo_bar-1   12345 (X)\n");
  assert.equal(out.length, 1);
  assert.equal(out[0].code, "foo_bar-1");
  assert.equal(out[0].senderId, "12345");
});

test("parsePairingPlain: ignores blank lines and pure text noise", () => {
  const txt = [
    "",
    "no pending codes",
    "",
    "abc   55",
  ].join("\n");
  const out = parsePairingPlain(txt);
  // "no pending codes" doesn't have a numeric second field, so it doesn't
  // match. "abc 55" does.
  assert.deepEqual(
    out.map((p) => `${p.code}/${p.senderId}`),
    ["abc/55"],
  );
});

test("parsePairingPlain: returns [] for empty input", () => {
  assert.deepEqual(parsePairingPlain(""), []);
  assert.deepEqual(parsePairingPlain("CODE SENDER AGE\n---- ------ ---\n"), []);
});
