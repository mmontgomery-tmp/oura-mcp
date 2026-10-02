// The wrapper every tool handler runs in: times the call, logs "tool ok" or "tool error", and
// turns a thrown error into an MCP tool error (isError) instead of a protocol failure.

export type Log = (msg: string, extra?: Record<string, unknown>) => void;

/** A problem with what the caller sent; its message is shown to the model as the tool's error. */
export class ToolInputError extends Error {}

export function toolRunner(log: Log) {
  /** `note` adds fields (for example the resolved date range) to the "tool ok" log line. */
  return function run<I>(name: string, body: (input: I, note: (extra: Record<string, unknown>) => void) => Promise<unknown>) {
    return async (input: I) => {
      const started = Date.now();
      const noted: Record<string, unknown> = {};
      try {
        const result = await body(input, (extra) => Object.assign(noted, extra));
        log('tool ok', { tool: name, ...noted, ms: Date.now() - started });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log('tool error', { tool: name, error: message, kind: err instanceof Error ? err.name : typeof err, ms: Date.now() - started });
        return { isError: true, content: [{ type: 'text' as const, text: message }] };
      }
    };
  };
}
