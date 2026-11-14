export class ImportError extends Error {}

export function log(event: string, details: object = {}): void {
  const line = JSON.stringify({ time: new Date().toISOString(), event, ...details });
  (event === 'error' ? console.error : console.log)(line);
}

// Only application-authored messages are safe to print. Third-party errors can
// contain connection details or data from an email or worksheet.
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ImportError ? error.message : fallback;
}
