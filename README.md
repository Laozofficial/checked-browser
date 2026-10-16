# @checked/browser

Check’d production monitoring for the browser. Zero runtime dependencies, ES2018, under 10 KB gzipped as a script tag.

## Install

Script tag (initializes itself when `data-key` is present):

```html
<script src="https://getchecked.twelveai.app/sdk/checked.v1.min.js"
        data-key="ck_pub_..." data-env="production" data-release="1.4.2"></script>
```

| Attribute | Option |
|---|---|
| `data-key` | `key` (required) |
| `data-env` | `environment` |
| `data-release` | `release` |
| `data-endpoint` | `endpoint`. Default: the script's origin + `/api/v1/ingest/events`. Locally the web app on :4301 does not proxy `/api`, so set `data-endpoint="http://localhost:4300"` |
| `data-sample-rate` | `sampleRate` |
| `data-console-errors="true"` | `captureConsoleErrors` |
| `data-capture-4xx="true"` | `captureRequests4xx` |
| `data-capture-query-strings="true"` | `captureQueryStrings` |
| `data-respect-dnt="true"` | `respectDoNotTrack` |
| `data-report-all-vitals="true"` | `reportAllVitals` |
| `data-debug="true"` | `debug` |

npm:

```ts
import { Checked } from '@checked/browser'
Checked.init({ key: 'ck_pub_...', environment: 'production', release: '1.4.2' })
```

`checked.v1.min.js` always points at the latest 1.x build; `checked.v1.0.0.min.js` is pinned.

## Options

| Option | Default | Notes |
|---|---|---|
| `key` | | required |
| `environment` | `"production"` | |
| `release` | `null` | |
| `user` | | same as calling `identify` |
| `endpoint` | `https://getchecked.twelveai.app/api/v1/ingest/events` | a bare origin gets the ingest path appended |
| `sampleRate` | `1` | per error, request and performance event; custom events are never sampled |
| `captureConsoleErrors` | `false` | wraps `console.error`; the original still runs first |
| `captureRequests4xx` | `false` | 5xx and network errors are always sent |
| `captureQueryStrings` | `false` | keep `?query` and `#hash` in URLs |
| `respectDoNotTrack` | `false` | when true and DNT or Global Privacy Control is on, the SDK installs nothing |
| `sendEmail` | `false` | send the raw email next to its hash |
| `beforeSend(event)` | | runs last; return the event or `null`; a throwing hook drops the event |
| `maxBreadcrumbs` | `30` | ring buffer, max 100 |
| `reportAllVitals` | `false` | otherwise only `poor` vitals are sent |
| `maxEventsPerPage` | `100` | hard cap per page load, all event types |
| `flushIntervalMs` | `5000` | |
| `debug` | `false` | logs to `console.warn` with a `[checked]` prefix |

## API

```ts
Checked.init(options)
Checked.identify({ id, email })          // Promise<void>; email is SHA-256 hashed with crypto.subtle (trimmed, lowercased); without crypto.subtle the email is dropped
Checked.captureError(err, { tags, extra })
Checked.captureMessage(message, level?)  // error event with type "Message"; level goes into tags.level
Checked.track(name, props)               // custom event, flat props, max 20 keys
Checked.addBreadcrumb({ message, type?, data? })
Checked.setTag(key, value)               // null or undefined removes it
Checked.flush()                          // Promise<boolean>, true when the queue is empty
Checked.close()                          // flushes, then removes every hook
Checked.attachReplay(recorder)           // see ../README.md, not implemented yet
```

Calls before `init` (or after `close`, or when Do Not Track disabled the SDK) are no-ops. They are not queued.

## What it captures

- **Errors**: `window` `error` (resource load errors ignored) and `unhandledrejection` (non-Error reasons are stringified safely). Identical errors (type + message + top frame) within 1s are sent once.
- **Requests**: `fetch` and `XMLHttpRequest`. Method, URL, status (0 for network errors), duration, and an error message for network failures. Never bodies or headers. 5xx and network errors become `request` events; 4xx only with `captureRequests4xx`. Every request is also a breadcrumb. Aborted requests and opaque (`no-cors`) responses are breadcrumbs only. The SDK's own ingest calls are never recorded. The wrappers return the original promise and rethrow original errors.
- **Web Vitals**: TTFB and load from navigation timing (sent after load); LCP, INP and CLS from `PerformanceObserver` (sent on the first page hide). INP is approximate: the longest event-timing entry with an `interactionId`, `durationThreshold: 40`. CLS is the largest session window (gaps under 1s, window at most 5s). Thresholds (needs-improvement / poor): LCP 2500 / 4000 ms, INP 200 / 500 ms, CLS 0.1 / 0.25, TTFB 800 / 1800 ms, load 4000 / 8000 ms.
- **Breadcrumbs**: clicks (`button#save "Save order"`, inputs as `input[name=email]`, never values), SPA navigations (`pushState`, `replaceState`, `popstate`, `hashchange`), requests, captured console errors, custom.
- **Context**: page URL, referrer origin, browser and OS (major versions), device class, viewport, language, user agent (300 chars).
- **Ids**: anonymous id in `localStorage["checked.aid"]`, session id in `sessionStorage["checked.sid"]` with a 30 minute inactivity rollover. Both fall back to memory when storage is blocked.

## Privacy

Input values are never read. Query strings and hashes are stripped from the page URL, request URLs, breadcrumbs, and URLs inside messages and stack traces (line:col kept). Bearer/Basic tokens and `password=`, `token=`, `api_key=`, `secret=` style pairs are replaced with `[Filtered]`. Messages are cut at 1000 chars, stacks at 8000, breadcrumbs at 300.

## Transport

Events are queued and flushed every 5s, at 10 queued events, and on page hide (`sendBeacon` with a `text/plain` Blob, else `fetch` with `keepalive`). Requests are `POST`, `credentials: 'omit'`, `Content-Type: text/plain;charset=UTF-8`, so there is no CORS preflight. Batches hold at most 50 events and stay under 60 KB. The queue holds 200 events; beyond that the oldest are dropped and counted. While `navigator.onLine` is false events are held until `online`. See `../README.md` for the protocol and retry rules.
