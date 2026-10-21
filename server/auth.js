"use strict";
const crypto = require("crypto");
const { q } = require("./db");

const SECRET = process.env.SESSION_SECRET || "";
if (SECRET.length < 32) {
  console.error("SESSION_SECRET must be set to a random string of at least 32 characters.");
  process.exit(1);
}
const COOKIE = "nb_session";
const SESSION_DAYS = 14;
const MAX_FAILS = 5;
const LOCK_MINUTES = 5;

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 32);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}
function checkPin(pin, stored) {
  const [alg, saltB64, hashB64] = String(stored || "").split("$");
  if (alg !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const got = crypto.scryptSync(String(pin), Buffer.from(saltB64, "base64"), expected.length);
  return crypto.timingSafeEqual(expected, got);
}
const validPin = pin => /^\d{4,8}$/.test(String(pin || ""));

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${mac}`;
}
function verify(token) {
  const [body, mac] = String(token || "").split(".");
  if (!body || !mac) return null;
  const expect = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}
function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function setSession(res, staff) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const token = sign({ sid: staff.id, v: staff.token_version, exp });
  const secure = process.env.NODE_ENV !== "development";
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`);
}
function clearSession(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

async function loadUser(req, _res, next) {
  req.user = null;
  const p = verify(readCookie(req, COOKIE));
  if (p) {
    const r = await q("SELECT id, name, role, active, token_version FROM staff WHERE id=$1", [p.sid]);
    const s = r.rows[0];
    if (s && s.active && s.token_version === p.v) req.user = { id: s.id, name: s.name, role: s.role };
  }
  next();
}
const requireUser = (req, res, next) => req.user ? next() : res.status(401).json({ error: "Please sign in." });
const requireOwner = (req, res, next) => !req.user ? res.status(401).json({ error: "Please sign in." })
  : req.user.role !== "owner" ? res.status(403).json({ error: "Only the owner can do this." }) : next();

async function login(staffId, pin) {
  const r = await q("SELECT * FROM staff WHERE id=$1 AND active", [staffId]);
  const s = r.rows[0];
  if (!s) return { error: "Choose your name and try again.", status: 400 };
  if (s.locked_until && new Date(s.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(s.locked_until) - Date.now()) / 60000);
    return { error: `Too many wrong PINs. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`, status: 429 };
  }
  if (!checkPin(pin, s.pin_hash)) {
    const fails = s.failed_attempts + 1;
    const lock = fails >= MAX_FAILS;
    await q("UPDATE staff SET failed_attempts=$2, locked_until=$3 WHERE id=$1",
      [s.id, lock ? 0 : fails, lock ? new Date(Date.now() + LOCK_MINUTES * 60000) : null]);
    return { error: lock ? `Too many wrong PINs. Locked for ${LOCK_MINUTES} minutes.` : "Wrong PIN. Try again.", status: 401 };
  }
  await q("UPDATE staff SET failed_attempts=0, locked_until=NULL WHERE id=$1", [s.id]);
  return { staff: s };
}

// First run: create the owner from OWNER_NAME / OWNER_PIN when no staff exist.
async function seedOwner() {
  const r = await q("SELECT count(*)::int AS n FROM staff");
  if (r.rows[0].n > 0) return;
  const name = (process.env.OWNER_NAME || "Owner").trim();
  const pin = process.env.OWNER_PIN || "";
  if (!validPin(pin)) {
    console.warn("No staff yet. Set OWNER_PIN (4-8 digits) and OWNER_NAME, then redeploy to create the owner login.");
    return;
  }
  await q("INSERT INTO staff (name, pin_hash, role) VALUES ($1,$2,'owner')", [name, hashPin(pin)]);
  console.log(`Created owner login for "${name}".`);
}

module.exports = { hashPin, validPin, setSession, clearSession, loadUser, requireUser, requireOwner, login, seedOwner };
