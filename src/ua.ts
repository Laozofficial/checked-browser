/** Tiny user agent parser. Versions are reported as the major version only. */

export interface ParsedUA {
  browser: { name: string; version: string }
  os: { name: string; version: string }
  device: 'mobile' | 'tablet' | 'desktop'
}

const BROWSERS: Array<[string, RegExp]> = [
  ['Edge', /\bEdg(?:e|A|iOS)?\/(\d+)/],
  ['Opera', /\b(?:OPR|Opera|OPiOS)\/(\d+)/],
  ['Samsung Internet', /\bSamsungBrowser\/(\d+)/],
  ['Firefox', /\b(?:Firefox|FxiOS)\/(\d+)/],
  ['Chrome', /\b(?:Chrome|CriOS)\/(\d+)/],
  ['Safari', /\bVersion\/(\d+)[\d.]*.*Safari\//],
]

const WINDOWS_NT: Record<string, string> = {
  '10.0': '10',
  '6.3': '8.1',
  '6.2': '8',
  '6.1': '7',
  '6.0': 'Vista',
  '5.1': 'XP',
}

export function parseUserAgent(ua: string): ParsedUA {
  const result: ParsedUA = {
    browser: { name: 'Unknown', version: '' },
    os: { name: 'Unknown', version: '' },
    device: 'desktop',
  }
  if (!ua || typeof ua !== 'string') return result

  for (const [name, re] of BROWSERS) {
    const m = ua.match(re)
    if (m) {
      result.browser = { name, version: m[1] }
      break
    }
  }

  let m: RegExpMatchArray | null
  if ((m = ua.match(/Windows NT (\d+\.\d+)/))) {
    result.os = { name: 'Windows', version: WINDOWS_NT[m[1]] || m[1] }
  } else if ((m = ua.match(/(?:iPhone|iPad|iPod)(?:.*?) OS (\d+)[_.](\d+)/))) {
    result.os = { name: 'iOS', version: m[1] + '.' + m[2] }
  } else if ((m = ua.match(/Android (\d+(?:\.\d+)?)/))) {
    result.os = { name: 'Android', version: m[1] }
  } else if (/\bCrOS\b/.test(ua)) {
    const v = ua.match(/CrOS \S+ (\d+)/)
    result.os = { name: 'ChromeOS', version: v ? v[1] : '' }
  } else if ((m = ua.match(/Mac OS X (\d+)[_.](\d+)/))) {
    result.os = { name: 'macOS', version: m[1] + '.' + m[2] }
  } else if (/Macintosh/.test(ua)) {
    result.os = { name: 'macOS', version: '' }
  } else if (/Linux/.test(ua)) {
    result.os = { name: 'Linux', version: '' }
  }

  if (/iPad|Tablet|PlayBook|Silk/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) {
    result.device = 'tablet'
  } else if (/Mobi|iPhone|iPod|Android|Opera Mini|IEMobile/.test(ua)) {
    result.device = 'mobile'
  }
  return result
}
