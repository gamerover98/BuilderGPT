/**
 * The one MCP fact both processes need to agree on.
 *
 * In `shared/` for the reason `openCodeModelRequiresKey` and `anchorLocation`
 * are: the settings pane has to show the command and the renderer may not
 * import out of `main/`, while `mcp/policy.ts` is where a test can hold it.
 * Two copies of a command line is two chances to get a flag wrong, and a wrong
 * flag produces a client that cannot connect and an error message about
 * neither.
 */

/**
 * The command to paste into a client, ready to run.
 *
 * Claude Code's spelling, because that is the client this was built against.
 * It is offered as a starting point rather than as the only way in — anything
 * that speaks Streamable HTTP and can send an `Authorization` header will do,
 * which is what the address and the token beside it are for.
 */
export function connectCommand(url: string, token: string): string {
  return `claude mcp add --transport http schematic ${url} --header "Authorization: Bearer ${token}"`;
}
