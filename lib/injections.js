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
/** Escape a row value before placing it in a quoted HTML attribute. */
function escapeHtmlAttribute(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}
function assertNever(row) {
    throw new Error(`webserver: unknown index injection row ${JSON.stringify(row)}`);
}
/** Render one row to markup with its placement. */
function renderRow(row) {
    switch (row.kind) {
        case 'global': {
            // `<` is escaped in JSON so a row-controlled string cannot break out of
            // the script element.
            const name = JSON.stringify(row.name).replaceAll('<', '\\u003c');
            const value = row.value === undefined
                ? 'undefined'
                : JSON.stringify(row.value).replaceAll('<', '\\u003c');
            return { placement: 'head', markup: `<script>globalThis[${name}] = ${value}</script>` };
        }
        case 'script':
            return { placement: row.placement, markup: `<script>${row.text}</script>` };
        case 'script-src':
            return { placement: row.placement, markup: `<script src="${escapeHtmlAttribute(row.src)}"></script>` };
        case 'style':
            return { placement: 'head', markup: `<style>${row.text}</style>` };
        case 'html':
            return { placement: row.placement, markup: row.html };
        default:
            return assertNever(row);
    }
}
/** Insert `markup` into `html` at `at`. */
function splice(html, at, markup) {
    return `${html.slice(0, at)}${markup}${html.slice(at)}`;
}
/**
 * Render rows into an index.html body: head rows immediately after the
 * opening head tag, body rows immediately after the opening body tag, each
 * group in table order.
 * @param html - the raw index.html body.
 * @param rows - the collected injection table.
 * @returns the html with every row rendered.
 */
export function renderIndexInjections(html, rows) {
    let head = '';
    let body = '';
    for (const row of rows) {
        const rendered = renderRow(row);
        if (rendered.placement === 'head')
            head += rendered.markup;
        else
            body += rendered.markup;
    }
    let out = html;
    if (head !== '') {
        const open = /<head(?:\s[^>]*)?>/i.exec(out);
        // Headless fixture pages may lack <head>; prepending keeps the rows ahead
        // of every document script.
        out = open === null ? `${head}${out}` : splice(out, open.index + open[0].length, head);
    }
    if (body !== '') {
        const open = /<body(?:\s[^>]*)?>/i.exec(out);
        // Body-less fragments receive the rows at the end, where the HTML parser
        // has already synthesized a body.
        out = open === null ? `${out}${body}` : splice(out, open.index + open[0].length, body);
    }
    return out;
}
