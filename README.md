# Project API (goals-server)

REST API to manage categories, cards, transactions, budgets, accounts, savings plans, scheduled payments and statistics. Built with Node.js, Express and Sequelize on top of MySQL.

## Requirements
- Node.js 18 or 20 (recommended)
- MySQL 8.x (or compatible)
- npm or yarn

## Installation
1. Clone the repository and go into the `goals-server` directory.
2. Install dependencies:
   - `npm install` or `yarn install`

## Configuration (.env)
Create a `.env` file in `goals-server/` with these variables:

```
# Database (you can use either the MYSQL* or the DB_* prefix)
DB_HOST=localhost
DB_PORT=3306
DB_DATABASE=pg-system
DB_USER=root
DB_PASSWORD=your_password

# JWT
SECRET_KEY=a_secure_secret

# Server
PORT=4000

# Email (verification and password reset)
EMAIL_HOST=smtp.your-provider.com
EMAIL_PORT=587
EMAIL_SECURE=false
EMAIL_USER=no-reply@your-domain.com
EMAIL_PASS=your_email_password
FRONTEND_URL=http://localhost:5173

# Super-admin bootstrap (optional)
BOOTSTRAP_SECRET=a_one_off_secret
```

Notes:
- The code supports both the `MYSQL*` prefix (common on managed providers) and `DB_*`.
- `SECRET_KEY` is required to sign and verify JWTs.
- The `EMAIL_*` variables and `FRONTEND_URL` are required by the email-verification and password-reset flows (`src/utils/mail.js`). Without them registration still succeeds, but sending the verification email throws and is only logged.
- `BOOTSTRAP_SECRET` protects `POST /auth/bootstrap`, which promotes an existing user to super admin.

## Database
Initialize the schema with the included SQL script:

```
mysql -u root -p < sql/create_pg-system.sql
```

The script creates the `pg-system` database and the core tables (`Users`, `Categories`, `Cards`, `Transactions`, `Budgets`) with Sequelize-compatible indexes and foreign keys.

The remaining tables (`Accounts`, `SavingsPlans`, `SavingsContributions`, `ScheduledPayments`) are created by Sequelize on boot: `connectDB()` in `src/config/db.js` runs `sequelize.sync()` and then a set of guarded migrations (adds missing columns, widens ENUMs, backfills `publicId` UUIDs, marks pre-existing users as email-verified). There are no separate migration files — when you add a column to a model, add the matching guard inside `connectDB()`.

## Running in development
- `npm run dev` (uses nodemon)
- The server starts on `http://localhost:4000` by default.

## Running in production
- `npm start`
- Make sure you are on Node 18+ (ideally 20) and that `.env` is configured.

The HTTP listener starts **before** the database handshake and migrations, on purpose: on Passenger-style hosting (Hostinger/LiteSpeed) a delayed `app.listen()` gets the app marked as 503. DB init runs in the background after the listener is up.

## Scheduled payments
`src/cron.js` registers a `node-cron` job at `0 0 * * *` and **also runs once at startup**, to catch up on ticks missed while the process was asleep on shared hosting. Each due `ScheduledPayment` materializes a `Transaction`, and `nextDueDate` is then advanced with calendar-aware logic (it snaps to the last valid day in short months and handles Feb 29 → Feb 28). A payment that fails is auto-paused so it cannot retry silently forever.

## Main endpoints
Base path: `/api`

Authentication (`/api/auth`):
- `POST /auth/register` → `{ name, email, password }` — creates the user and sends the verification email.
- `POST /auth/login` → `{ email, password }` → `{ token, user }`
- `GET /auth/verify-email/:token` — confirms the email address.
- `POST /auth/reset-start` → `{ email }` — sends the reset link (the response does not reveal whether the email exists).
- `POST /auth/reset-password` → `{ token, password }`
- `POST /auth/bootstrap` → `{ email }` with the `BOOTSTRAP_SECRET` in the `Authorization` header — promotes that user to super admin.

Categories (`/api/categories`) [JWT]:
- `GET /` list
- `POST /` create
- `PUT /:id` update
- `DELETE /:id` delete

Cards (`/api/cards`) [JWT]:
- `GET /` list
- `POST /` create
- `PUT /:id` update
- `DELETE /:id` delete

Accounts (`/api/accounts`) [JWT]:
- `GET /` list
- `POST /` create
- `PUT /:id` update
- `DELETE /:id` delete

Transactions (`/api/transactions`) [JWT]:
- `GET /` list (includes category/card/account), sorted by date DESC
- `POST /` create `{ type, description, amount, date, paymentMethod, categoryId?, cardId?, accountId? }`
- `PUT /:id` update
- `DELETE /:id` delete

`paymentMethod` is one of `cash | card | account`, and it determines which of `cardId` / `accountId` is set.

Budgets (`/api/budgets`) [JWT]:
- Standard CRUD; used for "Budget vs Actual" per month and year.

Savings (`/api/savings`) [JWT]:
- `GET /plans`, `POST /plans`, `GET /plans/:id`, `PUT /plans/:id`, `DELETE /plans/:id`
- `GET /plans/:id/summary` → progress for the plan
- `POST /contributions`, `PUT /contributions/:id`, `DELETE /contributions/:id`

Scheduled payments (`/api/scheduled-payments`) [JWT]:
- `GET /` list
- `POST /` create
- `PUT /:id` update
- `DELETE /:id` delete

User (`/api/user`) [JWT]:
- `GET /me` → profile (`publicId`, name, email, `currency`, `language`, `isSuperAdmin`, …)
- `PUT /profile` → `{ name?, email?, currentPassword?, currency?, language? }` — changing the email requires `currentPassword`.
- `POST /change-password` → `{ currentPassword, newPassword }`

Admin (`/api/admin`) [JWT + super admin]:
- `GET /users`, `GET /users/:id`
- `PATCH /users/:id`, `PATCH /users/:id/status`, `PATCH /users/:id/promote`
- `POST /users/:id/reset-password`
- `DELETE /users/:id`

Statistics (`/api/stats`) [JWT]:
- `GET /summary?period=all|YYYY|YYYY-MM` → totals, categories, daily timeseries, payment methods, per card/account and the month's budget. `from` + `to` can be passed instead and take priority over `period`.
- `GET /categories-timeline?period=…[&categoryIds=1,2,3]` → spend per category over time.
- `GET /export?period=all|YYYY-MM` → XLSX file with the sheets: Transactions, Overview, IncomeVsExpenses (monthly), Categories, PerCard and Budget.

Authorization
- Every route except `/auth/*` requires the `Authorization: Bearer <token>` header.
- The `/api/admin` routes additionally re-read the user from the database to confirm super-admin status, instead of trusting the token claim.

## Quick examples
Login:
```
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@example.com","password":"demo"}'
```

Monthly summary:
```
curl -H "Authorization: Bearer <token>" \
  "http://localhost:4000/api/stats/summary?period=2025-03"
```

Monthly XLSX export:
```
curl -H "Authorization: Bearer <token>" \
  -OJ "http://localhost:4000/api/stats/export?period=2025-03"
```

## CORS
`cors()` is enabled with its defaults. Restrict the allowed origins if you need to in stricter deployments.

## Troubleshooting
- Node < 18 can cause build or runtime failures.
- Check your MySQL credentials and that the host/port are reachable.
- On managed providers (e.g. PlanetScale/Zeabur), use the `MYSQLHOST`, `MYSQLPORT`, `MYSQLDATABASE`, `MYSQLUSER`, `MYSQLPASSWORD` variables.
- Registration works but no email arrives: check the `EMAIL_*` variables and `FRONTEND_URL` — the send failure is only logged, never returned to the client.
