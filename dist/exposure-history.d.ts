import type { AgentSessionLike } from "./dsh.js";
/**
 * Rebuild the on-demand groups successfully opened in one Session.
 *
 * The tool call/result log is the durable source of truth. This intentionally
 * excludes a fork's inherited prefix so temporary capability choices do not
 * leak from the parent Session into a new child Session.
 */
export declare function restoredExposureNames(session: AgentSessionLike | undefined): Set<string>;
//# sourceMappingURL=exposure-history.d.ts.map