/**
 * @studyzy/dsh-web-remote-access/startup — a fork of `@deepseek-ai/dsh-web-app/startup` that
 * parses the `dsh --profile web` flag family (`--host`, `--port`,
 * `--trusted-host`, `--web_token`) and its `--help` text, then provides the
 * immutable values as {@link WEB_STARTUP_SERVICE}. Ordinary rows inject that
 * service before reading it from lazy config. The web token always exists:
 * the explicit `--web_token` wins, then `$DSH_WEB_TOKEN`, then a fresh random
 * token minted at startup — so an all-interfaces bind always runs behind the
 * gate and the printed URL always opens directly.
 */
import type { Context } from '@deepseek-ai/cordis';
/** Stable Cordis plugin name. */
export declare const name = "web-startup";
/** Services required before the flags can be resolved. */
export declare const inject: string[];
/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export declare const WEB_STARTUP_SERVICE = "webStartup";
/** Environment variable that supplies the web token when no `--web_token` is given. */
export declare const WEB_TOKEN_ENV = "DSH_WEB_TOKEN";
/** What the web rows read from {@link WEB_STARTUP_SERVICE}. */
export interface WebStartupValues {
    /** `--host`, absent when the invocation did not name one. */
    host?: string;
    /** `--port`, absent when the invocation did not name one. */
    port?: number;
    /** Explicit `--trusted-host` authorities, in argument order. */
    trustedHosts: string[];
    /** The active web token: `--web_token`, else `$DSH_WEB_TOKEN`, else a fresh random one. */
    webToken: string;
}
/** Test hooks: randomness and the environment seam. */
export declare const internals: {
    /** Mint the random fallback token; randomBytes(32) → base64url by default. */
    mintRandomToken: () => string;
    /** Read the `DSH_WEB_TOKEN` environment variable. */
    envWebToken: () => string | undefined;
};
/**
 * Parse and provide the Web invocation as an ordinary Cordis service. The
 * command's action publishes the flags this invocation named plus the resolved
 * web token; a non-numeric `--port` is a usage error, so on rejection (and on
 * `--help`) nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export declare function apply(ctx: Context): void;
