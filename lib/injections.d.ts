/**
 * Structured index injections — vendored verbatim from `@deepseek-ai/dsh-host-webserver`
 * (MIT, upstream 0.1.1-rc.1). The fork's webserver must render these rows on
 * every index response because the 0.1.1 harness's `frontend-static` fallback
 * owner calls `ctx.webServer.renderIndex`, and the structured table is how the
 * client-modules boot table (`window.__DSH_BOOT__`) and the theme preference
 * reach the served page. Rows are pure JSON-serializable data because one
 * table feeds two renderers: the served form renders rows into the index.html
 * text ({@link renderIndexInjections}), and a static worker deployment ships
 * the same rows over its boot payload for a page-side interpreter. Anything
 * not expressible as a row stays on `tapIndex`, which runs after row rendering.
 */
/** Document region a rendered row lands in: after the opening head or body tag. */
export type IndexInjectionPlacement = 'head' | 'body';
/** One structured index injection row. */
export type IndexInjection = 
/** Assign a JSON-serializable value to a `globalThis` property, ahead of later script rows. */
{
    kind: 'global';
    name: string;
    value: unknown;
}
/** Inline classic script. `text` must not contain `</script`, which would close the element early. */
 | {
    kind: 'script';
    placement: IndexInjectionPlacement;
    text: string;
}
/**
 * External classic script, executed in table order: a parser-blocking tag
 * when served, an awaited fetch-and-execute in the worker form (whose
 * loader resolves worker-only URLs such as `/plugins/...`).
 */
 | {
    kind: 'script-src';
    placement: IndexInjectionPlacement;
    src: string;
}
/** A `<style>` element in the head. `text` must not contain `</style`, which would close the element early. */
 | {
    kind: 'style';
    text: string;
}
/** Raw markup fragment. */
 | {
    kind: 'html';
    placement: IndexInjectionPlacement;
    html: string;
};
/**
 * Render rows into an index.html body: head rows immediately after the
 * opening head tag, body rows immediately after the opening body tag, each
 * group in table order.
 * @param html - the raw index.html body.
 * @param rows - the collected injection table.
 * @returns the html with every row rendered.
 */
export declare function renderIndexInjections(html: string, rows: readonly IndexInjection[]): string;
