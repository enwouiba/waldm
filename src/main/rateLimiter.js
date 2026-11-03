'use strict';

// Token-bucket rate limiter shared across every active connection so the speed
// cap is global, not per-segment. bytesPerSec === 0 (or Infinity) means no cap.
class RateLimiter {
  constructor(bytesPerSec = 0) {
    this._waiters = [];
    this.tokens = undefined;
    this.last = Date.now();
    this.setLimit(bytesPerSec);
    if (this.tokens === undefined) this.tokens = this.capacity;
  }

  setLimit(bytesPerSec) {
    const bps = Number(bytesPerSec) || 0;
    this.rate = bps > 0 ? bps : Infinity;
    // Allow a 1-second burst so bursty writers are not starved.
    this.capacity = this.rate === Infinity ? Infinity : this.rate;
    if (this.tokens === undefined || this.tokens > this.capacity) {
      this.tokens = this.capacity;
    }
    this._drain();
  }

  _refill() {
    if (this.rate === Infinity) return;
    const now = Date.now();
    const elapsed = (now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
  }

  _drain() {
    if (this.rate === Infinity) {
      const waiters = this._waiters.splice(0);
      waiters.forEach((w) => w.resolve());
      return;
    }
    this._refill();
    while (this._waiters.length) {
      const w = this._waiters[0];
      if (this.tokens >= w.cost) {
        this.tokens -= w.cost;
        this._waiters.shift();
        w.resolve();
      } else {
        break;
      }
    }
    if (this._waiters.length && !this._timer) {
      const need = this._waiters[0].cost - this.tokens;
      const ms = Math.max(5, (need / this.rate) * 1000);
      this._timer = setTimeout(() => {
        this._timer = null;
        this._drain();
      }, ms);
    }
  }

  // Resolve once `bytes` worth of tokens are available.
  consume(bytes) {
    if (this.rate === Infinity || bytes <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      // A single chunk can exceed one second of budget; cap the cost so we
      // never deadlock waiting for more tokens than the bucket can hold.
      const cost = Math.min(bytes, this.capacity);
      this._waiters.push({ cost, resolve });
      this._drain();
    });
  }
}

module.exports = { RateLimiter };
