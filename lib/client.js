// dsh-quick-reload — BROWSER half.
//
// How this bundle is loaded: package.json declares `dsh.client.inject` +
// `exports["./client"]`; the DSH module loader picks this file up into the
// client roster. Bare ESM `import` statements do NOT work here — the only way
// to reach an official client package is `require('<name>')`, which the loader
// resolves against the roster. React and the locale service are the two we use.
//
// ── The seat ────────────────────────────────────────────────────────────────
// `shell.overlay` — root scope, kind `list`, replaceRisk: none. It is the
// frame-wide floating layer (`.BynINW_overlayLayer{z-index:20;pointer-events:
// none;position:absolute;inset:0}`), so:
//   * it is GLOBAL — mounted with the layout frame, not with a Session, so the
//     button is there in every view (conversation, settings, plugins, market);
//   * it is ADDITIVE — a fresh `id` is added beside the shipped entries and can
//     never replace or displace anyone (the contract's own advice for "a
//     frame-wide surface of your own");
//   * nothing competes for room — every occupant positions itself, so no two
//     entries share a row (which is exactly what broke on the sidebar foot).
//
// Why NOT the other two seats that also look global:
//   * `sidebar.footer.action` renders into `._2H3hWW_footerActions{display:
//     flex}` — one flex ROW. dsh-context's `context-overview` entry there is
//     `width:calc(100% + 4px)` with `margin:0 -2px`, i.e. it wants the whole
//     row; a second entry in that row overlaps it. (Shrinking it with
//     `flex:0 0 36px` on my side would squeeze another plugin's label instead
//     of covering it — still not "leave everyone alone".)
//   * `conversation.session.header.actions` is Session-scoped: it does not
//     exist without an open Session.
//   * `sidebar.panellist` ids address a main panel (clicking switches the main
//     column), so it is wrong for an action that just reloads.
//
// ── Placement ───────────────────────────────────────────────────────────────
// Bottom-right of the frame. That corner is free of persistent plugin UI: the
// only `shell.overlay` entry from another third-party plugin is
// `dsh-market-toast` (a transient install toast), and toasts in general anchor
// to the TOP via the primitives' `overlayTopMargin()` helper
// (`max(min, --dsh-frame-top-clearance + 20)`) — see
// `html[data-windows-titlebar]{--dsh-frame-overlay-top:calc(...+20px)}`.
// dshmarket's own bottom-right pill is `.nUhMVa_top`, which is `position:
// absolute` INSIDE the market panel (`.nUhMVa_root{position:relative}`), not in
// this frame layer.
// The layer is click-through, so this entry opts back in with
// `pointer-events:auto`; without that the button would be invisible to the
// mouse. It stays small (32px) and translucent until hover, so even when
// something transient passes underneath, nothing is really hidden.
//
// ── What it does ────────────────────────────────────────────────────────────
// 1. Purge the caches that a plain reload leaves behind (see the section below).
// 2. window.location.reload(). The Host has already applied the injected plugin
//    row and republished the client module graph, so a page boot is enough — the
//    bundle is re-fetched under its new `rev` and the new client plugin's
//    apply() runs. No cache-busting, no restart.
//
// ── Which caches, exactly (and which are deliberately kept) ─────────────────
// CLEARED, all of it browser-side and all of it reconstructible:
//   * Cache Storage — every bucket, via `caches.keys()` / `caches.delete()`.
//     This is where a service worker keeps an app shell; the remote-web-ui
//     plugin caches one under `dsh-remote-shell-v1`, and a shell cached by an
//     older build is exactly the kind of leftover that survives a reload.
//   * Stale service-worker SCRIPTS — every registration gets `update()`, so a
//     changed worker (and its new install/activate cycle) is picked up.
//   * Stale HTTP entries for the client bundles — `/plugins/**` is served with
//     `cache-control: public, max-age=31536000, immutable` (dsh-client-modules
//     `IMMUTABLE_CACHE`), and its `rev` is derived from filesystem metadata
//     (mtime/size), not from the bytes. So a rev CAN name two different builds;
//     when that happens an ordinary reload happily reuses the year-old entry.
//     We refetch every URL the Host currently advertises — read from the same
//     `/plugins/events` SSE frame the official HMR client uses, plus every
//     `/plugins/` resource this page actually loaded — with `cache: 'reload'`,
//     which forces one network round trip and replaces the cached bytes.
//
// KEPT on purpose — never touched, because clearing them would cost the user
// real state, not cache:
//   * localStorage — plugin/session UI preferences (shortcuts, panel widths,
//     per-session drafts: `dsh-client-store`, terminal shell, schedule, …).
//   * sessionStorage — includes the remote-web-ui device credential
//     (`dsh-remote-device`), which a paired phone needs to reach this host.
//   * cookies, IndexedDB (the app stores nothing there — checked), the profile
//     on disk, sessions, transcripts, drafts, credentials.
//
// ── It does not interrupt anything ──────────────────────────────────────────
// Everything above is read-only with respect to the Host process: no service
// is restarted, no run is cancelled, no file is written. The Host keeps every
// running task alive; only this tab's DOM goes away and comes back. The refresh
// is therefore "non-restart" in the strict sense — the process, its sessions and
// their runs are untouched — and a Shift-click is available for the impatient:
// it reloads immediately and skips the purge.

window.__ModuleLoader__.load({
  id: 'dsh-quick-reload',
  factory: (require) => {
    const React = require('react')
    const { useState, useCallback } = React
    const h = React.createElement

    const NS = 'quick-reload'

    // ── locale ────────────────────────────────────────────────────────────
    let t = (k) => k

    const DICT = {
      zh: {
        label: '刷新页面',
        hint: '重新加载界面并清理浏览器缓存，让刚注入或刚改动的插件立即生效（不用退出重进）。只刷新这个页面，不会中断正在运行的任务；按住 Shift 点击＝只刷新不清缓存。',
        purging: '正在清理缓存…',
        purged: '已清理 {n} 项缓存',
        purgeSkipped: '缓存清理未生效',
        reloading: '正在重新加载…',
        failed: '刷新失败，请手动刷新页面',
      },
      en: {
        label: 'Reload page',
        hint: 'Reload the interface and clear the browser caches so a plugin injected or edited just now takes effect (no app restart). Only this page reloads — running tasks are not interrupted. Shift-click to reload without clearing.',
        purging: 'Clearing caches…',
        purged: 'Cleared {n} cache entries',
        purgeSkipped: 'Cache purge skipped',
        reloading: 'Reloading…',
        failed: 'Reload failed — refresh the page manually',
      },
    }

    // ── style ─────────────────────────────────────────────────────────────
    // Colors come only from host theme tokens; the corner offset matches the
    // frame's own floating-pill convention (18px).
    const STYLE_ID = 'dsh-quick-reload/quick-reload.css'
    const CSS = [
      '.dshrq_fab{position:absolute;right:18px;bottom:18px;pointer-events:auto;',
      'display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;',
      'border:1px solid var(--dsw-alias-border-l2);border-radius:999px;',
      'background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 88%, transparent);',
      'color:var(--dsw-alias-label-tertiary);cursor:pointer;opacity:.68;',
      'box-shadow:0 2px 8px #0000001f;backdrop-filter:blur(6px);',
      'transition:opacity .15s ease,color .15s ease,background .15s ease,box-shadow .15s ease}',
      '.dshrq_fab:hover:not(:disabled),.dshrq_fab:focus-visible{opacity:1;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);',
      'box-shadow:0 4px 14px #0000002e;outline:none}',
      '.dshrq_fab:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary),0 4px 14px #0000002e}',
      '.dshrq_fab:disabled{cursor:default;opacity:1}',
      '.dshrq_pill{position:absolute;right:58px;bottom:20px;pointer-events:none;max-width:min(60vw,320px);',
      'padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;',
      'font-size:12px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
      'color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);',
      'box-shadow:0 2px 8px #0000001f}',
      '.dshrq_spin{animation:dshrq-spin 900ms linear infinite}',
      '@keyframes dshrq-spin{to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion:reduce){.dshrq_spin{animation:none}}',
    ].join('')

    /** Idempotent, and removed again with the plugin. */
    function ensureStyle() {
      if (typeof document === 'undefined') return () => {}
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']') !== null) {
        return () => {}
      }
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-quick-reload'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    // ── cache purge ───────────────────────────────────────────────────────
    /** Hard ceilings so a slow or wedged origin can never block the reload. */
    const GRAPH_FRAME_MS = 800
    const REVALIDATE_BUDGET_MS = 2200
    const RESOURCE_TIMEOUT_MS = 1200
    const MAX_RESOURCES = 160

    function timeoutSignal(ms) {
      try {
        if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
          return AbortSignal.timeout(ms)
        }
      } catch (error) {
        /* older engine: no per-request timeout, the budget still bounds us */
      }
      return undefined
    }

    /** Every Cache Storage bucket — app shells live here and are re-warmed on boot. */
    async function dropCacheStorage() {
      if (typeof caches === 'undefined' || typeof caches.keys !== 'function') return 0
      const names = await caches.keys()
      await Promise.all(names.map((name) => Promise.resolve(caches.delete(name)).catch(() => false)))
      return names.length
    }

    /** Make every registered service worker re-check its script. */
    async function refreshServiceWorkers() {
      const sw = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker
      if (sw === undefined || sw === null || typeof sw.getRegistrations !== 'function') return 0
      const registrations = await sw.getRegistrations()
      await Promise.all(registrations.map((registration) =>
        Promise.resolve(registration.update()).catch(() => undefined)))
      return registrations.length
    }

    /**
     * One frame of the Host's client-module graph, read from the same
     * `/plugins/events` SSE channel the official HMR client uses, then the
     * connection is dropped. Taking the URLs from the Host (instead of from
     * what this page happens to have loaded) is what makes the purge
     * authoritative: they are the URLs the next boot will ask for.
     */
    async function readGraph() {
      if (typeof fetch !== 'function') return undefined
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined
      let timer
      try {
        const response = await fetch('/plugins/events', {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { accept: 'text/event-stream' },
          signal: controller === undefined ? undefined : controller.signal,
        })
        if (response === undefined || response === null) return undefined
        if (response.body === undefined || response.body === null) return undefined
        if (typeof response.body.getReader !== 'function') return undefined
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        timer = window.setTimeout(() => {
          if (controller !== undefined) {
            try { controller.abort() } catch (error) { /* already closed */ }
          }
        }, GRAPH_FRAME_MS)
        let buffer = ''
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done === true) return undefined
          buffer += decoder.decode(chunk.value, { stream: true })
          const frame = /^data:\s*(.+)$/m.exec(buffer)
          if (frame !== null) {
            try {
              return JSON.parse(frame[1])
            } catch (error) {
              return undefined
            }
          }
        }
      } catch (error) {
        /* aborted, offline, or a Host without the HMR channel */
        return undefined
      } finally {
        window.clearTimeout(timer)
        if (controller !== undefined) {
          try { controller.abort() } catch (error) { /* already closed */ }
        }
      }
    }

    /**
     * Every bundle URL worth re-fetching: anything carrying `/plugins/` inside
     * the graph frame (whatever its exact shape), plus everything this page
     * already loaded from that route. Walking the frame generically avoids
     * depending on a field layout the Host may still revise.
     */
    function bundleUrls(graph) {
      const urls = new Set()
      // The Host advertises bundles in its own RELATIVE combo form
      // (`plugins/??<id>/client.js&rev=<rev>` — no leading slash), so every
      // candidate is resolved against the origin root before it is accepted.
      const origin = typeof window === 'undefined' || window.location === undefined
        ? undefined
        : window.location.origin
      const base = typeof origin === 'string' && origin.length > 0 ? origin + '/' : undefined
      const collect = (raw) => {
        if (typeof raw !== 'string' || raw.indexOf('plugins/') === -1) return
        if (base === undefined) return
        try {
          const absolute = new URL(raw, base).href
          if (absolute.indexOf('/plugins/') !== -1) urls.add(absolute)
        } catch (error) {
          /* not a URL — not our business */
        }
      }
      const visit = (node) => {
        if (node === null || typeof node !== 'object') return
        if (Array.isArray(node)) {
          for (const item of node) visit(item)
          return
        }
        for (const key of Object.keys(node)) {
          const value = node[key]
          if (typeof value === 'string') collect(value)
          else if (value !== null && typeof value === 'object') visit(value)
        }
      }
      visit(graph)
      try {
        for (const entry of performance.getEntriesByType('resource')) collect(entry.name)
      } catch (error) {
        /* performance timeline unavailable */
      }
      return urls
    }

    /**
     * `cache: 'reload'` = one unconditional network round trip that also
     * replaces the stored entry, i.e. the only thing a page can do about a
     * response the server marked immutable for a year.
     */
    async function revalidate(urls, budgetMs) {
      if (typeof fetch !== 'function') return 0
      const deadline = Date.now() + budgetMs
      let reached = 0
      await Promise.all(Array.from(urls).slice(0, MAX_RESOURCES).map(async (url) => {
        if (Date.now() > deadline) return
        try {
          await fetch(url, {
            cache: 'reload',
            credentials: 'same-origin',
            signal: timeoutSignal(RESOURCE_TIMEOUT_MS),
          })
          reached += 1
        } catch (error) {
          /* a stale rev the Host no longer serves, or a timeout: both fine */
        }
      }))
      return reached
    }

    /**
     * The whole purge. Browser-side only: Cache Storage, service-worker scripts
     * and the HTTP entries of the client bundles. Read-only with respect to the
     * Host, so no session, run or task is ever disturbed.
     */
    async function purgeBrowserCaches() {
      const report = { buckets: 0, workers: 0, urls: 0 }
      if (typeof window === 'undefined') return report
      try {
        report.buckets = await dropCacheStorage()
      } catch (error) {
        console.error('[quick-reload] Cache Storage purge failed:', error)
      }
      try {
        report.workers = await refreshServiceWorkers()
      } catch (error) {
        console.error('[quick-reload] service-worker refresh failed:', error)
      }
      try {
        const urls = bundleUrls(await readGraph())
        report.urls = await revalidate(urls, REVALIDATE_BUDGET_MS)
      } catch (error) {
        console.error('[quick-reload] bundle revalidation failed:', error)
      }
      return report
    }

    // ── view ──────────────────────────────────────────────────────────────
    function RefreshIcon({ spinning }) {
      return h('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        className: spinning ? 'dshrq_spin' : undefined,
        'aria-hidden': true,
        style: { display: 'block' },
      },
        h('path', { d: 'M20.5 12a8.5 8.5 0 1 1-2.49-6.01' }),
        h('path', { d: 'M20.5 3.5v5.5h-5.5' }))
    }

    function QuickReload() {
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState('')

      const reload = useCallback((event) => {
        if (busy) return
        // Shift = plain reload: skip the purge when the caches are known good.
        const plain = event !== undefined && event !== null && event.shiftKey === true
        setBusy(true)
        if (plain) {
          setNote(t('reloading'))
          window.setTimeout(() => {
            try {
              window.location.reload()
            } catch (error) {
              setBusy(false)
              setNote(t('failed'))
              console.error('[quick-reload] reload failed:', error)
            }
          }, 60)
          return
        }
        setNote(t('purging'))
        // Detached on purpose: the caller is a click, and the reload below tears
        // this component down anyway.
        void (async () => {
          let text = ''
          try {
            const report = await purgeBrowserCaches()
            // A plain reload already drops the in-page module table, so only the
            // storage-side work is worth reporting back.
            text = t('purged').replace('{n}', String(report.buckets + report.workers + report.urls))
          } catch (error) {
            console.error('[quick-reload] cache purge failed:', error)
            text = t('purgeSkipped')
          }
          setNote(text + ' · ' + t('reloading'))
          window.setTimeout(() => {
            try {
              window.location.reload()
            } catch (error) {
              setBusy(false)
              setNote(t('failed'))
              console.error('[quick-reload] reload failed:', error)
            }
          }, 120)
        })()
      }, [busy])

      const label = busy ? t('reloading') : t('label')
      return h(React.Fragment, null,
        busy
          ? h('div', {
            className: 'dshrq_pill',
            role: 'status',
            'aria-live': 'polite',
            'data-quick-reload-note': '1',
          }, note)
          : null,
        h('button', {
          type: 'button',
          className: 'dshrq_fab',
          title: busy ? t('purging') : t('hint'),
          'aria-label': label,
          'data-quick-reload': '1',
          disabled: busy,
          onClick: reload,
        }, h(RefreshIcon, { spinning: busy })))
    }

    // ── plugin ────────────────────────────────────────────────────────────
    function safely(label, fn) {
      try {
        return fn() || (() => {})
      } catch (error) {
        console.error(`[quick-reload] ${label} failed:`, error)
        return () => {}
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ensureStyle(), 'quick-reload: styles')
        ctx.effect(() => ctx.locale.register(NS, DICT), 'quick-reload: dicts')
        t = ctx.locale.bind(NS)

        ctx.effect(() => safely('overlay entry', () => ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({
            name: 'shell.overlay',
            id: 'quick-reload',
            order: 100,
            label: () => t('label'),
            locale: NS,
          }, QuickReload))), 'quick-reload: overlay entry')
      },
    }
  },
})
