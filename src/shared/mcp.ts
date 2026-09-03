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
export function connectCommand(url: string, token: string | null): string {
  const base = `claude mcp add --transport http schematic ${url}`;
  /*
   * No header when there is no token. Printing an empty `Bearer ` would be a
   * command that looks right, runs, and then fails to connect -- with the
   * error naming authentication on a server that is not asking for any.
   */
  if (token === null || token === "") return base;
  return `${base} --header "Authorization: Bearer ${token}"`;
}

/**
 * The same, for a client that will only speak stdio.
 *
 * The bridge takes no arguments: it finds the running app through the discovery
 * file the server writes, which is also why the port may be `0` — nothing has
 * to agree on a number in two places.
 */
export function bridgeCommand(bridgePath: string): string {
  return `claude mcp add schematic -- node "${bridgePath}"`;
}
