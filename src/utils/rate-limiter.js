/**
 * Simple rate limiter that ensures a minimum delay between API calls.
 * Used to respect ShipStation (40/min), Shopify (2/sec), and UPS rate limits.
 */
class RateLimiter {
  constructor(minDelayMs) {
    this.minDelay = minDelayMs;
    this.lastCall = 0;
  }

  async wait() {
    const now = Date.now();
    const elapsed = now - this.lastCall;
    if (elapsed < this.minDelay) {
      await new Promise(resolve => setTimeout(resolve, this.minDelay - elapsed));
    }
    this.lastCall = Date.now();
  }
}

// Pre-configured limiters
const shipstationLimiter = new RateLimiter(1500); // ~40/min
const shopifyLimiter = new RateLimiter(550);       // ~2/sec with buffer
const upsLimiter = new RateLimiter(150);           // generous buffer

module.exports = { RateLimiter, shipstationLimiter, shopifyLimiter, upsLimiter };
