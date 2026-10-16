/** Wire protocol and public option types for @checked/browser. */

export type EventType = 'error' | 'request' | 'performance' | 'custom'

export type BreadcrumbType = 'click' | 'navigation' | 'request' | 'console' | 'custom'

export type Primitive = string | number | boolean

export interface Breadcrumb {
  ts: number
  type: BreadcrumbType
  message: string
  data?: Record<string, Primitive | null>
}

export interface BreadcrumbInput {
  type?: BreadcrumbType
  message: string
  data?: Record<string, unknown>
  ts?: number
}

export interface EventUser {
  anonymousId: string
  id?: string
  emailHash?: string
  email?: string
}

export interface EventContext {
  browser?: { name: string; version: string }
  os?: { name: string; version: string }
  device?: 'mobile' | 'tablet' | 'desktop'
  viewport?: { w: number; h: number }
  language?: string
  userAgent?: string
  runtime?: { name: string; version: string }
  hostname?: string
}

export interface BaseEvent {
  id: string
  type: EventType
  ts: number
  environment: string
  release: string | null
  url: string
  user: EventUser
  sessionId: string
  context: EventContext
  breadcrumbs: Breadcrumb[]
  tags: Record<string, string>
  extra?: Record<string, unknown>
  replayId?: string
}

export type ErrorMechanism =
  | 'onerror'
  | 'unhandledrejection'
  | 'console'
  | 'manual'
  | 'uncaughtException'
  | 'middleware'

export interface ErrorEventPayload extends BaseEvent {
  type: 'error'
  error: {
    type: string
    message: string
    stack: string
    handled: boolean
    mechanism: ErrorMechanism
  }
}

export interface RequestEventPayload extends BaseEvent {
  type: 'request'
  request: {
    method: string
    url: string
    status: number
    durationMs: number
    errorMessage?: string
  }
}

export type MetricName = 'LCP' | 'INP' | 'CLS' | 'TTFB' | 'load'
export type Rating = 'good' | 'needs-improvement' | 'poor'

export interface PerformanceEventPayload extends BaseEvent {
  type: 'performance'
  performance: { metric: MetricName; value: number; rating: Rating }
}

export interface CustomEventPayload extends BaseEvent {
  type: 'custom'
  custom: { name: string; props: Record<string, Primitive> }
}

export type CheckedEvent =
  | ErrorEventPayload
  | RequestEventPayload
  | PerformanceEventPayload
  | CustomEventPayload

export interface Batch {
  key: string
  sdk: { name: string; version: string }
  sentAt: number
  client: { dropped: number }
  events: CheckedEvent[]
}

export interface IdentifyInput {
  id?: string | number
  email?: string
}

export interface CaptureContext {
  tags?: Record<string, unknown>
  extra?: Record<string, unknown>
}

export type MessageLevel = 'fatal' | 'error' | 'warning' | 'info' | 'debug'

export interface CheckedOptions {
  /** Public project key, `ck_pub_...`. Required. */
  key: string
  /** Defaults to "production". */
  environment?: string
  release?: string | null
  user?: IdentifyInput
  /** Full ingest URL. A bare origin (no path) gets `/api/v1/ingest/events` appended. */
  endpoint?: string
  /** 0..1, applied per error, request and performance event. Custom events are never sampled. */
  sampleRate?: number
  captureConsoleErrors?: boolean
  captureRequests4xx?: boolean
  captureQueryStrings?: boolean
  respectDoNotTrack?: boolean
  /** Send the raw email in addition to its hash. Off by default. */
  sendEmail?: boolean
  /** Runs last. Return the event (possibly modified) or null to drop it. If it throws, the event is dropped. */
  beforeSend?: (event: CheckedEvent) => CheckedEvent | null
  maxBreadcrumbs?: number
  reportAllVitals?: boolean
  /** Advanced: per page load cap on events. Default 100. */
  maxEventsPerPage?: number
  /** Advanced: flush interval in ms. Default 5000. */
  flushIntervalMs?: number
  debug?: boolean
}
