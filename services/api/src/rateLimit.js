// Per-client fixed-window rate limiter for the public write endpoint.
//
// Client identity is the LAST X-Forwarded-For entry: the one the ALB appended.
// A client can put anything at the front of that header, so trusting the first
// entry would let anyone dodge the limit by spoofing it.
//
// Requests WITHOUT X-Forwarded-For never came through the public load balancer
// (in-cluster callers such as the k6 load test, probes, or Prometheus), so they
// are not limited.
//
// Limits are per pod (in memory). With N API pods behind the ALB, a client's
// effective limit is up to N x max. Good enough to stop casual abuse of a public
// demo; a shared limit would need Redis, or AWS WAF rate rules at the ALB.

function clientIp(req) {
  const header = req.headers['x-forwarded-for'];
  if (!header) return null;
  const parts = String(header)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

function createRateLimiter({ max = 60, windowMs = 10000, now = () => Date.now(), onLimited = () => {} } = {}) {
  const hits = new Map(); // client ip -> { count, resetAt }

  function sweep(t) {
    for (const [ip, entry] of hits) {
      if (entry.resetAt <= t) hits.delete(ip);
    }
  }

  return function rateLimit(req, res, next) {
    const ip = clientIp(req);
    if (!ip) return next();

    const t = now();
    if (hits.size > 10000) sweep(t); // keep memory bounded

    let entry = hits.get(ip);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(ip, entry);
    }
    entry.count += 1;

    const resetSeconds = Math.max(1, Math.ceil((entry.resetAt - t) / 1000));
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.set('RateLimit-Reset', String(resetSeconds));

    if (entry.count > max) {
      onLimited();
      res.set('Retry-After', String(resetSeconds));
      return res.status(429).json({ error: 'too many orders from this client; try again in a few seconds' });
    }
    return next();
  };
}

module.exports = { createRateLimiter, clientIp };
