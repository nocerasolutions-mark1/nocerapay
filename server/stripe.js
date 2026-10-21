"use strict";
const Stripe = require("stripe");
const { q, tx } = require("./db");

const key = process.env.STRIPE_SECRET_KEY || "";
const opts = {};
// Lets local tests point the SDK at a mock server. Not used on Railway.
if (process.env.STRIPE_API_HOST) {
  const u = new URL(process.env.STRIPE_API_HOST);
  Object.assign(opts, { host: u.hostname, port: u.port, protocol: u.protocol.replace(":", "") });
}
const stripe = key ? new Stripe(key, opts) : null;
const enabled = !!stripe;
if (!enabled) console.warn("STRIPE_SECRET_KEY is not set. Stripe QR payments and product sync are off.");

const DEC = { kwd: 3, bhd: 3, omr: 3, jod: 3, tnd: 3, jpy: 0, krw: 0 };
const decimals = cur => DEC[String(cur).toLowerCase()] ?? 2;
const toMinor = (v, cur) => Math.round(Number(v || 0) * 10 ** decimals(cur));
const fromMinor = (v, cur) => Number(v || 0) / 10 ** decimals(cur);

function errText(e) {
  if (!e) return "Unknown Stripe error";
  return (e.raw && e.raw.message) || e.message || String(e);
}

/* ---------- products ---------- */
function meta(p) {
  const m = { source: "nocera-counter" };
  if (p.sku) m.sku = p.sku;
  if (p.category) m.category = p.category;
  return m;
}
// Creates or updates the product in Stripe. Returns the columns to store.
async function syncProduct(p, currency, imageUrl) {
  const cur = currency.toLowerCase();
  const amt = toMinor(p.price, cur);
  const images = imageUrl ? [imageUrl] : undefined;
  if (!p.stripe_product_id) {
    const prod = await stripe.products.create({
      name: p.name,
      ...(p.description ? { description: p.description } : {}),
      ...(images ? { images } : {}),
      metadata: meta(p),
      default_price_data: { currency: cur, unit_amount: amt },
    });
    return { stripe_product_id: prod.id, stripe_price_id: prod.default_price, stripe_amount: amt, stripe_currency: cur };
  }
  const out = {};
  const upd = { name: p.name, metadata: meta(p), description: p.description || "", ...(images ? { images } : {}) };
  const priceChanged = !p.stripe_price_id || p.stripe_amount !== amt || (p.stripe_currency || cur) !== cur;
  if (priceChanged) {
    const np = await stripe.prices.create({ product: p.stripe_product_id, currency: cur, unit_amount: amt });
    upd.default_price = np.id;
    Object.assign(out, { stripe_price_id: np.id, stripe_amount: amt, stripe_currency: cur });
  }
  await stripe.products.update(p.stripe_product_id, upd);
  if (priceChanged && p.stripe_price_id) {
    await stripe.prices.update(p.stripe_price_id, { active: false }).catch(e => console.warn("Old price not archived:", errText(e)));
  }
  return out;
}

/* ---------- checkout ---------- */
async function createCheckout({ lines, discount, subtotal, total, currency, staff, successUrl }) {
  const cur = currency.toLowerCase();
  const line_items = lines.map(({ p, qty }) => {
    const amt = toMinor(p.price, cur);
    return p.stripe_price_id && p.stripe_amount === amt && (p.stripe_currency || cur) === cur
      ? { price: p.stripe_price_id, quantity: qty }
      : { price_data: { currency: cur, unit_amount: amt, product_data: { name: p.name } }, quantity: qty };
  });
  const params = {
    mode: "payment",
    line_items,
    submit_type: "pay",
    success_url: successUrl,
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
    metadata: { source: "nocera-counter", staff: staff.name },
    payment_intent_data: { description: "Nocera Gifts counter sale", metadata: { source: "nocera-counter" } },
  };
  if (discount > 0) {
    const coupon = await stripe.coupons.create({ amount_off: toMinor(discount, cur), currency: cur, duration: "once", max_redemptions: 1, name: "Counter discount" });
    params.discounts = [{ coupon: coupon.id }];
  }
  const ses = await stripe.checkout.sessions.create(params);
  const items = lines.map(({ p, qty }) => ({ productId: p.id, name: p.name, sku: p.sku, category: p.category, price: Number(p.price), qty }));
  await q(`INSERT INTO checkouts (id, url, expires_at, items, subtotal, discount, total, currency, staff_id, staff_name)
           VALUES ($1,$2,to_timestamp($3),$4,$5,$6,$7,$8,$9,$10)`,
    [ses.id, ses.url, ses.expires_at, JSON.stringify(items), subtotal, discount, total, currency, staff.id, staff.name]);
  return { id: ses.id, url: ses.url, expiresAt: ses.expires_at * 1000, total, amountTotal: ses.amount_total != null ? fromMinor(ses.amount_total, cur) : total };
}

// Turns a paid checkout into an order exactly once. Returns the order row.
async function finalize(sessionId, ses) {
  return tx(async c => {
    const r = await c.query("SELECT * FROM checkouts WHERE id=$1 FOR UPDATE", [sessionId]);
    const ck = r.rows[0];
    if (!ck) return null;
    if (ck.order_id) {
      const o = await c.query("SELECT * FROM orders WHERE id=$1", [ck.order_id]);
      return o.rows[0] || null;
    }
    const cur = ck.currency;
    const total = ses && ses.amount_total != null ? fromMinor(ses.amount_total, cur) : Number(ck.total);
    const pi = ses && (typeof ses.payment_intent === "string" ? ses.payment_intent : ses.payment_intent && ses.payment_intent.id) || null;
    const id = "o_" + sessionId.slice(-20);
    const ins = await c.query(`INSERT INTO orders (id, no, created_at, staff_id, staff_name, items, subtotal, discount, total, method, received, change, currency, stripe_session_id, stripe_payment_intent)
      VALUES ($1, nextval('order_no_seq'), now(), $2,$3,$4,$5,$6,$7,'stripe',$7,0,$8,$9,$10) RETURNING *`,
      [id, ck.staff_id, ck.staff_name, JSON.stringify(ck.items), ck.subtotal, ck.discount, total, cur, sessionId, pi]);
    await c.query("UPDATE checkouts SET status='paid', order_id=$2, checked_at=now() WHERE id=$1", [sessionId, id]);
    return ins.rows[0];
  });
}

// Looks at Stripe directly (used when the webhook has not arrived yet).
async function refresh(sessionId) {
  const ses = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["payment_intent"] });
  await q("UPDATE checkouts SET checked_at=now() WHERE id=$1", [sessionId]);
  if (ses.status === "complete" && (ses.payment_status === "paid" || ses.payment_status === "no_payment_required")) {
    await finalize(sessionId, ses);
  } else if (ses.status === "expired") {
    await q("UPDATE checkouts SET status=CASE WHEN status='cancelled' THEN 'cancelled' ELSE 'expired' END WHERE id=$1 AND status IN ('open','cancelled')", [sessionId]);
  } else {
    const le = ses.payment_intent && typeof ses.payment_intent === "object" && ses.payment_intent.last_payment_error;
    const msg = le ? (le.message || le.decline_code || le.code || "") : "";
    await q("UPDATE checkouts SET last_error=$2 WHERE id=$1", [sessionId, msg]);
  }
}

async function cancel(sessionId) {
  try {
    await stripe.checkout.sessions.expire(sessionId);
    await q("UPDATE checkouts SET status='cancelled' WHERE id=$1 AND status='open'", [sessionId]);
  } catch (e) {
    // Already paid or already expired: let refresh() settle it.
    await refresh(sessionId);
  }
}

function constructEvent(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw Object.assign(new Error("STRIPE_WEBHOOK_SECRET is not set."), { status: 500 });
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

async function handleEvent(evt) {
  const ses = evt.data && evt.data.object;
  if (!ses || ses.object !== "checkout.session") return;
  const known = await q("SELECT 1 FROM checkouts WHERE id=$1", [ses.id]);
  if (!known.rowCount) return; // not a counter checkout
  if (evt.type === "checkout.session.completed" || evt.type === "checkout.session.async_payment_succeeded") {
    if (ses.payment_status === "paid" || ses.payment_status === "no_payment_required") await finalize(ses.id, ses);
  } else if (evt.type === "checkout.session.expired") {
    await q("UPDATE checkouts SET status=CASE WHEN status='cancelled' THEN 'cancelled' ELSE 'expired' END WHERE id=$1 AND status IN ('open','cancelled')", [ses.id]);
  } else if (evt.type === "checkout.session.async_payment_failed") {
    await q("UPDATE checkouts SET last_error='The payment failed.' WHERE id=$1", [ses.id]);
  }
}

module.exports = { enabled, stripe, syncProduct, createCheckout, refresh, cancel, finalize, constructEvent, handleEvent, errText, toMinor, fromMinor };
