"use strict";
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { q, tx, migrate } = require("./db");
const auth = require("./auth");
const storage = require("./storage");
const sx = require("./stripe");

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const uid = p => p + "_" + crypto.randomBytes(9).toString("base64url");
const r2 = n => Math.round(Number(n || 0) * 1000) / 1000;
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const DEFAULT_SETTINGS = {
  shopName: "Nocera Gifts", currency: "SAR", footer: "Thank you for shopping with us!",
  qrMode: "image", upiId: "", qrImageKey: "", successUrl: "https://noceragifts.com/",
};
async function getSettings() {
  const r = await q("SELECT value FROM settings WHERE key='shop'");
  return Object.assign({}, DEFAULT_SETTINGS, r.rows[0] ? r.rows[0].value : {});
}

const photoUrl = key => key ? `/photos/${key.replace(/^photos\//, "")}` : "";
const absPhotoUrl = key => key && PUBLIC_URL ? `${PUBLIC_URL}${photoUrl(key)}` : "";
function productOut(p) {
  return {
    id: p.id, name: p.name, price: Number(p.price), sku: p.sku, category: p.category, description: p.description,
    photoUrl: photoUrl(p.photo_key), photoKey: p.photo_key || "",
    stripeProductId: p.stripe_product_id || "", stripeError: p.stripe_error || "",
    createdAt: p.created_at, updatedAt: p.updated_at,
  };
}
function orderOut(o) {
  return {
    id: o.id, no: o.no, createdAt: o.created_at, staffName: o.staff_name, items: o.items,
    subtotal: Number(o.subtotal), discount: Number(o.discount), total: Number(o.total), method: o.method,
    received: Number(o.received), change: Number(o.change), currency: o.currency,
    shopify: o.shopify, stripeSessionId: o.stripe_session_id || "", stripePaymentIntent: o.stripe_payment_intent || "",
  };
}

/* ---------- Stripe webhook (needs the raw body, so it comes before express.json) ---------- */
app.post("/api/stripe/webhook", express.raw({ type: "application/json", limit: "1mb" }), ah(async (req, res) => {
  if (!sx.enabled) return res.status(503).send("Stripe is not configured");
  let evt;
  try { evt = sx.constructEvent(req.body, req.headers["stripe-signature"]); }
  catch (e) { return res.status(400).send(`Webhook signature check failed: ${e.message}`); }
  await sx.handleEvent(evt);
  res.json({ received: true });
}));

app.use("/api/import", express.json({ limit: "60mb" }));
app.use(express.json({ limit: "1mb" }));
app.use(ah(auth.loadUser));

/* ---------- health & photos ---------- */
app.get("/api/health", ah(async (_req, res) => { await q("SELECT 1"); res.json({ ok: true }); }));
app.get("/photos/:file", ah(async (req, res) => storage.streamImage(`photos/${req.params.file}`, res)));

/* ---------- auth ---------- */
app.get("/api/login-staff", ah(async (_req, res) => {
  const r = await q("SELECT id, name FROM staff WHERE active ORDER BY role='owner' DESC, name");
  res.json({ staff: r.rows, needsSetup: r.rowCount === 0 });
}));
app.post("/api/login", ah(async (req, res) => {
  const out = await auth.login(Number(req.body.staffId), String(req.body.pin || ""));
  if (out.error) return res.status(out.status).json({ error: out.error });
  auth.setSession(res, out.staff);
  res.json({ me: { id: out.staff.id, name: out.staff.name, role: out.staff.role } });
}));
app.post("/api/logout", (_req, res) => { auth.clearSession(res); res.json({ ok: true }); });

/* ---------- bootstrap ---------- */
app.get("/api/bootstrap", auth.requireUser, ah(async (req, res) => {
  const [settings, products, orders] = await Promise.all([
    getSettings(),
    q("SELECT * FROM products WHERE active ORDER BY name"),
    q("SELECT * FROM orders ORDER BY created_at DESC LIMIT 5000"),
  ]);
  res.json({
    me: req.user, settings: Object.assign({}, settings, { qrImageUrl: photoUrl(settings.qrImageKey) }),
    products: products.rows.map(productOut), orders: orders.rows.map(orderOut),
    stripeEnabled: sx.enabled, photosEnabled: storage.enabled,
  });
}));

/* ---------- settings ---------- */
app.put("/api/settings", auth.requireOwner, ah(async (req, res) => {
  const cur = await getSettings();
  const allowed = ["shopName", "currency", "footer", "qrMode", "upiId", "qrImageKey", "successUrl"];
  const next = Object.assign({}, cur);
  for (const k of allowed) if (k in req.body) next[k] = typeof req.body[k] === "string" ? req.body[k].trim().slice(0, 500) : next[k];
  if (!/^[A-Z]{3}$/.test(next.currency)) return res.status(400).json({ error: "Currency must be a 3-letter code like SAR." });
  if (next.successUrl && !/^https:\/\//.test(next.successUrl)) return res.status(400).json({ error: "The after-payment page must start with https://" });
  await q("INSERT INTO settings (key, value) VALUES ('shop',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [JSON.stringify(next)]);
  res.json({ settings: Object.assign({}, next, { qrImageUrl: photoUrl(next.qrImageKey) }) });
}));

/* ---------- photos ---------- */
app.post("/api/photos", auth.requireOwner, express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "6mb" }), ah(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "No image received." });
  const key = await storage.putImage(req.body, req.headers["content-type"]);
  res.json({ key, url: photoUrl(key) });
}));

/* ---------- products ---------- */
function cleanProduct(b) {
  const name = String(b.name || "").trim().slice(0, 200);
  const price = r2(b.price);
  if (!name) throw Object.assign(new Error("Give the product a name."), { status: 400 });
  if (!(price >= 0)) throw Object.assign(new Error("Enter a valid price."), { status: 400 });
  return {
    name, price,
    sku: String(b.sku || "").trim().slice(0, 100),
    category: String(b.category || "").trim().slice(0, 100),
    description: String(b.description || "").trim().slice(0, 2000),
    photo_key: b.photoKey ? String(b.photoKey) : null,
  };
}
async function maybeSync(row, wanted) {
  if (!wanted || !sx.enabled) return row;
  const settings = await getSettings();
  try {
    const f = await sx.syncProduct(row, settings.currency, absPhotoUrl(row.photo_key));
    const r = await q(`UPDATE products SET stripe_product_id=COALESCE($2,stripe_product_id), stripe_price_id=COALESCE($3,stripe_price_id),
      stripe_amount=COALESCE($4,stripe_amount), stripe_currency=COALESCE($5,stripe_currency), stripe_error='', stripe_synced_at=now() WHERE id=$1 RETURNING *`,
      [row.id, f.stripe_product_id || null, f.stripe_price_id || null, f.stripe_amount ?? null, f.stripe_currency || null]);
    return r.rows[0];
  } catch (e) {
    const r = await q("UPDATE products SET stripe_error=$2 WHERE id=$1 RETURNING *", [row.id, "Stripe: " + sx.errText(e)]);
    return r.rows[0];
  }
}
app.post("/api/products", auth.requireOwner, ah(async (req, res) => {
  const p = cleanProduct(req.body);
  const r = await q(`INSERT INTO products (id, name, price, sku, category, description, photo_key) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [uid("p"), p.name, p.price, p.sku, p.category, p.description, p.photo_key]);
  const row = await maybeSync(r.rows[0], req.body.syncStripe !== false);
  res.json({ product: productOut(row) });
}));
app.put("/api/products/:id", auth.requireOwner, ah(async (req, res) => {
  const p = cleanProduct(req.body);
  const r = await q(`UPDATE products SET name=$2, price=$3, sku=$4, category=$5, description=$6, photo_key=$7, updated_at=now() WHERE id=$1 AND active RETURNING *`,
    [req.params.id, p.name, p.price, p.sku, p.category, p.description, p.photo_key]);
  if (!r.rowCount) return res.status(404).json({ error: "That product no longer exists." });
  const row = await maybeSync(r.rows[0], req.body.syncStripe !== false);
  res.json({ product: productOut(row) });
}));
// Removes from the counter only. Stripe is never touched.
app.delete("/api/products/:id", auth.requireOwner, ah(async (req, res) => {
  await q("UPDATE products SET active=false, updated_at=now() WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
}));

/* ---------- carts ---------- */
async function priceCart(body) {
  const items = Array.isArray(body.items) ? body.items : [];
  const qtyById = new Map();
  for (const it of items) {
    const qty = Math.floor(Number(it.qty));
    if (it.productId && qty > 0 && qty <= 999) qtyById.set(String(it.productId), (qtyById.get(String(it.productId)) || 0) + qty);
  }
  if (!qtyById.size) throw Object.assign(new Error("The cart is empty."), { status: 400 });
  const r = await q("SELECT * FROM products WHERE id = ANY($1) AND active", [[...qtyById.keys()]]);
  if (r.rowCount !== qtyById.size) throw Object.assign(new Error("Some items were removed. Refresh and try again."), { status: 409 });
  const lines = r.rows.map(p => ({ p, qty: qtyById.get(p.id) }));
  const subtotal = r2(lines.reduce((s, l) => s + l.qty * Number(l.p.price), 0));
  const discount = Math.min(Math.max(0, r2(body.discount)), subtotal);
  return { lines, subtotal, discount, total: r2(subtotal - discount) };
}

/* ---------- orders (cash & bank QR) ---------- */
app.post("/api/orders", auth.requireUser, ah(async (req, res) => {
  const method = req.body.method === "qr" ? "qr" : "cash";
  const c = await priceCart(req.body);
  const settings = await getSettings();
  const received = method === "cash" && req.body.received != null && req.body.received !== "" ? r2(req.body.received) : c.total;
  if (method === "cash" && received < c.total) return res.status(400).json({ error: "Cash received is less than the total." });
  const items = c.lines.map(({ p, qty }) => ({ productId: p.id, name: p.name, sku: p.sku, category: p.category, price: Number(p.price), qty }));
  const r = await q(`INSERT INTO orders (id, no, staff_id, staff_name, items, subtotal, discount, total, method, received, change, currency)
    VALUES ($1, nextval('order_no_seq'), $2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [uid("o"), req.user.id, req.user.name, JSON.stringify(items), c.subtotal, c.discount, c.total, method, received, r2(received - c.total), settings.currency]);
  res.json({ order: orderOut(r.rows[0]) });
}));
app.post("/api/orders/mark-exported", auth.requireOwner, ah(async (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(String);
  await q("UPDATE orders SET shopify=true, shopify_exported_at=now() WHERE id = ANY($1) AND NOT shopify", [ids]);
  res.json({ ok: true });
}));

/* ---------- Stripe checkout ---------- */
app.post("/api/checkout/stripe", auth.requireUser, ah(async (req, res) => {
  if (!sx.enabled) return res.status(503).json({ error: "Stripe isn’t set up on the server yet." });
  const c = await priceCart(req.body);
  if (c.total <= 0) return res.status(400).json({ error: "The total must be more than zero for Stripe." });
  const settings = await getSettings();
  try {
    const out = await sx.createCheckout(Object.assign({}, c, { currency: settings.currency, staff: req.user, successUrl: settings.successUrl || DEFAULT_SETTINGS.successUrl }));
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: "Stripe: " + sx.errText(e) });
  }
}));
app.get("/api/checkout/stripe/:id", auth.requireUser, ah(async (req, res) => {
  let r = await q("SELECT * FROM checkouts WHERE id=$1", [req.params.id]);
  let ck = r.rows[0];
  if (!ck) return res.status(404).json({ error: "Unknown payment." });
  // Webhook is the main signal; check Stripe directly if it hasn't arrived for a few seconds.
  if (ck.status === "open" && Date.now() - new Date(ck.checked_at) > 4000 && sx.enabled) {
    try { await sx.refresh(ck.id); } catch (e) { console.warn("refresh failed", sx.errText(e)); }
    r = await q("SELECT * FROM checkouts WHERE id=$1", [req.params.id]); ck = r.rows[0];
  }
  let order = null;
  if (ck.order_id) { const o = await q("SELECT * FROM orders WHERE id=$1", [ck.order_id]); order = o.rows[0] ? orderOut(o.rows[0]) : null; }
  res.json({ status: ck.status, lastError: ck.last_error, expiresAt: new Date(ck.expires_at).getTime(), order });
}));
app.post("/api/checkout/stripe/:id/cancel", auth.requireUser, ah(async (req, res) => {
  if (!sx.enabled) return res.status(503).json({ error: "Stripe isn’t set up on the server yet." });
  await sx.cancel(req.params.id);
  const r = await q("SELECT c.status, o.* FROM checkouts c LEFT JOIN orders o ON o.id=c.order_id WHERE c.id=$1", [req.params.id]);
  const row = r.rows[0];
  res.json({ status: row ? row.status : "cancelled", order: row && row.id ? orderOut(row) : null });
}));

/* ---------- staff ---------- */
app.get("/api/staff", auth.requireOwner, ah(async (_req, res) => {
  const r = await q("SELECT id, name, role, active, created_at FROM staff ORDER BY role='owner' DESC, name");
  res.json({ staff: r.rows });
}));
app.post("/api/staff", auth.requireOwner, ah(async (req, res) => {
  const name = String(req.body.name || "").trim().slice(0, 60);
  const role = req.body.role === "owner" ? "owner" : "staff";
  if (!name) return res.status(400).json({ error: "Enter a name." });
  if (!auth.validPin(req.body.pin)) return res.status(400).json({ error: "PIN must be 4 to 8 digits." });
  try {
    const r = await q("INSERT INTO staff (name, pin_hash, role) VALUES ($1,$2,$3) RETURNING id, name, role, active", [name, auth.hashPin(req.body.pin), role]);
    res.json({ staff: r.rows[0] });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Someone already has that name." });
    throw e;
  }
}));
app.put("/api/staff/:id", auth.requireOwner, ah(async (req, res) => {
  const id = Number(req.params.id);
  const cur = (await q("SELECT * FROM staff WHERE id=$1", [id])).rows[0];
  if (!cur) return res.status(404).json({ error: "Staff member not found." });
  const role = req.body.role ? (req.body.role === "owner" ? "owner" : "staff") : cur.role;
  const active = typeof req.body.active === "boolean" ? req.body.active : cur.active;
  if (cur.role === "owner" && (role !== "owner" || !active)) {
    const n = (await q("SELECT count(*)::int n FROM staff WHERE role='owner' AND active AND id<>$1", [id])).rows[0].n;
    if (!n) return res.status(400).json({ error: "Keep at least one active owner." });
  }
  let pinSql = "", params = [id, role, active, String(req.body.name || cur.name).trim().slice(0, 60)];
  if (req.body.pin) {
    if (!auth.validPin(req.body.pin)) return res.status(400).json({ error: "PIN must be 4 to 8 digits." });
    pinSql = ", pin_hash=$5, token_version=token_version+1, failed_attempts=0, locked_until=NULL"; params.push(auth.hashPin(req.body.pin));
  }
  const tv = (!active || role !== cur.role) && !pinSql ? ", token_version=token_version+1" : "";
  const r = await q(`UPDATE staff SET role=$2, active=$3, name=$4${pinSql}${tv} WHERE id=$1 RETURNING id, name, role, active`, params);
  res.json({ staff: r.rows[0] });
}));

/* ---------- one-time import from the Claude app ---------- */
app.post("/api/import", auth.requireOwner, ah(async (req, res) => {
  const b = req.body || {};
  const result = { products: 0, orders: 0, photos: 0, settings: false };
  const keyFor = new Map();
  for (const p of b.products || []) {
    if (p.photoBase64 && storage.enabled) {
      try { keyFor.set(p.id, await storage.putImage(Buffer.from(p.photoBase64, "base64"), p.photoType || "image/jpeg")); result.photos++; } catch (e) { console.warn("photo import", e.message); }
    }
  }
  let qrKey = "";
  if (b.settings && b.settings.qrImageBase64 && storage.enabled) {
    try { qrKey = await storage.putImage(Buffer.from(b.settings.qrImageBase64, "base64"), b.settings.qrImageType || "image/jpeg"); result.photos++; } catch (e) {}
  }
  await tx(async c => {
    for (const p of b.products || []) {
      const x = cleanProduct(p);
      // Keep existing Stripe links so the move never creates duplicate Stripe products.
      const ins = await c.query(`INSERT INTO products (id, name, price, sku, category, description, photo_key, created_at, updated_at,
          stripe_product_id, stripe_price_id, stripe_amount, stripe_currency, stripe_synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now()),now(),$9,$10,$11,$12, CASE WHEN $9::text IS NULL THEN NULL ELSE now() END)
        ON CONFLICT (id) DO NOTHING`,
        [String(p.id), x.name, x.price, x.sku, x.category, x.description, keyFor.get(p.id) || null, p.createdAt || null,
         p.stripeProductId || null, p.stripePriceId || null, Number.isInteger(p.stripeAmount) ? p.stripeAmount : null, p.stripeCurrency || null]);
      result.products += ins.rowCount;
    }
    let maxNo = 0;
    for (const o of b.orders || []) {
      if (!o.id || !o.no || !Array.isArray(o.items)) continue;
      const method = ["cash", "qr", "stripe"].includes(o.method) ? o.method : "qr";
      const ins = await c.query(`INSERT INTO orders (id, no, created_at, staff_name, items, subtotal, discount, total, method, received, change, currency, shopify, stripe_session_id, stripe_payment_intent)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING`,
        [String(o.id), Number(o.no), o.createdAt, o.staffName || "Imported", JSON.stringify(o.items), r2(o.subtotal), r2(o.discount), r2(o.total), method,
         r2(o.received ?? o.total), r2(o.change || 0), o.currency || "SAR", !!o.shopify, o.stripeSessionId || null, o.stripePaymentIntent || null]);
      result.orders += ins.rowCount;
      maxNo = Math.max(maxNo, Number(o.no));
    }
    const seq = (await c.query("SELECT last_value, is_called FROM order_no_seq")).rows[0];
    const nextFromSettings = b.settings && Number(b.settings.nextNo) || 0;
    const want = Math.max(maxNo + 1, nextFromSettings, Number(seq.is_called ? Number(seq.last_value) + 1 : seq.last_value));
    await c.query("SELECT setval('order_no_seq', $1, false)", [want]);
    if (b.settings) {
      const cur = await getSettings();
      const s = b.settings;
      const next = Object.assign({}, cur, {
        shopName: s.shopName || cur.shopName, currency: (s.currency || cur.currency).toUpperCase(), footer: s.footer ?? cur.footer,
        qrMode: s.qrMode || cur.qrMode, upiId: s.upiId || cur.upiId, ...(qrKey ? { qrImageKey: qrKey } : {}),
      });
      await c.query("INSERT INTO settings (key, value) VALUES ('shop',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [JSON.stringify(next)]);
      result.settings = true;
    }
  });
  res.json(result);
}));

/* ---------- static app ---------- */
app.use(express.static(path.join(__dirname, "..", "public"), { index: "index.html", maxAge: "1h" }));
app.get(/^\/(?!api\/|photos\/).*/, (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? "Something went wrong on the server. Try again." : err.message });
});

(async () => {
  await migrate();
  await auth.seedOwner();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`Nocera billing listening on ${port}`));
})().catch(e => { console.error("Startup failed:", e); process.exit(1); });
