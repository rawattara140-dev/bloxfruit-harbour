# Bloxfruit Harbour

Trading values, trade listings and private chat for Blox Fruits players.
Dark gaming UI, responsive from phone to desktop. Node.js + Express + SQLite.

## Quick start

Requires **Node.js 20 or newer**.

```bash
npm install
cp .env.example .env      # then edit .env (see below)
npm start                 # http://localhost:3000
```

On first start the server creates the database file (`data/harbour.db`) and fills it with the starting trading values.

### Make yourself admin

1. Put your username in `.env`: `ADMIN_USERNAMES=yourname`
2. Start the server, open `/register.html` and create that exact username **right away** (before anyone else can).
3. Open the **Values** page. Every item now has an **Edit** button, and there is an **Add item** button. Value changes are logged and show up under "Recent updates" on the home page.
4. **Settings** shows an admin-only "reports" list.

## Database

**SQLite**, through the `better-sqlite3` package. It needs no separate server: the whole database is one file.

| Setting | Where | Default |
| --- | --- | --- |
| File location | `DATABASE_PATH` in `.env` | `./data/harbour.db` |

Tables are created automatically (`lib/db.js`): `users`, `sessions`, `oauth_states`, `items`, `value_history`, `trades`, `trade_items`, `conversations`, `messages`, `reads`, `blocks`, `reports`.

Notes for hosting: keep `data/` on a persistent disk or volume, and back the file up. SQLite is ideal for one server process. If you outgrow it, the SQL is plain and the schema is small, so moving to PostgreSQL later is straightforward.

## Updating values

Values are stored in **millions**: `5K = 0.005`, `600M = 600`, `3.99B = 3990`. The site shows them as K, M or B automatically.

- **One by one:** admin Edit buttons on the Values page.
- **In bulk:** edit `lib/seed-values.js`, then run `npm run sync-values`. It updates existing items, adds new ones, logs changed values under "Recent updates", and leaves items that are not in the file alone.
- **Skins** are items with category `Skin` and a *Base fruit*. `lib/seed-values.js` lists skins that still have no value (`PENDING_SKINS`); add them from the Values page once you have a value, so they never count as 0 in a trade.

## Environment variables

See `.env.example`. **Never commit `.env`** (it is in `.gitignore`).

| Variable | Purpose |
| --- | --- |
| `PORT`, `NODE_ENV`, `BASE_URL` | Server basics. Set `NODE_ENV=production` when live (enables secure cookies and HSTS-friendly settings). |
| `DATABASE_PATH` | SQLite file location. |
| `ADMIN_USERNAMES` | Comma-separated usernames with admin rights. |
| `TRUST_PROXY` | Number of reverse proxies in front of the app (use `1` on most hosts) so rate limits use real IPs. |
| `ROBLOX_CLIENT_ID`, `ROBLOX_CLIENT_SECRET`, `ROBLOX_REDIRECT_URI` | Optional Roblox sign-in. |
| `SUPPORT_EMAILS`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Support account and Google sign-in (see above). |
| `PAYMENT_PROVIDER`, `ALLOW_TEST_PAYMENTS`, `MANUAL_PAYMENT_INSTRUCTIONS` | Store payments (see above). |

There is no session secret to configure: sessions use random 256-bit tokens, and only their SHA-256 hash is stored in the database.

## Roblox connection (optional, official OAuth)

Players never type a Roblox password into this site. The "Connect with Roblox" button sends them to Roblox's own sign-in page (OAuth 2.0 authorization code flow with PKCE). Roblox sends back a one-time code, the **server** exchanges it, reads the public profile (`openid profile` scopes), saves the Roblox ID, username, display name and avatar URL, and discards the access token.

To turn it on:

1. Go to <https://create.roblox.com/dashboard/credentials> and create an **OAuth 2.0 app**.
2. Add the redirect URL, for example `http://localhost:3000/api/auth/roblox/callback` (use your real domain when live). It must match `ROBLOX_REDIRECT_URI` exactly.
3. Select the `openid` and `profile` scopes.
4. Put the client ID and secret in `.env` and restart.

Until those are set, the Settings page shows a clear "not configured" message instead of a broken button. Each Roblox account can be linked to only one Harbour account, and players choose whether it is shown on their public profile.

## Store, support and moderation

**Roles.** There are two staff roles and they are always different accounts:

| Role | How an account gets it | Can do |
| --- | --- | --- |
| **Administrator** | its username is in `ADMIN_USERNAMES` | everything below, plus editing trading values |
| **Support** | its Google account has a **verified** email listed in `SUPPORT_EMAILS` (default `bloxfruitharbour.support@gmail.com`) | tickets, player reports, warn / ban / unban, orders, inventory, read the action log |

Nobody can become Support by typing an email: the role only exists after Google itself confirms the address. No Gmail password is ever requested or stored. The administrator account can never hold the Support role (linking the support email to it is refused), and administrators cannot be warned or banned. Only an administrator can moderate the Support account.

**Set up the Support account**
1. Create a Google OAuth client (see `.env.example`), put `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env`, restart.
2. The person behind `bloxfruitharbour.support@gmail.com` registers a normal Harbour account, then opens **Settings, Google account, Connect Google** and signs in with that Google account.
3. A **Support** button appears in the header and opens `/staff.html`. After that they can also use **Continue with Google** on the login page.
4. Remove or change the email in `SUPPORT_EMAILS` (or press Disconnect in Settings) to take the role away immediately.

**Moderation.** Warn (the player sees it in Settings), Ban (signs them out everywhere at once, closes their open listings, blocks login and hides their profile) and Unban. Every moderator action is written to the action log with **who did it, to whom, what, and when** (warn, ban, unban, ticket status, order status, report resolved, stock and price changes). The log is append-only: the API has no edit or delete route, and database triggers reject changes to existing rows.

**Store.** Every item has a name, image, price in NPR (whole rupees, shown as "Rs."), stock and availability. Everything starts at **stock 0**, so the store shows OUT OF STOCK until staff add stock. An item cannot be put in stock without a price. Buying: stock is reserved the moment an order is placed (the update only succeeds if enough stock remains, so overselling is impossible), ordering more than the stock or an out-of-stock item is refused, and cancelling an unpaid order puts the stock back. A buyer can have 3 unpaid orders at a time. Staff order statuses: `pending, paid, processing, completed, cancelled` (completed and cancelled are final; cancelling returns the stock).

**Payments.** All payment logic lives behind `lib/payments.js`. `test` (default in development) simulates payment with no money involved and is switched off in production. `manual` needs no credentials: orders are reserved and staff mark them paid. To add eSewa / Khalti / Fonepay later, add a provider there with `createPayment` and `verifyWebhook`; the callback URL is already reserved at `POST /webhooks/payments/:provider`, and its keys belong in `.env`, never in the frontend.

**Tickets.** `/contact.html` (login required): General problem, Incorrect fruit value, Incorrect fruit price, Trade problem, Store / order problem, Other. Each ticket gets an ID (`T-0001`), the user, category, message, date and a status of Open, In progress or Resolved. Staff manage them in the staff panel.

**Fruit images.** The browser always loads `/img/fruit/:id` from this server, never from the wiki directly. A picture is found once per fruit *name*: an admin-set image link if the item has one, otherwise the lead image of the page with that name on the public Blox Fruits wiki, looked up through its MediaWiki API (up to 20 names per request, one request at a time, 300 ms apart). The answer is saved in the database (table `image_cache`: wiki title, image URL, file, ok/missing) and the picture in `data/img-cache/`, so nothing is asked again, not even after a restart.
- **Startup:** a background job (3 s after start; `IMAGE_WARMUP=0` turns it off) fills any gaps, so the first visitors do not trigger lookups.
- **Not on the wiki:** remembered as "missing" for 24 hours, then checked again.
- **Wiki down or slow:** treated as an outage, not as "missing". All lookups pause for 5 minutes, already cached pictures keep working, and nothing is stored as missing.
- **Picture file lost** (for example after a redeploy with no persistent disk): re-downloaded from the stored URL without asking the API.
- **Consistency:** the key is the normalised name (`T-Rex` and `t rex` both become `name-trex`), not the numeric id. If a wiki page has a different title than the fruit, add it to `TITLE_OVERRIDES` at the top of `lib/images.js`.
- **Fallbacks:** the item's own picture, then its base fruit's picture (skins), then a generic icon, then the first letter. Only https links on the wiki or `*.rbxcdn.com` are accepted and SVG is refused. Editing an item's name or image link clears its cached entry.
- Values, demand and every other item field are never touched by the image code.

## Pages

| Page | Access | What it does |
| --- | --- | --- |
| `/index.html` | public | Hero, live search suggestions, special item values, featured/popular items, recent updates |
| `/values.html` | public | Search, category/rarity filters, sorting, demand and trend, quick add to trade, admin editing |
| `/trading.html` | public (posting needs login) | Trade checker, fruit picker, create listings, browse and search listings |
| `/chat.html` | login required | Private one-to-one chat |
| `/profile.html` | own profile needs login, `?u=name` is public | Roblox info, listings, trading activity |
| `/store.html` | public (buying needs login) | Fruit store: NPR prices, stock, BUY NOW / OUT OF STOCK, your orders |
| `/contact.html` | login required to send | Contact / report a problem tickets |
| `/staff.html` | administrator or Support | Tickets, orders, inventory, player reports, warn / ban / unban, action log |
| `/settings.html` | login required | Profile, Roblox connection, password, blocked players, delete account, admin reports |
| `/login.html`, `/register.html` | public | Account forms |

## API overview

All routes are under `/api`. Responses are JSON. State-changing requests must send the `X-BH-CSRF: 1` header and come from the same origin (the site's own pages do this automatically).

| Area | Routes |
| --- | --- |
| Auth | `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `GET /auth/roblox/start`, `GET /auth/roblox/callback`, `POST /auth/roblox/disconnect` |
| Values | `GET /values`, `GET /values/updates`, admin: `POST /values`, `PUT /values/:id`, `DELETE /values/:id` |
| Trades | `GET /trades`, `POST /trades`, `PATCH /trades/:id`, `DELETE /trades/:id` |
| Profiles | `GET /profile/me`, `PATCH /profile/me`, `GET /users/:username`, `POST /account/password`, `DELETE /account` |
| Chat | `GET /chat/conversations`, `POST /chat/conversations`, `GET /chat/conversations/:id/messages`, `POST /chat/conversations/:id/messages`, `POST /chat/conversations/:id/read`, `GET /chat/unread`, `GET /chat/stream` (live updates) |
| Store | `GET /store`, `POST /store/orders`, `GET /store/orders`, `POST /store/orders/:id/cancel`, `POST /store/orders/:id/pay-test` (test provider only) |
| Tickets | `POST /tickets`, `GET /tickets`, `GET /tickets/categories` |
| Staff | `GET/PATCH /staff/inventory[/:id]`, `GET/PATCH /staff/orders[/:id]`, `GET/PATCH /staff/tickets[/:id]`, `GET /staff/users`, `POST /staff/users/:username/warn\|ban\|unban`, `GET /staff/log`, `GET /account/warnings` |
| Google | `GET /auth/google/start`, `GET /auth/google/callback`, `POST /auth/google/disconnect` |
| Safety | `GET/POST /blocks`, `DELETE /blocks/:username`, `POST /reports`, admin: `GET /admin/reports`, `PATCH /admin/reports/:id` |

## How private chat works

- Each pair of users has at most one conversation. Every message route checks that the logged-in user is one of the two participants; anyone else gets a generic "not found".
- Messages are cleaned on the server (control and hidden direction characters removed, 1000 character limit) and only ever shown with `textContent`, never as HTML.
- Live delivery uses server-sent events. The page reconnects automatically and catches up on missed messages.
- Unread counts are tracked per user and shown in the conversation list and in the navbar.
- **Block:** neither side can start a chat or send messages. The blocked person only sees a generic "can't be sent" error, so blocking is not revealed.
- **Report:** the reporter picks a reason; the last 10 messages of that one conversation are copied into the report so admins can review. Admins have no other way to read private messages, and there is no admin message viewer.
- **Bad-word filter:** every message is checked on the server (`lib/badwords.js`) before it is saved. Clean messages are sent; flagged ones are rejected with a warning and nothing is stored or delivered. It matches whole words and catches case, leetspeak, stretched letters and spaced-out letters. Edit the `BLOCKED` list in that file to change it.
- Rate limits: 30 messages per minute, 20 new chats per hour, 10 reports per hour (per user).

## Security summary

- Passwords hashed with **scrypt** (random salt, constant-time comparison). Never stored or logged in plain text.
- Sessions: random token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production); only a hash is stored server-side.
- CSRF: custom header requirement plus same-origin check on every state-changing API call.
- Content Security Policy via Helmet: scripts and styles only from this site (plus Google Fonts), no inline scripts, avatars only from `*.rbxcdn.com`.
- All input validated on the server; SQL uses prepared statements only.
- Rate limiting on auth, messages, new chats, reports and listings, plus a general API limit.
- Protected pages (`chat`, `settings`, own `profile`) redirect to login without a session; protected API routes return 401.
- No secrets in front-end code. Roblox client secret stays on the server.
- Login errors are identical for unknown user and wrong password.

Known limits: there is no email, so **no password reset** (an admin cannot reset one either; players must remember their password). Live chat uses in-memory connections, so run **one server process** (or add a shared pub/sub layer before scaling out).

## Project layout

```
public/            pages, css/, js/, assets/
server.js          Express app: auth, values, trades, profiles, chat, reports
lib/db.js          SQLite schema and first-run seeding
lib/seed-values.js starting trading values (also used by `npm run sync-values`)
lib/store.js       store, orders, inventory
lib/support.js     tickets, warn / ban / unban, action log
lib/google.js      Google sign-in
lib/payments.js    payment providers (test, manual, future Nepal providers)
lib/images.js      fruit image cache
lib/badwords.js    chat bad-word filter
scripts/           sync-values.js
.env.example
```

Extra files compared with the requested structure: `public/js/trading.js` (the Trading page needs its own logic), `lib/db.js` (keeps the schema out of `server.js`) and `lib/seed-values.js` (starting values).

## What changed from the original single-file site

**Kept:** Bloxfruit Harbour branding, the fruit list and its value numbers (1 old value point is now 1M), the trade checker with give/get panels, quantities, totals, swap/clear/copy, the fruit picker with search, and the trade post text.

**New:** multi-page layout with shared navbar and footer, accounts, admin-managed values with history, demand/trend/category data, Purple Lightning (5.52B) and Green Lightning (330M), listings board, private chat with block/report, profiles, settings, optional Roblox OAuth, and the whole backend and database.

**Replaced with better versions:**
- Per-browser "Edit values" is replaced by admin-managed values on the server, so everyone sees the same numbers.
- Locally saved posts are replaced by real listings stored in the database.
- The fruit data now lives in the database instead of in front-end code.

**Starting data you should review:** all trends start at "stable". Types and rarities for fruits that were not in the earlier list (West/East Dragon, Magnet, Yeti, Tiger, Gas, Lightning, Eagle) are blank or guessed. Edit anything from the Values page as an admin.
