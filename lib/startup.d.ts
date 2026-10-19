/**
 * @studyzy/dsh-web-remote-access/startup — a fork of `@deepseek-ai/dsh-web-app/startup` that
 * parses the `dsh --profile web` flag family (`--host`, `--port`,
 * `--trusted-host`) and its `--help` text, then provides the immutable values
 * as {@link WEB_STARTUP_SERVICE}. Ordinary rows inject that service before
 * reading it from lazy config.
 *
 * The one divergence from upstream: upstream rejects a wildcard bind
 * (`--host 0.0.0.0`) outright, because binding every interface would expose
 * remote code execution to the network, and tells the user to name a concrete
 * interface address instead. This fork keeps the convenient `--host 0.0.0.0`
 * spelling and resolves it to this machine's first non-internal IPv4 address,
 * so the stock webserver row binds a concrete address while remote clients are
 * still gated by the harness's own launch-token session cookie.
 *
 * The flag parse and bounded-exit wiring is a vendored port of
 * `@deepseek-ai/dsh-cmdline`'s `parseCmdline` (MIT). This bundle forks the
 * official startup, and depending on that rc package pulled an unsatisfied
 * `dsh-invariants` peer into every profile install (the harness resolves
 * out-of-tree peers at runtime, but pnpm still warns). Inlining the ~40 lines
 * keeps consumers install-clean and independent of rc churn.
 */
import type { Context } from '@deepseek-ai/cordis';
/** Stable Cordis plugin name. */
export declare const name = "web-startup";
/** Services required before the flags can be resolved. */
export declare const inject: string[];
/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export declare const WEB_STARTUP_SERVICE = "webStartup";
/** What the web rows read from {@link WEB_STARTUP_SERVICE}. */
export interface WebStartupValues {
    /** Whether this invocation opens the default browser after startup. */
    openBrowser: boolean;
    /** `--host`, absent when the invocation did not name one. */
    host?: string;
    /** `--port`, absent when the invocation did not name one. */
    port?: number;
    /** `--cookie-max-age-days`, absent when the invocation did not name one (harness default: 30). */
    cookieMaxAgeDays?: number;
    /** Explicit `--trusted-host` authorities, in argument order. */
    trustedHosts: string[];
    /** Whether the resolved bind address serves beyond this machine (a non-loopback literal). */
    remote: boolean;
}
/** Test hooks: the interface probe and the output streams. */
export declare const internals: {
    /** Non-internal IPv4 addresses of this machine; tests replace this to fix the set. */
    lanAddresses: () => string[];
    /** Process stream commander output is written to; tests replace these to capture text. */
    stdout: {
        write(chunk: string): unknown;
    };
    stderr: {
        write(chunk: string): unknown;
    };
};
/**
 * Parse and provide the Web invocation as an ordinary Cordis service. The
 * command's action publishes the flags this invocation named plus the resolved
 * web token; a non-numeric `--port` is a usage error, so on rejection (and on
 * `--help`) nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export declare function apply(ctx: Context): void;
