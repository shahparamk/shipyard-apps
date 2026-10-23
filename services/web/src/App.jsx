import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

const POLL_MS = 2000
const HISTORY_POINTS = 30 // 30 polls x 2s = last 60 seconds
const STAGE_MS = 650 // time for a particle to cross one link

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `HTTP ${res.status}`)
  }
  return res.json()
}

// Stable color per pod name, so each pod keeps its color everywhere on the page
function hueFor(name = '') {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

function formatMs(ms) {
  if (!ms) return '—'
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

// Smoothly animates a number toward its new value
function useAnimatedNumber(target, duration = 600) {
  const [value, setValue] = useState(target)
  const current = useRef(target)
  useEffect(() => {
    const from = current.current
    if (from === target) return undefined
    const start = performance.now()
    let frame
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration)
      const next = from + (target - from) * (1 - Math.pow(1 - t, 3))
      current.current = next
      setValue(next)
      if (t < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target, duration])
  return value
}

function Stat({ label, value, format, hint }) {
  const shown = useAnimatedNumber(value)
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{format ? format(shown) : Math.round(shown)}</span>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  )
}

function Sparkline({ points }) {
  const w = 300
  const h = 56
  const padded = [...Array(Math.max(0, HISTORY_POINTS - points.length)).fill(0), ...points]
  const max = Math.max(1, ...padded)
  const step = w / (HISTORY_POINTS - 1)
  const coords = padded
    .map((p, i) => `${(i * step).toFixed(1)},${(h - (p / max) * (h - 8) - 4).toFixed(1)}`)
    .join(' ')
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon className="spark-area" points={`0,${h} ${coords} ${w},${h}`} />
      <polyline className="spark-line" points={coords} />
    </svg>
  )
}

const NODES = [
  { id: 'browser', label: 'Browser', icon: '🖥️' },
  { id: 'api', label: 'Orders API', icon: '⚙️' },
  { id: 'queue', label: 'SQS queue', icon: '📬' },
  { id: 'worker', label: 'Workers', icon: '🛠️' },
  { id: 'db', label: 'Postgres', icon: '🗄️' },
]
// Which links each particle travels: "in" = new order, "out" = processed order
const LINKS = { in: [0, 1], out: [2, 3] }

function Pipeline({ particles, pending, workerCount, total }) {
  const badges = { queue: pending, worker: workerCount, db: total }
  return (
    <div className="pipeline">
      {NODES.map((node, i) => (
        <div className="pipe-segment" key={node.id}>
          <div className={`pipe-node ${node.id === 'queue' && pending > 0 ? 'busy' : ''}`}>
            <span className="pipe-icon" aria-hidden="true">{node.icon}</span>
            <span className="pipe-label">{node.label}</span>
            {badges[node.id] !== undefined && <span className="pipe-badge">{badges[node.id]}</span>}
          </div>
          {i < NODES.length - 1 && (
            <div className="pipe-link">
              {particles
                .filter((p) => LINKS[p.kind].includes(i))
                .map((p) => (
                  <span
                    key={`${p.id}-${i}`}
                    className={`particle ${p.kind}`}
                    style={{
                      animationDuration: `${STAGE_MS}ms`,
                      animationDelay: `${p.delay + LINKS[p.kind].indexOf(i) * STAGE_MS}ms`,
                    }}
                  />
                ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function countBy(values) {
  return values.reduce((acc, v) => {
    if (v) acc[v] = (acc[v] || 0) + 1
    return acc
  }, {})
}

export default function App() {
  const [orders, setOrders] = useState([])
  const [info, setInfo] = useState(null)
  const [apiPods, setApiPods] = useState({}) // pod name -> polls answered
  const [particles, setParticles] = useState([])
  const [history, setHistory] = useState([]) // orders processed per poll
  const [flash, setFlash] = useState({ added: new Set(), done: new Set() })
  const [item, setItem] = useState('widget')
  const [quantity, setQuantity] = useState(1)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const known = useRef(null) // order id -> status from the previous poll

  // Launch animated dots; "extraDelay" lets a processed dot wait for its intake dot
  const spawn = useCallback((kind, ids, extraDelay = () => 0) => {
    if (ids.length === 0) return
    const batch = ids.map((id, n) => ({ id: `${kind}-${id}`, kind, delay: n * 90 + extraDelay(id) }))
    setParticles((current) => [...current, ...batch])
    const lifetime = Math.max(...batch.map((b) => b.delay)) + STAGE_MS * 2 + 300
    setTimeout(() => {
      const finished = new Set(batch.map((b) => b.id))
      setParticles((current) => current.filter((p) => !finished.has(p.id)))
    }, lifetime)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [latestOrders, latestInfo] = await Promise.all([api('/api/orders'), api('/api/info')])
      const previous = known.current
      if (previous) {
        const added = latestOrders.filter((o) => !previous.has(o.id)).map((o) => o.id)
        const done = latestOrders
          .filter((o) => o.status === 'processed' && previous.get(o.id) !== 'processed')
          .map((o) => o.id)
        const addedSet = new Set(added)
        spawn('in', added)
        spawn('out', done, (id) => (addedSet.has(id) ? STAGE_MS * 2 : 0))
        setFlash({ added: addedSet, done: new Set(done) })
        setHistory((h) => [...h, done.length].slice(-HISTORY_POINTS))
      }
      known.current = new Map(latestOrders.map((o) => [o.id, o.status]))
      setOrders(latestOrders)
      setInfo(latestInfo)
      setApiPods((seen) => ({ ...seen, [latestInfo.pod]: (seen[latestInfo.pod] || 0) + 1 }))
      setError('')
    } catch (err) {
      setError(`API unreachable: ${err.message}`)
    }
  }, [spawn])

  useEffect(() => {
    // First poll right away, but scheduled (not called synchronously inside the effect)
    const first = setTimeout(refresh, 0)
    const timer = setInterval(refresh, POLL_MS)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [refresh])

  async function placeOrders(count) {
    setBusy(true)
    try {
      await Promise.all(
        Array.from({ length: count }, (_, n) =>
          api('/api/orders', {
            method: 'POST',
            body: JSON.stringify({
              item: count > 1 ? `${item}-${n + 1}` : item,
              quantity: Number(quantity),
            }),
          })
        )
      )
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  // ---------- Derived numbers ----------
  const total = orders.reduce((max, o) => Math.max(max, o.id), 0) // ids are sequential
  const pending = orders.filter((o) => o.status === 'pending').length
  const processedOrders = orders.filter((o) => o.processed_at)
  const avgLatency = processedOrders.length
    ? processedOrders.reduce((sum, o) => sum + (new Date(o.processed_at) - new Date(o.created_at)), 0) /
      processedOrders.length
    : 0
  const perMinute = history.length
    ? (history.reduce((a, b) => a + b, 0) * 60000) / (history.length * POLL_MS)
    : 0
  const workers = Object.entries(countBy(orders.map((o) => o.processed_by))).sort((a, b) => b[1] - a[1])
  const maxWorker = Math.max(1, ...workers.map(([, n]) => n))

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>ShipYard · Orders</h1>
          <p>Live view of an orders platform running on AWS EKS</p>
        </div>
        <div className="header-right">
          <span className={`pill ${error ? 'offline' : ''}`}>
            <span className="dot" />
            {error ? 'OFFLINE' : 'LIVE'}
          </span>
          {info && <span className="badge">version {info.version.slice(0, 7)}</span>}
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      <div className="stats">
        <Stat label="Orders placed" value={total} hint="all time" />
        <Stat label="In queue" value={pending} hint="waiting for a worker" />
        <Stat label="Avg latency" value={avgLatency} format={formatMs} hint="order placed → processed" />
        <Stat label="Throughput" value={perMinute} format={(v) => `${Math.round(v)}/min`} hint="last 60 seconds" />
      </div>

      <section className="card" style={{ marginBottom: 16 }}>
        <h2>Live pipeline</h2>
        <Pipeline particles={particles} pending={pending} workerCount={workers.length} total={total} />
        <div className="legend">
          <span><i className="in" /> new order → API → queue</span>
          <span><i className="out" /> worker processed → saved to Postgres</span>
        </div>
      </section>

      <div className="grid">
        <section className="card">
          <h2>Place an order</h2>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault()
              placeOrders(1)
            }}
          >
            <label>
              Item
              <input value={item} maxLength={90} required onChange={(e) => setItem(e.target.value)} />
            </label>
            <label>
              Quantity
              <input
                type="number"
                min={1}
                max={1000}
                required
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </label>
            <div className="buttons">
              <button type="submit" disabled={busy}>Place order</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => placeOrders(10)}>
                Burst ×10
              </button>
            </div>
          </form>

          <h3>Orders processed (last 60s)</h3>
          <Sparkline points={history} />
        </section>

        <section className="card">
          <h2>Platform</h2>
          {info ? (
            <dl className="kv">
              <dt>Served by pod</dt>
              <dd>{info.pod}</dd>
              <dt>On node</dt>
              <dd>{info.node}</dd>
              <dt>Image version</dt>
              <dd>{info.version}</dd>
            </dl>
          ) : (
            <p className="muted">Connecting…</p>
          )}

          <h3>API pods answering (load balancing)</h3>
          <ul className="chips">
            {Object.entries(apiPods).map(([pod, hits]) => (
              <li
                key={pod}
                className={`chip ${info?.pod === pod ? 'active' : ''}`}
                style={{ '--hue': hueFor(pod) }}
                title={pod}
              >
                <span className="chip-dot" key={hits} />
                <span>{pod}</span>
                <span className="chip-count">{hits}</span>
              </li>
            ))}
          </ul>

          <h3>Workers sharing the load (last 50 orders)</h3>
          <ul className="lanes">
            {workers.length === 0 && <li className="muted">No orders processed yet</li>}
            {workers.map(([pod, count]) => (
              <li className="lane" key={pod}>
                <span className="lane-name" title={pod}>{pod}</span>
                <div className="lane-track">
                  <div className="lane-bar" style={{ width: `${(count / maxWorker) * 100}%`, '--hue': hueFor(pod) }} />
                </div>
                <span className="lane-count">{count}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="card">
        <h2>
          Orders <span className="muted">({pending} pending)</span>
        </h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Item</th>
                <th>Qty</th>
                <th>Status</th>
                <th>Processed by</th>
                <th>Latency</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr
                  key={o.id}
                  className={`${flash.added.has(o.id) ? 'row-new' : ''} ${flash.done.has(o.id) ? 'row-done' : ''}`}
                >
                  <td>{o.id}</td>
                  <td>{o.item}</td>
                  <td>{o.quantity}</td>
                  <td>
                    <span className={`status ${o.status}`}>
                      {o.status === 'processed' ? '✓ processed' : 'pending'}
                    </span>
                  </td>
                  <td className="mono">
                    {o.processed_by ? (
                      <>
                        <span className="worker-dot" style={{ '--hue': hueFor(o.processed_by) }} />
                        {o.processed_by}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{o.processed_at ? formatMs(new Date(o.processed_at) - new Date(o.created_at)) : '…'}</td>
                  <td>{new Date(o.created_at).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}