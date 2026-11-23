import webpush from 'web-push';
import { request } from 'node:https';
import { z } from 'zod';
import type { CalendarPushPort, CalendarPushSubscription } from '@trinity-harness/contracts';

/** Provider origins are deployment configuration, never arbitrary subscription targets. */
export function calendarPushEndpointAllowed(endpoint: string, origins: readonly string[]): boolean {
  if (!URL.canParse(endpoint)) return false;
  const url = new URL(endpoint);
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.hash &&
    (!url.port || url.port === '443') &&
    origins.includes(url.origin)
  );
}

export function createCalendarPush(config: {
  WEB_PUSH_PUBLIC_KEY?: string | undefined;
  WEB_PUSH_PRIVATE_KEY?: string | undefined;
  WEB_PUSH_SUBJECT?: string | undefined;
  WEB_PUSH_ALLOWED_ORIGINS?: string | undefined;
}): CalendarPushPort | undefined {
  const values = [
    config.WEB_PUSH_PUBLIC_KEY,
    config.WEB_PUSH_PRIVATE_KEY,
    config.WEB_PUSH_SUBJECT,
    config.WEB_PUSH_ALLOWED_ORIGINS,
  ];
  if (values.every((value) => !value)) return undefined;
  if (values.some((value) => !value))
    throw new Error('Complete Web Push credentials and allowed origins are required');
  const publicKey = z
    .string()
    .regex(/^[A-Za-z0-9_-]{87}$/)
    .parse(config.WEB_PUSH_PUBLIC_KEY);
  const privateKey = z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .parse(config.WEB_PUSH_PRIVATE_KEY);
  const subject = z
    .string()
    .refine((s) => s.startsWith('mailto:') || s.startsWith('https://'))
    .parse(config.WEB_PUSH_SUBJECT);
  const origins = config
    .WEB_PUSH_ALLOWED_ORIGINS!.split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (
    !origins.length ||
    origins.some((origin) => !calendarPushEndpointAllowed(`${origin}/`, [origin]))
  )
    throw new Error('Web Push requires exact HTTPS provider origins');
  return {
    publicKey,
    async send(
      subscription: CalendarPushSubscription,
      reminderId: string,
      signal?: AbortSignal,
    ): Promise<'sent' | 'expired' | 'failed'> {
      signal?.throwIfAborted();
      if (!calendarPushEndpointAllowed(subscription.endpoint, origins)) return 'expired';
      try {
        // Encrypt with the maintained provider library, dispatch with native cancellation.
        // Fixed payload excludes calendar titles, source messages and account identifiers.
        const details = webpush.generateRequestDetails(
          subscription,
          JSON.stringify({ tag: reminderId }),
          {
            vapidDetails: { subject, publicKey, privateKey },
            TTL: 900,
            timeout: 5000,
          },
        );
        const status = await new Promise<number>((resolve, reject) => {
          const call = request(
            details.endpoint,
            {
              method: details.method,
              headers: details.headers,
              signal: signal
                ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
                : AbortSignal.timeout(5000),
            },
            (response) => {
              response.resume();
              resolve(response.statusCode ?? 500);
            },
          );
          call.once('error', reject);
          call.end(details.body);
        });
        return status >= 200 && status < 300
          ? 'sent'
          : [404, 410].includes(status)
            ? 'expired'
            : 'failed';
      } catch (error) {
        signal?.throwIfAborted();
        const parsed = z.object({ statusCode: z.number() }).safeParse(error);
        return parsed.success && [404, 410].includes(parsed.data.statusCode) ? 'expired' : 'failed';
      }
    },
  };
}
