import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

const POLL_MS = 2000
const HISTORY_POINTS = 30 // 30 polls x 2s = last 60 seconds
const STAGE_MS = 650 // time for a particle to cross one link
const MAX_PARTICLES_PER_POLL = 20 // keep the animation smooth under heavy load
const FEED_SIZE = 30
const API_ACTIVE_MS = 15000 // an API pod counts as active if it answered recently
const WORKER_ACTIVE_MS = 30000 // a worker counts as active if it finished an order recently
const WORKER_BUSY_MS = 2500 // ...and as busy right now if it finished one in the last poll or so
const LATEST_ROWS = 6
const GITHUB = 'https://github.com/shahparamk'

// ---------- Small helpers ----------
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const err = new Error(body.error || `HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

// Remembered between visits; ignored if the browser blocks storage
function load(key, fallback) {
  try {
    const value = localStorage.getItem(key)
    return value === null ? fallback : JSON.parse(value)
  } catch {
    return fallback
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable: setting just won't persist */
  }
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

// "orders-worker-85fd6f4c6f-hjr27" -> "hjr27" (local container ids stay as they are)
function shortPod(pod = '') {
  const parts = pod.split('-')
  return parts.length > 2 ? parts[parts.length - 1] : pod
}

const isCommitSha = (value) => /^[0-9a-f]{40}$/.test(value || '')

// ---------- Words: the same page in plain language or in cloud terms ----------
const COPY = {
  simple: {
    nodes: { browser: 'Customer', api: 'Order desk', queue: 'Ticket rail', worker: 'Kitchen staff', db: 'Order book' },
    stats: {
      placed: ['Orders placed', 'all time'],
      queue: ['Waiting in line', 'not picked up yet'],
      latency: ['Time to finish', '95% done within'],
      throughput: ['Finished per minute', 'last 60 seconds'],
    },
    apiPods: (n) => `${n} desk${n === 1 ? '' : 's'} answering`,
    workerPods: (n) => `${n} cooking right now`,
    queueText: (n) => `${n} waiting`,
    dbText: (n) => `${n.toLocaleString()} saved`,
    legendIn: 'new order → desk → ticket rail',
    legendOut: 'kitchen finished → written in the order book',
    platform: 'Behind the scenes',
    pods: 'Order desks answering you',
    workers: 'Kitchen staff sharing the work (last 50 orders)',
    feedIn: (e) => `Order #${e.id} (${e.item}) taken at the order desk and put on the ticket rail`,
    feedOut: (e) => `Kitchen staff ${shortPod(e.pod)} finished order #${e.id} in ${formatMs(e.ms)}`,
    feedJoin: (e) =>
      e.role === 'api'
        ? `Another order desk opened (${e.count} open)`
        : `Another kitchen staff member started working (${e.count} working)`,
    feedLeave: (e) =>
      e.role === 'api'
        ? `An order desk closed (${e.count} open)`
        : `A kitchen staff member went idle (${e.count} working)`,
  },
  technical: {
    nodes: { browser: 'Browser', api: 'Orders API', queue: 'SQS queue', worker: 'Workers', db: 'Postgres' },
    stats: {
      placed: ['Orders placed', 'all time'],
      queue: ['In queue', 'waiting for a worker'],
      latency: ['p95 order time', 'placed → processed, last 5 min'],
      throughput: ['Throughput', 'processed, last 60 seconds'],
    },
    apiPods: (n) => `${n} pod${n === 1 ? '' : 's'} answered recently`,
    workerPods: (n) => `${n} pod${n === 1 ? '' : 's'} busy recently`,
    queueText: (n) => `${n} messages`,
    dbText: (n) => `${n.toLocaleString()} rows`,
    legendIn: 'new order → API → queue',
    legendOut: 'worker processed → saved to Postgres',
    platform: 'Platform',
    pods: 'API pods answering (load balancing)',
    workers: 'Workers sharing the load (last 50 orders)',
    feedIn: (e) => `Order #${e.id} (${e.item}) accepted by the API and queued in SQS`,
    feedOut: (e) => `Worker ${shortPod(e.pod)} processed order #${e.id} → saved to Postgres (${formatMs(e.ms)} end to end)`,
    feedJoin: (e) =>
      e.role === 'api'
        ? `API pod ${shortPod(e.pod)} started answering (${e.count} active)`
        : `Worker pod ${shortPod(e.pod)} started taking orders (${e.count} active)`,
    feedLeave: (e) =>
      e.role === 'api'
        ? `API pod ${shortPod(e.pod)} stopped answering (${e.count} active)`
        : `Worker pod ${shortPod(e.pod)} went idle (${e.count} active)`,
  },
}

// One plain-language line per pipeline step (shown on hover or tap)
const TIPS = {
  browser: 'You. Every click sends a real HTTPS request over the internet to AWS.',
  api: 'Accepts each order instantly, saves it, and hands it off, so you never wait for the slow part. Runs as several copies (pods); more are added automatically when it gets busy.',
  queue: 'Amazon SQS holds orders safely until a worker is free. If a worker crashes, the order waits here and is retried, so nothing is lost.',
  worker: 'Background workers take orders off the queue and process them. More workers are added automatically when the line gets long.',
  db: 'PostgreSQL on Amazon RDS stores every order permanently, over an encrypted connection.',
}

// ---------- Components ----------
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
      <span className="stat-value">{format ? format(shown) : Math.round(shown).toLocaleString()}</span>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  )
}

function Sparkline({ points }) {
  const w = 300
  const h = 40
  const padded = [...Array(Math.max(0, HISTORY_POINTS - points.length)).fill(0), ...points]
  const max = Math.max(1, ...padded)
  const step = w / (HISTORY_POINTS - 1)
  const coords = padded
    .map((p, i) => `${(i * step).toFixed(1)},${(h - (p / max) * (h - 6) - 3).toFixed(1)}`)
    .join(' ')
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon className="spark-area" points={`0,${h} ${coords} ${w},${h}`} />
      <polyline className="spark-line" points={coords} />
    </svg>
  )
}

// Small colored dots, one per active pod; they pop in and fade out as pods come and go
function PodDots({ pods, busy = new Set() }) {
  return (
    <ul className="pod-dots" aria-hidden="true">
      {pods.map((pod) => (
        <li
          key={pod}
          className={`pod-dot ${busy.has(pod) ? 'busy' : ''}`}
          style={{ '--hue': hueFor(pod) }}
          title={pod}
        />
      ))}
    </ul>
  )
}

function QueueGauge({ pending }) {
  const level = Math.min(1, pending / 100)
  const tone = pending >= 50 ? 'bad' : pending >= 10 ? 'warn' : 'ok'
  return (
    <div className={`gauge ${tone}`} aria-hidden="true">
      <div className="gauge-fill" style={{ width: `${Math.max(pending > 0 ? 4 : 0, level * 100)}%` }} />
    </div>
  )
}

const NODES = [
  { id: 'browser', icon: '🖥️' },
  { id: 'api', icon: '⚙️' },
  { id: 'queue', icon: '📬' },
  { id: 'worker', icon: '🛠️' },
  { id: 'db', icon: '🗄️' },
]
// Which links each particle travels: "in" = new order, "out" = processed order
const LINKS = { in: [0, 1], out: [2, 3] }

function Pipeline({ particles, pending, total, labels, copy, activeApi, activeWorkers, busyWorkers }) {
  // Badges show exact counts only (queue size, rows saved). Pod dots show pods SEEN working
  // recently, which is not the same as how many replicas KEDA/HPA are running.
  const badges = { queue: pending, db: total }
  const below = {
    api: (
      <>
        <PodDots pods={activeApi} />
        <span className="node-note">{copy.apiPods(activeApi.length)}</span>
      </>
    ),
    queue: (
      <>
        <QueueGauge pending={pending} />
        <span className="node-note">{copy.queueText(pending)}</span>
      </>
    ),
    worker: (
      <>
        <PodDots pods={activeWorkers} busy={busyWorkers} />
        <span className="node-note">{copy.workerPods(activeWorkers.length)}</span>
      </>
    ),
    db: <span className="node-note">{copy.dbText(total)}</span>,
  }
  return (
    <div className="pipeline">
      {NODES.map((node, i) => (
        <div className="pipe-segment" key={node.id}>
          <div className="pipe-stack">
            <div
              className={`pipe-node ${node.id === 'queue' && pending > 0 ? 'busy' : ''} ${
                node.id === 'worker' && busyWorkers.size > 0 ? 'working' : ''
              }`}
              tabIndex={0}
              aria-describedby={`tip-${node.id}`}
            >
              <span className="pipe-icon" aria-hidden="true">{node.icon}</span>
              <span className="pipe-label">{labels[node.id]}</span>
              {badges[node.id] !== undefined && <span className="pipe-badge">{badges[node.id]}</span>}
              <span className="pipe-tip" role="tooltip" id={`tip-${node.id}`}>{TIPS[node.id]}</span>
            </div>
            <div className="pipe-below">{below[node.id]}</div>
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

function Feed({ events, copy }) {
  if (events.length === 0) {
    return <p className="muted">Nothing yet. Place an order and watch it travel through the system.</p>
  }
  const text = (e) =>
    ({ in: copy.feedIn, out: copy.feedOut, join: copy.feedJoin, leave: copy.feedLeave })[e.kind](e)
  return (
    <ol className="feed" aria-live="polite">
      {events.map((e) => (
        <li key={e.key} className={`feed-item ${e.kind}`}>
          <time>{e.at.toLocaleTimeString()}</time>
          <span>{text(e)}</span>
        </li>
      ))}
    </ol>
  )
}

function OrdersTable({ orders, flash }) {
  return (
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
          {orders.length === 0 && (
            <tr>
              <td colSpan={7} className="empty-row">
                No orders yet. Click <b>Burst ×10</b> to simulate a rush of customers.
              </td>
            </tr>
          )}
          {orders.map((o) => (
            <tr
              key={o.id}
              className={`${flash.added.has(o.id) ? 'row-new' : ''} ${flash.done.has(o.id) ? 'row-done' : ''}`}
            >
              <td>{o.id}</td>
              <td>{o.item}</td>
              <td>{o.quantity}</td>
              <td>
                <span className={`status ${o.status}`}>{o.status === 'processed' ? '✓ processed' : 'pending'}</span>
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
  )
}

// A panel over the page (About, full orders table). Escape or the backdrop closes it.
function Modal({ title, onClose, children }) {
  const closeRef = useRef(null)
  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="link" ref={closeRef} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

function About() {
  return (
    <div className="about">
      <p>
        ShipYard is a portfolio project showing how a real company could run a service on AWS: it survives traffic
        rushes, server failures, and bad deploys, keeps data secure, and costs almost nothing when idle. The order app
        is deliberately simple; the platform underneath is the point.
      </p>
      <p className="cost">
        <span className="badge">≈ $0.35/hour · runs on demand</span>
        <span className="muted">The whole environment is created from code for demos and torn down afterward.</span>
      </p>
      <h3>Built with</h3>
      <p className="muted">
        Terraform · EKS (Kubernetes) · Argo CD (GitOps) · Helm · SQS · RDS PostgreSQL · ALB + ACM · ExternalDNS ·
        Prometheus · Grafana · Loki · KEDA · GitHub Actions (OIDC, Checkov, Trivy)
      </p>
      <h3>The code</h3>
      <ul className="links">
        <li><a href={`${GITHUB}/shipyard`} target="_blank" rel="noreferrer">Overview and architecture ↗</a></li>
        <li><a href={`${GITHUB}/shipyard-infra`} target="_blank" rel="noreferrer">Infrastructure (Terraform) ↗</a></li>
        <li><a href={`${GITHUB}/shipyard-apps`} target="_blank" rel="noreferrer">This app (API, worker, dashboard) ↗</a></li>
        <li><a href={`${GITHUB}/shipyard-gitops`} target="_blank" rel="noreferrer">Deployments (Helm + Argo CD) ↗</a></li>
      </ul>
    </div>
  )
}

function countBy(values) {
  return values.reduce((acc, v) => {
    if (v) acc[v] = (acc[v] || 0) + 1
    return acc
  }, {})
}

// Pods seen within `windowMs`, oldest first (so dots keep their positions)
function activeSince(seen, windowMs, now) {
  return Object.entries(seen)
    .filter(([, t]) => now - t.last <= windowMs)
    .sort((a, b) => a[1].first - b[1].first)
    .map(([pod]) => pod)
}

// ---------- Page ----------
export default function App() {
  const [orders, setOrders] = useState([])
  const [stats, setStats] = useState(null) // live counts from /api/stats (null if unavailable)
  const [info, setInfo] = useState(null)
  const [apiPods, setApiPods] = useState({}) // pod name -> polls answered
  const [activeApi, setActiveApi] = useState([])
  const [activeWorkers, setActiveWorkers] = useState([])
  const [busyWorkers, setBusyWorkers] = useState(new Set())
  const [particles, setParticles] = useState([])
  const [history, setHistory] = useState([]) // orders processed per poll
  const [events, setEvents] = useState([]) // story feed, newest first
  const [flash, setFlash] = useState({ added: new Set(), done: new Set() })
  const [item, setItem] = useState('widget')
  const [quantity, setQuantity] = useState(1)
  const [error, setError] = useState('') // polling failures: the API is unreachable
  const [notice, setNotice] = useState('') // friendly problems with an action (e.g. rate limited)
  const [busy, setBusy] = useState(false)
  const [modal, setModal] = useState(null) // 'about' | 'orders' | null
  const [mode, setMode] = useState(() => load('shipyard.mode', 'simple'))
  const [showIntro, setShowIntro] = useState(() => !load('shipyard.introDismissed', false))
  const known = useRef(null) // order id -> status from the previous poll
  const apiSeen = useRef({}) // pod -> { first, last } answered
  const workerSeen = useRef({}) // pod -> { first, last } finished an order
  const lastActive = useRef(null) // { api: [...], workers: [...] } from the previous poll
  const copy = COPY[mode] || COPY.simple

  // Launch animated dots; "extraDelay" lets a processed dot wait for its intake dot
  const spawn = useCallback((kind, ids, extraDelay = () => 0) => {
    const shown = ids.slice(-MAX_PARTICLES_PER_POLL)
    if (shown.length === 0) return
    const batch = shown.map((id, n) => ({ id: `${kind}-${id}`, kind, delay: n * 90 + extraDelay(id) }))
    setParticles((current) => [...current, ...batch])
    const lifetime = Math.max(...batch.map((b) => b.delay)) + STAGE_MS * 2 + 300
    setTimeout(() => {
      const finished = new Set(batch.map((b) => b.id))
      setParticles((current) => current.filter((p) => !finished.has(p.id)))
    }, lifetime)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [latestOrders, latestInfo, latestStats] = await Promise.all([
        api('/api/orders'),
        api('/api/info'),
        api('/api/stats').catch(() => null), // older API versions don't have it
      ])
      const now = Date.now()
      const at = new Date(now)
      const previous = known.current
      const fresh = []

      // Who answered / who finished work, for the pod dots and scaling events
      const touch = (seen, pod, t) => {
        if (!pod) return
        seen[pod] = { first: seen[pod]?.first ?? t, last: Math.max(seen[pod]?.last ?? 0, t) }
      }
      touch(apiSeen.current, latestInfo.pod, now)

      if (previous) {
        const addedOrders = latestOrders.filter((o) => !previous.has(o.id)).sort((a, b) => a.id - b.id)
        const doneOrders = latestOrders
          .filter((o) => o.status === 'processed' && previous.get(o.id) !== 'processed')
          .sort((a, b) => a.id - b.id)
        const added = addedOrders.map((o) => o.id)
        const done = doneOrders.map((o) => o.id)
        const addedSet = new Set(added)
        spawn('in', added)
        spawn('out', done, (id) => (addedSet.has(id) ? STAGE_MS * 2 : 0))
        setFlash({ added: addedSet, done: new Set(done) })
        setHistory((h) => [...h, done.length].slice(-HISTORY_POINTS))
        doneOrders.forEach((o) => touch(workerSeen.current, o.processed_by, now))
        setBusyWorkers(new Set(doneOrders.map((o) => o.processed_by).filter(Boolean)))

        fresh.push(
          ...addedOrders.map((o) => ({ key: `in-${o.id}`, kind: 'in', id: o.id, item: o.item, at })),
          ...doneOrders.map((o) => ({
            key: `out-${o.id}`,
            kind: 'out',
            id: o.id,
            pod: o.processed_by,
            ms: new Date(o.processed_at) - new Date(o.created_at),
            at,
          }))
        )
      } else {
        // First load: count workers that finished something recently as active
        latestOrders.forEach((o) => {
          if (o.processed_at) touch(workerSeen.current, o.processed_by, new Date(o.processed_at).getTime())
        })
      }

      const api_ = activeSince(apiSeen.current, API_ACTIVE_MS, now)
      const workers_ = activeSince(workerSeen.current, WORKER_ACTIVE_MS, now)
      if (lastActive.current) {
        const scaling = (role, before, after) => {
          after.filter((p) => !before.includes(p)).forEach((pod) =>
            fresh.push({ key: `join-${role}-${pod}-${now}`, kind: 'join', role, pod, count: after.length, at })
          )
          before.filter((p) => !after.includes(p)).forEach((pod) =>
            fresh.push({ key: `leave-${role}-${pod}-${now}`, kind: 'leave', role, pod, count: after.length, at })
          )
        }
        scaling('api', lastActive.current.api, api_)
        scaling('worker', lastActive.current.workers, workers_)
      }
      lastActive.current = { api: api_, workers: workers_ }
      setActiveApi(api_)
      setActiveWorkers(workers_)

      if (fresh.length > 0) setEvents((current) => [...fresh.reverse(), ...current].slice(0, FEED_SIZE))
      known.current = new Map(latestOrders.map((o) => [o.id, o.status]))
      setOrders(latestOrders)
      setStats(latestStats)
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

  // Busy pulse lasts a moment, not until the next poll
  useEffect(() => {
    if (busyWorkers.size === 0) return undefined
    const t = setTimeout(() => setBusyWorkers(new Set()), WORKER_BUSY_MS)
    return () => clearTimeout(t)
  }, [busyWorkers])

  async function placeOrders(count) {
    setBusy(true)
    setNotice('')
    try {
      const results = await Promise.allSettled(
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
      const failed = results.filter((r) => r.status === 'rejected')
      if (failed.length > 0) {
        const limited = failed.filter((r) => r.reason?.status === 429).length
        setNotice(
          limited > 0
            ? `${limited} of ${count} orders were turned away: this public demo limits how fast one visitor can order. Wait a few seconds and try again.`
            : `${failed.length} of ${count} orders failed: ${failed[0].reason?.message}`
        )
      }
    } finally {
      setBusy(false)
      refresh()
    }
  }

  function changeMode(next) {
    setMode(next)
    save('shipyard.mode', next)
  }

  function dismissIntro() {
    setShowIntro(false)
    save('shipyard.introDismissed', true)
  }

  const closeModal = useCallback(() => setModal(null), [])

  // ---------- Derived numbers (live stats when available, otherwise from the last 50 orders) ----------
  const fallbackTotal = orders.reduce((max, o) => Math.max(max, o.id), 0)
  const total = stats?.total ?? fallbackTotal
  const pending = stats?.pending ?? orders.filter((o) => o.status === 'pending').length
  const processedOrders = orders.filter((o) => o.processed_at)
  const fallbackLatency = processedOrders.length
    ? processedOrders.reduce((sum, o) => sum + (new Date(o.processed_at) - new Date(o.created_at)), 0) /
      processedOrders.length
    : 0
  const latency = stats ? stats.p95Ms ?? 0 : fallbackLatency
  const fallbackPerMinute = history.length
    ? (history.reduce((a, b) => a + b, 0) * 60000) / (history.length * POLL_MS)
    : 0
  const perMinute = stats?.processedLastMinute ?? fallbackPerMinute
  const workers = Object.entries(countBy(orders.map((o) => o.processed_by))).sort((a, b) => b[1] - a[1])
  const maxWorker = Math.max(1, ...workers.map(([, n]) => n))
  const version = info?.version || ''

  return (
    <div className="page">
      <header className="header">
        <div className="title">
          <h1>ShipYard · Orders</h1>
          <p>Live view of an orders platform running on AWS EKS</p>
        </div>
        <div className="header-right">
          <div className="toggle" role="group" aria-label="How to describe the system">
            <button type="button" aria-pressed={mode === 'simple'} onClick={() => changeMode('simple')}>
              Simple
            </button>
            <button type="button" aria-pressed={mode === 'technical'} onClick={() => changeMode('technical')}>
              Technical
            </button>
          </div>
          <span className={`pill ${error ? 'offline' : ''}`}>
            <span className="dot" />
            {error ? 'OFFLINE' : 'LIVE'}
          </span>
          {info &&
            (isCommitSha(version) ? (
              <a
                className="badge"
                href={`${GITHUB}/shipyard-apps/commit/${version}`}
                target="_blank"
                rel="noreferrer"
                title="See the exact code running right now"
              >
                version {version.slice(0, 7)} ↗
              </a>
            ) : (
              <span className="badge">version {version.slice(0, 7)}</span>
            ))}
          <button type="button" className="secondary small" onClick={() => setModal('about')}>
            About
          </button>
        </div>
      </header>

      <div className="alerts">
        {showIntro && (
          <section className="intro">
            <p>
              <strong>What am I looking at?</strong> A live order system running on AWS. Click <b>Burst ×10</b> or{' '}
              <b>Rush ×50</b> to simulate customers: orders are accepted instantly, queued, and processed by workers
              that are added automatically as the line grows. Hover or tap any step to see what it does.
            </p>
            <button type="button" className="secondary small" onClick={dismissIntro}>
              Got it
            </button>
          </section>
        )}
        {error && <div className="error">{error}</div>}
        {notice && (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button type="button" className="link" onClick={() => setNotice('')} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}
      </div>

      <div className="stats">
        <Stat label={copy.stats.placed[0]} value={total} hint={copy.stats.placed[1]} />
        <Stat label={copy.stats.queue[0]} value={pending} hint={copy.stats.queue[1]} />
        <Stat
          label={stats ? copy.stats.latency[0] : 'Avg latency'}
          value={latency}
          format={formatMs}
          hint={stats ? copy.stats.latency[1] : 'last 50 orders'}
        />
        <Stat
          label={copy.stats.throughput[0]}
          value={perMinute}
          format={(v) => `${Math.round(v).toLocaleString()}/min`}
          hint={copy.stats.throughput[1]}
        />
      </div>

      <section className="card pipeline-card">
        <div className="card-head">
          <h2>Live pipeline</h2>
          <form
            className="controls"
            onSubmit={(e) => {
              e.preventDefault()
              placeOrders(1)
            }}
          >
            <label className="sr-only" htmlFor="item">Item</label>
            <input id="item" value={item} maxLength={90} required onChange={(e) => setItem(e.target.value)} />
            <label className="sr-only" htmlFor="qty">Quantity</label>
            <input
              id="qty"
              className="qty"
              type="number"
              min={1}
              max={1000}
              required
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
            <button type="submit" disabled={busy}>Place order</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => placeOrders(10)}>
              Burst ×10
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => placeOrders(50)}>
              Rush ×50
            </button>
          </form>
        </div>
        <Pipeline
          particles={particles}
          pending={pending}
          total={total}
          labels={copy.nodes}
          copy={copy}
          activeApi={activeApi}
          activeWorkers={activeWorkers}
          busyWorkers={busyWorkers}
        />
        <div className="pipeline-foot">
          <div className="legend">
            <span><i className="in" /> {copy.legendIn}</span>
            <span><i className="out" /> {copy.legendOut}</span>
          </div>
          <div className="spark-wrap">
            <span className="muted">Finished, last 60s</span>
            <Sparkline points={history} />
          </div>
        </div>
      </section>

      <div className="bottom">
        <section className="card">
          <h2>What just happened</h2>
          <div className="scroll">
            <Feed events={events} copy={copy} />
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>
              Latest orders <span className="muted">({pending.toLocaleString()} pending)</span>
            </h2>
            <button type="button" className="secondary small" onClick={() => setModal('orders')}>
              View all
            </button>
          </div>
          <ul className="latest">
            {orders.length === 0 && (
              <li className="muted">No orders yet. Click <b>Burst ×10</b> to simulate a rush of customers.</li>
            )}
            {orders.slice(0, LATEST_ROWS).map((o) => (
              <li
                key={o.id}
                className={`${flash.added.has(o.id) ? 'row-new' : ''} ${flash.done.has(o.id) ? 'row-done' : ''}`}
              >
                <span className="latest-id">#{o.id}</span>
                <span className="latest-item">{o.item}</span>
                <span className={`status ${o.status}`}>
                  {o.status === 'processed'
                    ? `✓ ${formatMs(new Date(o.processed_at) - new Date(o.created_at))}`
                    : 'pending'}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="card">
          <h2>{copy.platform}</h2>
          <div className="scroll">
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

            <h3>{copy.pods}</h3>
            <ul className="chips">
              {Object.entries(apiPods).map(([pod, hits]) => (
                <li
                  key={pod}
                  className={`chip ${info?.pod === pod ? 'active' : ''}`}
                  style={{ '--hue': hueFor(pod) }}
                  title={pod}
                >
                  <span className="chip-dot" key={hits} />
                  <span>{shortPod(pod)}</span>
                  <span className="chip-count">{hits}</span>
                </li>
              ))}
            </ul>

            <h3>{copy.workers}</h3>
            <ul className="lanes">
              {workers.length === 0 && <li className="muted">No orders processed yet</li>}
              {workers.map(([pod, count]) => (
                <li className="lane" key={pod}>
                  <span className="lane-name" title={pod}>{shortPod(pod)}</span>
                  <div className="lane-track">
                    <div
                      className="lane-bar"
                      style={{ width: `${(count / maxWorker) * 100}%`, '--hue': hueFor(pod) }}
                    />
                  </div>
                  <span className="lane-count">{count}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>

      {modal === 'about' && (
        <Modal title="About this project" onClose={closeModal}>
          <About />
        </Modal>
      )}
      {modal === 'orders' && (
        <Modal title={`Last ${orders.length} orders`} onClose={closeModal}>
          <OrdersTable orders={orders} flash={flash} />
        </Modal>
      )}
    </div>
  )
}
