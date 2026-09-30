# dsh-quick-reload

One-click **刷新页面** button for the DSH Web UI: a small translucent ⟳ pinned to
the frame's bottom-right corner, available in every view.

## Why

Injecting or editing a client plugin updates the Host's cordis tree live, but the
browser half that is already loaded keeps running the old code — so the only
reliable way to see the change used to be quitting and reopening the whole app.
This button reboots the Web page against the freshly published module graph, so
a hot-injected plugin appears immediately.

## What it registers

| Half | Entry point | Work |
| --- | --- | --- |
| Host | `lib/index.js` | nothing (keeps the package a valid bundle row) |
| Client | `lib/client.js` | `shell.overlay` / id `quick-reload` / order 100 / label from locale |

`shell.overlay` is root scope and kind **list** with `replaceRisk: none`: the
button lives in the frame-wide floating layer
(`.BynINW_overlayLayer{z-index:20;pointer-events:none;position:absolute;inset:0}`),
so it is global (mounted with the layout frame, not with a Session), additive
(a fresh `id` can never replace or displace anyone), and it shares a **row** with
nobody — every occupant positions itself.

The layer is click-through, so this entry opts back in with `pointer-events:auto`.

## Why not the other "global-looking" seats

| Seat | Why not |
| --- | --- |
| `sidebar.footer.action` | Renders into `._2H3hWW_footerActions{display:flex}` — one flex **row**. `dsh-context`'s `context-overview` entry there is `width:calc(100% + 4px)` + `margin:0 -2px`, i.e. it wants the whole row; a second entry overlaps it (this was the original bug). Forcing my item to `flex:0 0 36px` would stop the overlap but squeeze the other plugin's label instead. |
| `conversation.session.header.actions` | Session-scoped: it does not exist without an open Session. Also a shared, width-constrained action row. |
| `sidebar.panellist` | Its ids address a main panel — clicking switches the main column. Wrong semantics for an action. |
| `conversation.header.corner`, `shell.leading`, `sidebar.*` singletons | Single slots: registering shadows the shipped UI (`replaceRisk: shadows-shipped-ui`). |

## Placement

Bottom-right, inset 18px — the frame's floating-pill convention. That corner is
free of persistent plugin UI: the only foreign `shell.overlay` entry is
`dsh-market-toast` (a transient install toast), toasts otherwise anchor to the
**top** through the primitives' `overlayTopMargin()` helper
(`max(min, --dsh-frame-top-clearance + 20)`), and dshmarket's own bottom-right
pill (`.nUhMVa_top`) is `position:absolute` **inside** the market panel
(`.nUhMVa_root{position:relative}`), not in this frame layer.

The button is 32px and translucent (`.68` opacity) until hover/focus, so even
when something transient passes underneath, nothing is really hidden.

## What the ⟳ click actually does

A page reload alone can keep serving stale JavaScript: the Host advertises every
bundle under `/plugins/**` with `Cache-Control: public, max-age=31536000,
immutable`. That is fine while a bundle's `rev` moves with it — but the rev is
derived from the artifact's **file metadata** (`mtimeMs` / `ctime` / size), not
from its bytes, so two different builds can share one rev and the year-long cache
then wins. So the click purges the *rebuildable* caches before reloading:

1. **Cache Storage** — every bucket is deleted (including the remote-access shell
   cache `dsh-remote-shell-v1`, which that plugin re-prefetches on its next visit).
2. **Service workers** — every registration gets `update()`, so whatever the SW
   serves comes from the Host again.
3. **Bundle bytes** — the module graph is read from the Host's own HMR stream
   (`GET /plugins/events`, the SSE frame the Host already broadcasts), and every
   `/plugins/**` URL it advertises — plus every one this page already loaded,
   taken from the performance timeline — is re-fetched with `cache:'reload'`.
   Bounded: at most 160 URLs, a 1.2s timeout per request, a 2.2s overall budget,
   so the reload never waits longer than that.

### What it deliberately keeps

`localStorage`, `sessionStorage`, cookies, the profile on disk, your Sessions and
the open conversation are **not** touched. That is where real state lives: per-
Session drafts, pane widths, and the remote-access device credential
(`dsh-remote-device`) — wiping those would lose work or break remote pairing.

### Why it cannot interrupt anything

Nothing in this path reaches the Host process or the agent runtime: no app
restart, no `/dsh-market/restart`, no profile write. A running turn, a background
job or a terminal session keeps running while the page reloads, and the page
reconnects to it afterwards. For a bare reload with no cache work, **Shift-click**
the button.

## Install

The npm package name is **`dsh-quick-reload-lyjs`** (the plain `dsh-quick-reload`
is taken on npm); the repository and the plugin id keep the short name. From the
release tarball — prebuilt, nothing to compile (with the desktop app fully quit):

```powershell
dsh plugin --profile desktop add https://github.com/lyjsyyds/dsh-quick-reload/releases/download/v0.1.1/dsh-quick-reload-lyjs-0.1.1.tgz
```

Or through the GUI — **设置 → 插件 → 安装** — with that same URL as the spec.

From a local checkout (the development form; the CLI writes both `dependencies`
and `dsh.profile.bundles` itself):

```powershell
dsh plugin --profile desktop add link:<absolute path to this directory>
```

## Remove

Uninstall the bundle in **设置 → 插件** (or `dsh plugin --profile desktop remove
dsh-quick-reload-lyjs`) and drop it from `dsh.profile.bundles`; the button disappears
on the next start.

## Notes

- A reload is enough for **client** changes. A change that rewrites already
  loaded Host modules still needs an app restart.
- When the Host re-publishes a file, the new `rev` alone already defeats the
  immutable cache; the revalidation pass exists for the rev-collision case (same
  metadata, different bytes).
- It only reloads the page and clears browser-side caches; it never writes to the
  profile, so it cannot break the plugin set.

## Tests

```powershell
npm test            # or: node tests/quick-reload.smoke.mjs
```

`tests/quick-reload.smoke.mjs` loads the bundle the way the Host's module loader
does (`window.__ModuleLoader__.load`), applies the plugin to a stub context,
renders the overlay entry with a small React stand-in that really tracks state,
and drives the whole click path against stubbed browser globals — Cache Storage,
service workers, the `/plugins/events` SSE frame, the performance timeline and
`fetch`. 19 checks, no dependencies, no network: it also pins the bounds (at most
160 URLs, one revalidation per URL) and proves a wedged origin cannot hold the
reload. A few checks are timing assertions, so the file takes about 3 seconds.

## License

MIT © 2026 LYJS. Source: <https://github.com/lyjsyyds/dsh-quick-reload>
