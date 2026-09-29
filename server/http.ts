import { AppError } from './env';

export async function boundedJson<T = unknown>(
  response: Response,
  maxBytes = 256 * 1024,
): Promise<T> {
  const announced = Number(response.headers.get('content-length'));
  if (announced > maxBytes) {
    await response.body?.cancel();
    throw new AppError(
      'RESPONSE_TOO_LARGE',
      'This source returned too much information to process safely.',
      502,
    );
  }
  if (!response.body)
    throw new AppError('EMPTY_RESPONSE', 'The source returned an empty response.', 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new AppError(
          'RESPONSE_TOO_LARGE',
          'This source returned too much information to process safely.',
          502,
        );
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new AppError('INVALID_RESPONSE', 'The source returned an unreadable response.', 502);
    }
  } finally {
    reader.releaseLock();
  }
}

export function json(data: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(JSON.stringify(data), { status, headers });
}

export async function requestJson(request: Request): Promise<Record<string, unknown>> {
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json'))
    throw new AppError('INVALID_CONTENT_TYPE', 'Send this request as JSON.', 415);
  const value = await boundedJson<unknown>(new Response(request.body), 12 * 1024);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AppError('INVALID_REQUEST', 'This request could not be read.');
  return value as Record<string, unknown>;
}

export function safeMessage(error: unknown): string {
  return error instanceof AppError
    ? error.message
    : 'This source could not be checked. Other available results are preserved.';
}

export function safePublicUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443')
    )
      return null;
    if (
      !host.includes('.') ||
      host.startsWith('[') ||
      /^[\d.]+$/.test(host) ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      host.endsWith('.test') ||
      host.endsWith('.invalid') ||
      host === 'localhost' ||
      host === 'metadata.google.internal'
    )
      return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()])
      if (/^(utm_|fbclid$|gclid$|trid$|ref$|source$)/i.test(key)) url.searchParams.delete(key);
    return url.toString();
  } catch {
    return null;
  }
}

export async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
