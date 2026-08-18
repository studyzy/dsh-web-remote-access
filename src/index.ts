/**
 * @studyzy/dsh-web-remote-access — out-of-tree dsh web-profile bundle.
 * Subpath plugins (./startup, ./webserver, ./url) replace the web-app rows
 * they fork; this index entry keeps the package self-describing.
 */

export { WEB_STARTUP_SERVICE, type WebStartupValues } from './startup.js'
