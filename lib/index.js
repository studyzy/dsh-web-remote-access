/**
 * @studyzy/dsh-web-remote-access — out-of-tree dsh web-profile bundle.
 * The ./startup subpath replaces the web-app startup row it forks; ./url,
 * ./polyfill and ./loopback add the remote-access glue. This index entry keeps
 * the package self-describing.
 */
export { WEB_STARTUP_SERVICE } from './startup.js';
