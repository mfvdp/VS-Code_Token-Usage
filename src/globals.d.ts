/**
 * The extension version, injected by build.mjs from package.json.
 *
 * Hard-coding it here is how the value we send to the Codex app-server drifted
 * to a version that had not existed for months; a build-time define cannot.
 */
declare const __EXT_VERSION__: string
