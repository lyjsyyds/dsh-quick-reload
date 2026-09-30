// Smoke test for dsh-quick-reload: the package contract plus the whole browser
// half (lib/client.js), driven against stubbed browser globals. No browser, no
// dependencies, no network.
//
//   node tests/quick-reload.smoke.mjs
//
// The bundle is loaded the way the Host's module loader loads it
// (`window.__ModuleLoader__.load`), the returned plugin is applied to a stub
// context, the overlay entry is rendered with a small React stand-in that
// really tracks state, and every promise in the click path is awaited:
// Cache Storage, service-worker scripts, the /plugins/events HMR channel, the
// resource timeline, and fetch with cache: 'reload'.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = join(ROOT, 'lib', 'client.js')
const CLIENT_SRC = readFileSync(CLIENT, 'utf8')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const ORIGIN = 'http://127.0.0.1:19387'
const SSE_URL = '/plugins/events'
const MAX_RESOURCES = 160
const DEFAULT_GRAPH = JSON.stringify({
  type: 'graph',
  graph: {
    rev: 'feedfacecafe',
    entries: [{ id: 'advertised', rev: 'deadbeefcafe', url: 'plugins/??advertised/client.js&rev=deadbeefcafe' }],
  },
})

// ── stubbed browser ───────────────────────────────────────────────────────
let world

function sseResponse(text, signal) {
  const encoder = new TextEncoder()
  let sent = false
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true, value: undefined }
          sent = true
          return { done: false, value: encoder.encode('event: graph\ndata: ' + text + '\n\n') }
        },
        cancel: async () => {},
      }),
    },
  }
}

/** A reader that never settles on its own: only the abort signal ends it. */
function hangingResponse(signal) {
  const never = () => new Promise((_, reject) => {
    const fail = () => reject(new Error('aborted'))
    if (signal === undefined) return
    if (signal.aborted === true) fail()
    else signal.addEventListener('abort', fail)
  })
  return { ok: true, status: 200, body: { getReader: () => ({ read: never, cancel: async () => {} }) } }
}

/**
 * Install a fresh set of browser globals. Everything lib/client.js touches is
 * read lazily inside its own functions, so a new world per test is enough —
 * the module itself is imported only once.
 */
function resetWorld(options = {}) {
  const w = {
    reloads: 0,
    deleted: [],
    swUpdates: 0,
    registrations: options.registrations ?? 1,
    fetchCalls: [],
    styleTags: [],
    buckets: options.buckets ?? ['dsh-remote-shell-v1', 'workbox-precache'],
    loaded: options.loaded ?? [ORIGIN + '/plugins/loaded/client.js?rev=aaaa'],
    graphJson: options.graphJson ?? DEFAULT_GRAPH,
    graphMode: options.graphMode ?? 'ok', // ok | null-body | hang | reject
    hangUrls: options.hangUrls ?? [],
    noCaches: options.noCaches === true,
    noServiceWorkers: options.noServiceWorkers === true,
    deleteRejects: options.deleteRejects === true,
    // `resources` overrides the performance timeline; by default it reports
    // exactly the bundle URLs this page already loaded.
    resources: options.resources === undefined ? null : options.resources.resource,
  }
  w.resourceCalls = () => w.fetchCalls.filter((call) => call.url !== SSE_URL)

  const styleTags = w.styleTags
  const document = {
    querySelector(selector) {
      const match = /^style\[data-plugin-css="(.+)"\]$/.exec(selector)
      if (match === null) return null
      return styleTags.find((tag) => tag.dataset.pluginCss === match[1]) ?? null
    },
    createElement() {
      return {
        dataset: {},
        textContent: '',
        remove() {
          const index = styleTags.indexOf(this)
          if (index !== -1) styleTags.splice(index, 1)
        },
      }
    },
    head: { appendChild: (tag) => { styleTags.push(tag) } },
  }

  globalThis.window = {
    __ModuleLoader__: { load: (def) => { w.loadedDef = def } },
    location: { origin: ORIGIN, reload: () => { w.reloads += 1 } },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  }
  globalThis.document = document
  if (w.noCaches) delete globalThis.caches
  else {
    globalThis.caches = {
      keys: async () => w.buckets.slice(),
      delete: async (name) => {
        if (w.deleteRejects) throw new Error('cache delete failed')
        w.deleted.push(name)
        return true
      },
    }
  }
  const navigatorValue = w.noServiceWorkers
    ? {}
    : {
        serviceWorker: {
          getRegistrations: async () => Array.from({ length: w.registrations }, () => ({
            update: async () => { w.swUpdates += 1 },
          })),
        },
      }
  // Node defines `navigator` as a getter-only global, so assignment is a no-op.
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: navigatorValue })
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    writable: true,
    value: {
      getEntriesByType: (type) => (type !== 'resource'
        ? []
        : (w.resources === null ? w.loaded.map((name) => ({ name })) : w.resources())),
    },
  })

  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    w.fetchCalls.push({ url: target, options: init })
    if (target === SSE_URL) {
      if (w.graphMode === 'reject') throw new Error('offline')
      if (w.graphMode === 'hang') return hangingResponse(init.signal)
      if (w.graphMode === 'null-body') return { ok: true, status: 200, body: null }
      return sseResponse(w.graphJson, init.signal)
    }
    if (w.hangUrls.includes(target)) return hangingResponse(init.signal)
    return { ok: true, status: 200 }
  }

  world = w
  return w
}

/** Minimal React: createElement + a useState that really keeps state. */
function makeReact() {
  const state = []
  let cursor = 0
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const index = cursor
      cursor += 1
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
      return [state[index], (value) => {
        state[index] = typeof value === 'function' ? value(state[index]) : value
      }]
    },
    useCallback: (fn) => fn,
  }
  return {
    React,
    render: (component, props) => {
      cursor = 0
      return component(props ?? {})
    },
  }
}

function makeCtx() {
  const ctx = {
    effects: [],
    dicts: {},
    registered: [],
    disposers: [],
    effect(fn, label) {
      const dispose = fn()
      assert.equal(typeof dispose, 'function', `effect ${label} must return a disposer`)
      this.disposers.push({ label, dispose })
    },
    locale: {
      register: (ns, dict) => {
        ctx.dicts[ns] = dict
        return () => {}
      },
      bind: (ns) => (key) => {
        const dict = ctx.dicts[ns] ?? {}
        return dict.zh?.[key] ?? dict.en?.[key] ?? key
      },
    },
    slots: {
      inject: (name, fn) => { fn(); return () => {} },
      register: (options, component) => {
        ctx.registered.push({ options, component })
        return () => {}
      },
    },
  }
  return ctx
}

/** One loaded, applied plugin against a freshly stubbed world. */
function boot(options = {}) {
  const w = resetWorld(options)
  const { React, render } = makeReact()
  const requireStub = (id) => {
    if (id === 'react') return React
    throw new Error('unexpected require: ' + id)
  }
  const plugin = loaded.factory(requireStub)
  const ctx = makeCtx()
  plugin.apply(ctx)
  assert.equal(ctx.registered.length, 1, 'exactly one slot registration')
  return { world: w, React, render, plugin, ctx, entry: ctx.registered[0] }
}

const waitFor = async (predicate, ms = 5000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting for ' + predicate.toString())
}

// ── fake module loader: import the bundle exactly once ────────────────────
resetWorld()
let loaded = null
await import(pathToFileURL(CLIENT).href)
loaded = world.loadedDef

// ── runner ────────────────────────────────────────────────────────────────
const results = []
const check = async (name, fn) => {
  try {
    await fn()
    results.push(['PASS', name])
    console.log('  PASS  ' + name)
  } catch (error) {
    results.push(['FAIL', name + ' :: ' + error.message])
    console.log('  FAIL  ' + name)
    console.log('        ' + error.message)
  }
}

console.log('\nQuick Reload smoke — package contract + browser half\n')

// ── 1. package contract ───────────────────────────────────────────────────
await check('package.json declares the bundle layer and ships the right files', () => {
  assert.equal(pkg.name, 'dsh-quick-reload')
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.private, undefined, 'a private package cannot be published or listed')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(existsSync(join(ROOT, pkg.dsh.bundle.patch)), 'the patch file the manifest points at must exist')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)
  for (const id of pkg.dsh.client.inject) {
    assert.ok(id.startsWith('@deepseek-ai/dsh-client-'), `client inject must stay official: ${id}`)
  }
  assert.equal(pkg.exports['./client'], './lib/client.js')
  for (const file of ['lib', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE']) {
    assert.ok(pkg.files.includes(file), 'files must ship ' + file)
  }
  assert.ok(!pkg.files.includes('tests'), 'tests stay in the repo, not in the tarball')
  for (const file of ['lib/client.js', 'lib/index.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE']) {
    assert.ok(existsSync(join(ROOT, file)), 'missing ' + file)
  }
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- id: quick-reload/)
  assert.match(patch, /name: dsh-quick-reload/)
})

await check('cordis.patch.yml names the package, not a path', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  const name = /name:\s*(\S+)/.exec(patch)
  assert.equal(name[1], pkg.name, 'a bundle row resolves `name` through node_modules')
})

// ── 2. loader + apply ─────────────────────────────────────────────────────
await check('the loader id equals the package name', () => {
  assert.ok(loaded, 'window.__ModuleLoader__.load was not called')
  assert.equal(loaded.id, pkg.name, 'the browser half must report the installed package name')
  assert.equal(typeof loaded.factory, 'function')
})

await check('apply registers one additive shell.overlay entry', () => {
  const { entry, ctx } = boot()
  assert.equal(entry.options.name, 'shell.overlay', 'the frame-wide floating layer')
  assert.equal(entry.options.id, 'quick-reload', 'a fresh id can never displace a shipped entry')
  assert.equal(entry.options.order, 100)
  assert.equal(entry.options.locale, 'quick-reload')
  assert.equal(typeof entry.options.label, 'function', 'label is a thunk for the projection')
  assert.equal(entry.options.label(), '刷新页面')
  assert.equal(ctx.registered.length, 1, 'exactly one seat')
  assert.equal(ctx.disposers.length, 3, 'styles + dicts + the seat, all disposed on unload')
})

await check('inject list asks only for the two seam packages', () => {
  const { plugin } = boot()
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
})

// ── 3. locale ─────────────────────────────────────────────────────────────
await check('locale dicts are complete and symmetric', () => {
  const { ctx } = boot()
  const dict = ctx.dicts['quick-reload']
  assert.ok(dict, 'the quick-reload namespace must be registered')
  const zh = Object.keys(dict.zh).sort()
  const en = Object.keys(dict.en).sort()
  assert.deepEqual(zh, en, 'zh and en must cover the same keys')
  assert.deepEqual(zh, ['failed', 'hint', 'label', 'purging', 'purgeSkipped', 'purged', 'reloading'].sort())
  for (const key of zh) {
    assert.ok(dict.zh[key].length > 0 && dict.en[key].length > 0, key + ' must be translated in both')
  }
  assert.match(dict.zh.hint, /不会中断正在运行的任务/)
  assert.match(dict.zh.hint, /Shift/)
  assert.match(dict.zh.purged, /\{n\}/, 'the count placeholder the view replaces')
})

// ── 4. styles ─────────────────────────────────────────────────────────────
await check('the style tag is injected once, with theme tokens only', () => {
  const { world: w, ctx } = boot()
  assert.equal(w.styleTags.length, 1)
  const tag = w.styleTags[0]
  assert.equal(tag.dataset.plugin, 'dsh-quick-reload')
  assert.equal(tag.dataset.pluginCss, 'dsh-quick-reload/quick-reload.css')
  const css = tag.textContent
  for (const needle of [
    '.dshrq_fab{', '.dshrq_pill{', '.dshrq_spin{',
    'position:absolute', 'right:18px', 'bottom:18px', 'right:58px',
    'pointer-events:auto', 'border-radius:999px',
    'color:var(--dsw-alias-label-tertiary)',
    'background:color-mix(in srgb, var(--dsw-alias-bg-layer-1)',
    '@keyframes dshrq-spin', 'prefers-reduced-motion:reduce',
  ]) {
    assert.ok(css.includes(needle), 'CSS must contain ' + needle)
  }
  for (const match of css.matchAll(/(?:^|[;{])(color|background):([^;}]*)/g)) {
    assert.ok(match[2].includes('var(--dsw-'), `${match[1]} must come from a host theme token: ${match[2]}`)
  }
  assert.equal(ctx.disposers[0].label, 'quick-reload: styles')
})

await check('the style effect is idempotent and disposal removes the tag', () => {
  const first = boot()
  assert.equal(first.world.styleTags.length, 1)
  first.plugin.apply(makeCtx())
  assert.equal(first.world.styleTags.length, 1, 'a second apply reuses the tag the document already has')
  first.ctx.disposers[0].dispose()
  assert.equal(first.world.styleTags.length, 0, 'unload removes the tag')
  first.plugin.apply(makeCtx())
  assert.equal(first.world.styleTags.length, 1, 'and a later load can put it back')
})

// ── 5. render ─────────────────────────────────────────────────────────────
await check('idle render: fragment, no pill, accessible button', () => {
  const { React, render, entry } = boot()
  const tree = render(entry.component)
  assert.equal(tree.type, React.Fragment, 'fragment so the pill and the button coexist')
  assert.equal(tree.children[0], null, 'no status pill while idle')
  const button = tree.children[1]
  assert.equal(button.type, 'button')
  assert.equal(button.props.type, 'button')
  assert.equal(button.props.className, 'dshrq_fab')
  assert.equal(button.props['data-quick-reload'], '1')
  assert.equal(button.props.disabled, false)
  assert.equal(button.props['aria-label'], '刷新页面')
  assert.ok(button.props.title.includes('不会中断正在运行的任务'))
  assert.ok(button.props.title.includes('Shift'), 'the Shift escape hatch is documented in the tooltip')
  assert.equal(button.children.length, 1, 'icon only — the corner pill carries no label')
  const icon = button.children[0]
  assert.equal(typeof icon.type, 'function')
  const svg = icon.type(icon.props)
  assert.equal(svg.type, 'svg')
  assert.equal(svg.props.viewBox, '0 0 24 24')
  assert.equal(svg.children.length, 2, 'two arrow strokes')
  assert.equal(svg.props.className, undefined, 'idle icon does not spin')
})

// ── 6. the click path ─────────────────────────────────────────────────────
await check('click purges caches, revalidates bundles, then reloads once', async () => {
  const { render, entry, world: w } = boot()
  const button = render(entry.component).children[1]
  button.props.onClick(undefined)
  await waitFor(() => w.reloads === 1)

  assert.deepEqual(w.deleted, w.buckets, 'every Cache Storage bucket is dropped')
  assert.equal(w.swUpdates, 1, 'every registration is asked to re-check its script')
  assert.equal(w.reloads, 1, 'exactly one reload')

  const events = w.fetchCalls.filter((call) => call.url === SSE_URL)
  assert.equal(events.length, 1, 'one frame from the Host HMR channel')
  assert.equal(events[0].options.cache, 'no-store', 'the SSE read must not be cached')
  assert.equal(events[0].options.credentials, 'same-origin')
  assert.equal(events[0].options.headers.accept, 'text/event-stream')

  const urls = w.resourceCalls().map((call) => call.url)
  assert.ok(
    urls.includes(ORIGIN + '/plugins/??advertised/client.js&rev=deadbeefcafe'),
    'the relative combo URL the Host advertised is resolved against the origin: ' + urls.join(', '),
  )
  assert.ok(
    urls.includes(ORIGIN + '/plugins/loaded/client.js?rev=aaaa'),
    'URLs this page already loaded are revalidated too',
  )
  for (const call of w.resourceCalls()) {
    assert.equal(call.options.cache, 'reload', 'revalidation must bypass the HTTP cache')
    assert.equal(call.options.credentials, 'same-origin')
    assert.ok(call.options.signal, 'each request carries a timeout signal')
  }
})

await check('the busy pill reports what was cleared while the reload is pending', async () => {
  const { render, entry, world: w } = boot()
  render(entry.component).children[1].props.onClick(undefined)
  const busy = render(entry.component)
  assert.equal(busy.children[0].props.className, 'dshrq_pill')
  assert.equal(busy.children[0].props.role, 'status')
  assert.equal(busy.children[0].props['aria-live'], 'polite')
  assert.equal(busy.children[0].children[0], '正在清理缓存…')
  assert.equal(busy.children[1].props.disabled, true, 'the button locks while busy')
  assert.equal(busy.children[1].props.title, '正在清理缓存…')
  assert.equal(busy.children[1].props['aria-label'], '正在重新加载…')
  assert.equal(busy.children[1].children[0].type(busy.children[1].children[0].props).props.className, 'dshrq_spin', 'icon spins while busy')

  await waitFor(() => w.reloads === 1)
  const settled = render(entry.component)
  const expected = w.deleted.length + w.swUpdates + w.resourceCalls().length
  assert.equal(
    settled.children[0].children[0],
    `已清理 ${expected} 项缓存 · 正在重新加载…`,
    'the pill counts buckets + workers + revalidated URLs',
  )
})

await check('a double click never starts a second purge', async () => {
  const { render, entry, world: w } = boot()
  const button = render(entry.component).children[1]
  button.props.onClick(undefined)
  render(entry.component).children[1].props.onClick(undefined)
  await new Promise((resolve) => setTimeout(resolve, 700))
  const seen = `reloads=${w.reloads} deleted=${w.deleted.length} fetches=${w.fetchCalls.map((c) => c.url).join('|')}`
  assert.equal(w.reloads, 1, seen)
  assert.equal(w.deleted.length, w.buckets.length, 'no second purge — ' + seen)
  assert.equal(w.fetchCalls.filter((call) => call.url === SSE_URL).length, 1, 'no second graph read — ' + seen)
})

await check('Shift-click reloads without touching any cache', async () => {
  const { render, entry, world: w } = boot()
  const button = render(entry.component).children[1]
  button.props.onClick({ shiftKey: true })
  await waitFor(() => w.reloads === 1)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(w.deleted.length, 0, 'no cache deleted')
  assert.equal(w.swUpdates, 0, 'no service worker touched')
  assert.equal(w.fetchCalls.length, 0, 'no fetch at all')
  const busy = render(entry.component)
  assert.equal(busy.children[0].children[0], '正在重新加载…')
})

// ── 7. bounds & resilience ────────────────────────────────────────────────
await check('at most 160 bundle URLs are revalidated, and duplicates collapse', async () => {
  const entries = Array.from({ length: 200 }, (_, i) => ({ url: `plugins/??p${i}/client.js&rev=r${i}` }))
  entries.push({ url: entries[0].url }) // the Host may advertise one bundle twice
  const { render, entry, world: w } = boot({
    graphJson: JSON.stringify({ graph: { entries } }),
    loaded: [],
  })
  render(entry.component).children[1].props.onClick(undefined)
  await waitFor(() => w.reloads === 1)
  const calls = w.resourceCalls()
  const unique = new Set(calls.map((call) => call.url))
  assert.equal(calls.length, MAX_RESOURCES, 'the hard ceiling is the cap, not the graph size')
  assert.equal(unique.size, calls.length, 'no URL is revalidated twice')
  assert.equal(calls.filter((call) => call.url === calls[0].url).length, 1)
})

await check('a Host without the HMR channel still revalidates what this page loaded', async () => {
  const shared = ORIGIN + '/plugins/loaded/client.js?rev=aaaa'
  const { render, entry, world: w } = boot({
    graphMode: 'null-body',
    resources: { resource: () => [{ name: shared }] },
  })
  render(entry.component).children[1].props.onClick(undefined)
  await waitFor(() => w.reloads === 1)
  assert.deepEqual(w.resourceCalls().map((call) => call.url), [shared])
})

await check('a wedged origin cannot hold the reload: every wait is bounded', async () => {
  const shared = ORIGIN + '/plugins/loaded/client.js?rev=aaaa'
  const { render, entry, world: w } = boot({
    graphMode: 'hang',
    loaded: [shared],
    hangUrls: [shared],
    resources: { resource: () => [{ name: shared }] },
  })
  const started = Date.now()
  render(entry.component).children[1].props.onClick(undefined)
  await waitFor(() => w.reloads === 1, 8000)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 5000, `the reload must not wait on a wedged origin (took ${elapsed}ms)`)
})

await check('a failing purge is reported, never fatal', async () => {
  const { render, entry, world: w } = boot({
    graphMode: 'reject',
    noCaches: true,
    noServiceWorkers: true,
    deleteRejects: true,
  })
  render(entry.component).children[1].props.onClick(undefined)
  await waitFor(() => w.reloads === 1, 8000)
  assert.equal(w.reloads, 1, 'the reload happens even when every purge step fails')
})

// ── 8. the promise the UI makes ───────────────────────────────────────────
await check('no storage is ever cleared (the promise in the tooltip)', () => {
  for (const pattern of [/localStorage\s*\.\s*(clear|removeItem)/, /sessionStorage\s*\.\s*(clear|removeItem)/]) {
    assert.ok(!pattern.test(CLIENT_SRC), 'the page must not drop user state: ' + pattern)
  }
  assert.ok(CLIENT_SRC.includes('sessionStorage'), 'the README-level promise is documented in the source')
  assert.ok(CLIENT_SRC.includes('localStorage'))
})

await check('the reload goes through window.location only', () => {
  assert.match(CLIENT_SRC, /window\.location\.reload\(\)/)
  assert.ok(!/location\s*=\s*['"]/.test(CLIENT_SRC), 'never navigate away from the current URL')
})

// ── summary ───────────────────────────────────────────────────────────────
const failed = results.filter(([status]) => status === 'FAIL')
console.log(`\n  ${results.length - failed.length} passed, ${failed.length} failed\n`)
if (failed.length > 0) {
  for (const [, line] of failed) console.log('  - ' + line)
  console.log('')
}
process.exitCode = failed.length === 0 ? 0 : 1
