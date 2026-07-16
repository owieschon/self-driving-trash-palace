export function parseTrustedHttpOrigin(input: string, label = 'HTTP origin'): string {
  const url = new URL(input)
  if (
    url.origin !== input ||
    url.username !== '' ||
    url.password !== '' ||
    !['http:', 'https:'].includes(url.protocol)
  ) {
    throw new TypeError(`${label} must be one exact HTTP or HTTPS origin`)
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    throw new TypeError(`${label} must use HTTPS unless its host is loopback`)
  }
  return url.origin
}

export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const octets = hostname.split('.')
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^(?:0|[1-9][0-9]{0,2})$/.test(octet)) &&
    octets.every((octet) => Number(octet) <= 255)
  )
}
