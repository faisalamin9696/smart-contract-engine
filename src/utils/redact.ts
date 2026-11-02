/**
 * Log helpers that make configuration mistakes visible without ever leaking secrets.
 */

/**
 * Renders a database connection string for logs: host, port, database and username
 * are kept (they explain *which* server we talk to), the password is masked.
 */
export function maskDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const user = parsed.username ? `${parsed.username}:***@` : '';
    return `${parsed.protocol}//${user}${parsed.host}${parsed.pathname}`;
  } catch {
    return '<unparsable DATABASE_URL>';
  }
}
