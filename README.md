# Pioneer Feeders — Shipping Intelligence Platform

Single source of truth for all shipping operations. Captures shipment data from ShipStation in real-time, enriches with Shopify order details and UPS delivery tracking, and reconciles against weekly UPS invoices.

## Architecture

- **Node.js + Express** API server
- **PostgreSQL** database (Railway)
- **ShipStation** SHIP_NOTIFY webhook → real-time shipment logging
- **Shopify** Admin API → order details + COGS
- **UPS** REST API → delivery tracking + promised delivery dates
- **Daily cron** → polls UPS for delivery status updates

## Setup

### 1. Clone and install
```bash
git clone https://github.com/pioneer-feeders/shipping-intelligence.git
cd shipping-intelligence
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your credentials
```

### 3. Run migrations
```bash
npm run migrate
```

### 4. Start the server
```bash
npm start
# or for development with auto-reload:
npm run dev
```

### 5. Register ShipStation webhook
Point the SHIP_NOTIFY webhook to: `https://your-app.railway.app/webhooks/shipstation`

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/webhooks/shipstation` | ShipStation SHIP_NOTIFY webhook |
| POST | `/invoices/upload` | Upload parsed UPS invoice CSV |
| GET | `/invoices/unmatched` | View unmatched invoice line items |
| GET | `/api/shipments` | Query shipments (filterable) |
| GET | `/api/orders` | Query orders |
| GET | `/api/reconciliation` | Full reconciliation view |
| GET | `/api/stats` | Summary statistics |
| POST | `/admin/poll-tracking` | Manually trigger UPS tracking poll |

## Railway Deployment

1. Connect GitHub repo to Railway
2. Add PostgreSQL add-on
3. Set environment variables (see `.env.example`)
4. Deploy from `main` branch

## Weekly Workflow

1. Labels are created in ShipStation throughout the week → automatically logged
2. End of week: download UPS invoice CSVs (Ground + NDA)
3. Upload each CSV to `POST /invoices/upload`
4. View reconciliation at `GET /api/reconciliation?start_date=...&end_date=...`
