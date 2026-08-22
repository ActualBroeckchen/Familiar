/**
 * phylactery-result.js — read an MCP tool result as success or failure.
 *
 * The MCP SDK's `callTool` does NOT throw when a tool reports failure — a tool
 * that raises (a pydantic validation error from a bad/missing argument, or any
 * exception) comes back as a RESOLVED result with `isError: true`, and a tool
 * that fails deliberately flags it in its own text. So a caller that just awaits
 * `callTool` and returns ok sees a failed write as a success. This is the silent
 * failure behind the identity_update_section bug (thalamus sent `heading` where
 * the tool wanted `section`, the validation error came back as an isError result,
 * and the HTTP API still answered {ok:true}) — and the whole class the static
 * contract checker structurally can't catch, because it's runtime error handling.
 *
 * `mcpToolError(result)` returns the failure text when the call did NOT succeed,
 * else null — so a wrapper can turn it into an honest {ok:false}. It is
 * server-agnostic: `isError` is set by both Phylactery and Unruh on a raise, and
 * the "Failed:" prefix is Phylactery's own deliberate-failure convention (a benign
 * extra check for Unruh, whose success payloads are JSON that starts with `{`).
 * Pure, so the detection is unit-tested without a live server.
 */

/**
 * @param {{ isError?: boolean, content?: Array<{type:string,text?:string}> }} result
 * @returns {string|null}  error text if the tool reported failure, else null
 */
export function mcpToolError(result) {
  const text = (result?.content?.find((c) => c?.type === 'text')?.text ?? '').trim();
  if (result?.isError) return text || 'MCP tool reported an error';
  // A tool's own failure convention: a leading "Failed:" / "Failed -".
  if (/^failed\b\s*[:\-]/i.test(text)) return text;
  return null;
}
