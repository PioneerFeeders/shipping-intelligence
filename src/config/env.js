require('dotenv').config();

const required = [
  'DATABASE_URL',
  'SHIPSTATION_API_KEY',
  'SHIPSTATION_API_SECRET',
  'SHOPIFY_STORE_URL',
  'SHOPIFY_ACCESS_TOKEN',
  'UPS_CLIENT_ID',
  'UPS_CLIENT_SECRET',
];

const missing = required.filter(key => !process.env[key]);
if (missing.length > 0 && process.env.NODE_ENV === 'production') {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL,

  shipstation: {
    apiKey: process.env.SHIPSTATION_API_KEY,
    apiSecret: process.env.SHIPSTATION_API_SECRET,
    v2ApiKey: process.env.SHIPSTATION_V2_API_KEY,
    baseUrl: 'https://ssapi.shipstation.com',
  },

  shopify: {
    storeUrl: process.env.SHOPIFY_STORE_URL,
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
    apiVersion: '2024-10',
  },

  ups: {
    clientId: process.env.UPS_CLIENT_ID,
    clientSecret: process.env.UPS_CLIENT_SECRET,
    accountNda: process.env.UPS_ACCOUNT_NDA || 'R1833C066',
    accountGround: process.env.UPS_ACCOUNT_GROUND || 'J9299A036',
    tokenUrl: 'https://onlinetools.ups.com/security/v1/oauth/token',
    trackingUrl: 'https://onlinetools.ups.com/api/track/v1/details',
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
  },
};
