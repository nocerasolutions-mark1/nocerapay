# Nocera Gifts Counter (billing.noceragifts.com)

In-store billing for Nocera Gifts: product catalogue with photos, cart checkout, Stripe QR payments, cash and bank QR, sales reports, and Excel and Shopify exports. Staff sign in with a PIN.

Runs on Railway as one Node.js service, with Railway Postgres for data and a Railway Bucket for photos.

## What's in here

| Path | What it is |
|---|---|
| `server/index.js` | The web server and API |
| `server/db.js` | Postgres connection and tables (created automatically on start) |
| `server/auth.js` | Staff PIN login, sessions, lockout after 5 wrong PINs |
| `server/stripe.js` | Stripe product sync, checkout QR, payment confirmation |
| `server/storage.js` | Photo storage in the Railway Bucket |
| `public/` | The Counter app screens |
| `railway.json` | Railway start command and health check |

## Deploy, step by step

### 1. Put the code on GitHub
1. Create a **private** repository on GitHub, for example `nocera-billing`.
2. Upload everything in this folder (Add file → Upload files). Don't upload `node_modules` or `nocera-import.json`.

### 2. Create the Railway project
1. In Railway: **New Project → Deploy from GitHub repo**, and pick `nocera-billing`. The first deploy fails until the variables are set; that's expected.
2. In the project, click **Create → Database → PostgreSQL**.
3. Click **Create → Bucket**. Open the bucket's **Credentials** tab and note whether it says to use path-style URLs.

### 3. Create the Stripe key and webhook
1. Stripe Dashboard → **Developers → API keys → Create restricted key**. Name it `Nocera Counter` and set:
   - Products: **Write**
   - Prices: **Write**
   - Checkout Sessions: **Write**
   - Coupons: **Write**
   - PaymentIntents: **Read**
   - Everything else: None

   Copy the key (`rk_live_…`).
2. Stripe Dashboard → **Developers → Webhooks → Add endpoint**:
   - Endpoint URL: `https://billing.noceragifts.com/api/stripe/webhook`
   - Events:
     - `checkout.session.completed`
     - `checkout.session.expired`
     - `checkout.session.async_payment_succeeded`
     - `checkout.session.async_payment_failed`

   Copy the **Signing secret** (`whsec_…`).

   If you test with Stripe test mode first, make a separate test-mode restricted key and webhook.

### 4. Set the variables on the web service
Railway → the `nocera-billing` service → **Variables**. Add each one; the "reference" ones come from the **Add Reference** menu.

| Variable | Value |
|---|---|
| `DATABASE_URL` | Reference: Postgres → `DATABASE_URL` |
| `SESSION_SECRET` | A random 40+ character string from a password generator |
| `OWNER_NAME` | `Athif` |
| `OWNER_PIN` | Your 4–8 digit PIN |
| `PUBLIC_URL` | `https://billing.noceragifts.com` |
| `STRIPE_SECRET_KEY` | The `rk_live_…` key |
| `STRIPE_WEBHOOK_SECRET` | The `whsec_…` secret |
| `ENDPOINT`, `REGION`, `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY` | References: Bucket → the variable with the same name |
| `BUCKET_PATH_STYLE` | `true` only if the bucket's Credentials tab says path-style |

Railway redeploys automatically. The deploy log should end with `Created owner login for "Athif"` and `Nocera billing listening on …`.

### 5. Point billing.noceragifts.com at Railway
1. Railway → service → **Settings → Networking → Custom Domain** → enter `billing.noceragifts.com`. Railway shows a **CNAME** target, and sometimes a TXT record too.
2. Add those records wherever noceragifts.com's DNS is managed:
   - If the domain was bought through Shopify: Shopify admin → **Settings → Domains → noceragifts.com → Domain settings → Edit DNS settings → Add custom record**.
   - Otherwise, add them at your domain provider.

   Use name `billing` and paste the CNAME target. This doesn't affect your Shopify store.
3. Wait until Railway shows the domain as active (minutes to a few hours). HTTPS is set up automatically.

### 6. First sign-in and import
1. Open `https://billing.noceragifts.com`, tap your name and enter your PIN.
2. **Settings → Move from the Claude app → Import file**, and choose `nocera-import.json`. It brings over products, photos, past sales and settings, and keeps each product's existing Stripe link so nothing is duplicated in Stripe.
3. **Settings → Staff logins → Add staff**: add Shaheena with her own PIN and the role Staff.
4. On the counter phone or tablet, open the site and choose **Add to Home Screen** so it opens like an app.

### 7. Test one sale
Sell the cheapest item with **Stripe QR**, pay with your own card, and check that the screen turns to **Payment successful**. Then refund it in the Stripe Dashboard.

Then remove `OWNER_PIN` from the variables if you like. It's only used when no staff exist.

## Roles
- **Owner:** everything, including adding and editing products, settings, staff, and exports.
- **Staff:** sell (Stripe QR, cash, bank QR) and see sales and products.

## How Stripe payments work
- Checkout creates a Stripe Checkout Session from the server's own prices (the browser can't change prices) and shows it as a QR. The QR expires after 31 minutes.
- Stripe's webhook confirms payment. As a backup, the server also asks Stripe directly every few seconds while the QR is on screen.
- **Cancel** expires the session in Stripe, so a cancelled QR can't be paid afterwards.
- Removing a product only hides it from the counter; Stripe is never changed.

## Updating
Edit files in GitHub (or upload new versions); Railway redeploys on every change. The database tables update themselves on start.
