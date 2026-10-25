/**
 * Micron Parser JavaScript implementation
 *
 * micron-parser.js is based on MicronParser.py from NomadNet:
 * https://raw.githubusercontent.com/markqvist/NomadNet/refs/heads/master/nomadnet/ui/textui/MicronParser.py
 *
 * Documentation for the Micron markdown format can be found here:
 * https://raw.githubusercontent.com/markqvist/NomadNet/refs/heads/master/nomadnet/ui/textui/Guide.py
 */
 
class MicronParser {

    constructor(darkTheme = true, enableForceMonospace = true) {
        this.darkTheme = darkTheme;
        this.enableForceMonospace = enableForceMonospace;
        this.DEFAULT_FG_DARK = "ddd";
        this.DEFAULT_FG_LIGHT = "222";
        this.DEFAULT_BG = "default";

        if (this.enableForceMonospace) {
            this.injectMonospaceStyles();
        }

        try {
            if (typeof DOMPurify === 'undefined') {
                console.warn('DOMPurify is not installed. Include it above micron-parser.js or run npm install dompurify');
            }
        } catch (error) {
            console.warn('DOMPurify is not installed. Include it above micron-parser.js or run npm install dompurify');
        }

        this.SELECTED_STYLES = null;

        this.STYLES_DARK = {
            "plain": {fg: this.DEFAULT_FG_DARK, bg: this.DEFAULT_BG, bold: false, underline: false, italic: false},
            "heading1": {fg: "222", bg: "bbb", bold: false, underline: false, italic: false},
            "heading2": {fg: "111", bg: "999", bold: false, underline: false, italic: false},
            "heading3": {fg: "000", bg: "777", bold: false, underline: false, italic: false}
        };

        this.STYLES_LIGHT = {
            "plain": {fg: this.DEFAULT_FG_LIGHT, bg: this.DEFAULT_BG, bold: false, underline: false, italic: false},
            "heading1": {fg: "000", bg: "777", bold: false, underline: false, italic: false},
            "heading2": {fg: "111", bg: "aaa", bold: false, underline: false, italic: false},
            "heading3": {fg: "222", bg: "ccc", bold: false, underline: false, italic: false}
        };

        if (this.darkTheme) {
            this.SELECTED_STYLES = this.STYLES_DARK;
        } else {
            this.SELECTED_STYLES = this.STYLES_LIGHT;
        }

    }

    injectMonospaceStyles() {
        if (document.getElementById('micron-monospace-styles')) {
            return;
        }

        const styleEl = document.createElement('style');
        styleEl.id = 'micron-monospace-styles';

        styleEl.textContent = `
            .Mu-nl {
                cursor: pointer;
            }
            /* One character cell. The width used to be a hardcoded 0.6em,
               a guess at the font's advance: whenever the resolved font did
               not happen to advance by exactly that, every cell was slightly
               off and the error accumulated across the line, skewing
               artwork. 1ch IS the advance width of the "0" glyph in the
               current font, measured by the browser, so the cells tile
               exactly however the font resolves. */
            /* line-height: inherit, not a fixed 1.
               The cell is an inline-block, so its painted height is its own
               line box. Pinning that to 1 while the row around it is taller
               leaves an unpainted strip between rows - the scanlines that
               broke block art. Inheriting means the cell is always exactly
               as tall as the row, whatever height the page chooses, so the
               cell aspect ratio can be tuned to match a terminal without
               the gaps coming back. */
            .Mu-mnt {
                display: inline-block;
                width: 1ch;
                text-align: center;
                white-space: pre;
                text-decoration: inherit;
                line-height: inherit;
                vertical-align: top;
            }
            .Mu-mws {
                text-decoration: inherit;
                display: inline-block;
                line-height: inherit;
                vertical-align: top;
            }
        `;
        document.head.appendChild(styleEl);
    }

    // Page colours, as NomadNet reads them (Browser.py, render_markup_buffer):
    // #!bg=X and #!fg=X on a line of their own, X of 3 characters (rgb or
    // gNN grey) or 6 (rrggbb). fg is the colour of plain text, `f and ``
    // go back to it; bg is the background of the whole page (rbrowser.js
    // applyPageColors puts it on the page box).
    static pageColors(markup) {
        const out = { bg: null, fg: null };
        for (const key of ["bg", "fg"]) {
            const m = String(markup || "").match(new RegExp("^#!" + key + "=([0-9a-fA-F]{6}|[0-9a-fA-Fg][0-9a-fA-F]{2})\\r?$", "m"));
            if (m) out[key] = m[1];
        }
        return out;
    }

    static formatNomadnetworkUrl(url) {
        return `nomadnetwork://${url}`;
    }

    convertMicronToHtml(markup) {
        let html = "";

        const pageFg = MicronParser.pageColors(markup).fg || this.SELECTED_STYLES.plain.fg;
        let state = {
            literal: false,
            depth: 0,
            fg_color: pageFg,
            page_fg: pageFg,          // `f and `` go back to it (#!fg=)
            bg_color: this.DEFAULT_BG,
            formatting: {
                bold: false,
                underline: false,
                italic: false,
                strikethrough: false
            },
            default_align: "left",
            align: "left",
            radio_groups: {},
            // Table mode buffers lines between two `t markers (NomadNet 1.4.x)
            table_mode: false,
            table_buffer: [],
            table_align: null,
            table_maxwidth: null,
            // Glyphs for collapsible sections, overridable with #!fold
            fold_glyphs: ["▼", "▶"],
            pending_anchors: []
        };

        // CRLF too: a \r left on the line becomes a half cell in HTML and
        // pushes centred art off by one step (rmap's header.mu).
        const lines = markup.split(/\r?\n/);

        for (let line of lines) {
            const lineOutput = this.parseLine(line, state);
            if (lineOutput && lineOutput.length > 0) {
                for (let el of lineOutput) {
                    html += el.outerHTML;
                }
            } else if (lineOutput && lineOutput.length === 0) {
                // skip
            } else {
                html += "<br>";
            }
        }


       try {
        return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
       } catch (error) {
            console.warn('DOMPurify is not installed. Include it above micron-parser.js or run npm install dompurify ', error);
            return `<p style="color: red;"> ⚠ DOMPurify is not installed. Include it above micron-parser.js or run npm install dompurify </p>`;
       }
    }

    convertMicronToFragment(markup) {
        // Create a fragment to hold all the Micron output
        const fragment = document.createDocumentFragment();

        const pageFg = MicronParser.pageColors(markup).fg || this.SELECTED_STYLES.plain.fg;
        let state = {
            literal: false,
            depth: 0,
            fg_color: pageFg,
            page_fg: pageFg,
            bg_color: this.DEFAULT_BG,
            formatting: {
                bold: false,
                underline: false,
                italic: false,
                strikethrough: false
            },
            default_align: "left",
            align: "left",
            radio_groups: {},
            // Table mode buffers lines between two `t markers (NomadNet 1.4.x)
            table_mode: false,
            table_buffer: [],
            table_align: null,
            table_maxwidth: null,
            // Glyphs for collapsible sections, overridable with #!fold
            fold_glyphs: ["▼", "▶"],
            pending_anchors: []
        };

        const lines = markup.split(/\r?\n/);

        for (let line of lines) {
            line = DOMPurify.sanitize(line, { USE_PROFILES: { html: true } });
            const lineOutput = this.parseLine(line, state);
            if (lineOutput && lineOutput.length > 0) {
                for (let el of lineOutput) {

                    fragment.appendChild(el);
                }
            } else if (lineOutput && lineOutput.length === 0) {
                // skip
            } else {
                fragment.appendChild(document.createElement("br"));
            }
        }

        return fragment;
    }

    parseLine(line, state) {
        if (line.length > 0) {
            // Check literals toggle
            if (line === "`=") {
                state.literal = !state.literal;
                return null;
            }


            if (!state.literal) {
                // Collapsible section heading: `+> open, `-> starts collapsed
                let collapsible = false;
                let collapsedInitial = false;
                if ((line.startsWith("`+") || line.startsWith("`-")) && line[2] === ">") {
                    collapsible = true;
                    collapsedInitial = line[1] === "-";
                    line = line.slice(2);
                }

                // A line carrying a form field is not a heading, whatever it
                // starts with - same sanitisation NomadNet applies.
                if (line[0] === ">" && line.includes("`<")) {
                    line = line.replace(/^>+/, "");
                }

                // Comments, and the #!fold directive that rides on them
                if (line[0] === "#") {
                    const parts = line.split(/\s+/);
                    if (parts[0] === "#!fold") {
                        if (parts.length >= 3)      state.fold_glyphs = [parts[1], parts[2]];
                        else if (parts.length === 2) state.fold_glyphs = [parts[1], parts[1]];
                    }
                    return [];
                }

                // Tables: `t opens, the next `t closes and renders
                if (line.startsWith("`t")) {
                    let rest = line.slice(2);
                    let align = (rest.length && "lcr".includes(rest[0])) ? rest[0] : null;
                    if (align) rest = rest.slice(1);
                    let maxWidth = parseInt(rest, 10);
                    if (isNaN(maxWidth)) maxWidth = null;

                    if (state.table_mode) {
                        const rendered = this.renderTable(state.table_buffer, state);
                        state.table_mode = false;
                        state.table_buffer = [];
                        state.table_align = null;
                        state.table_maxwidth = null;
                        return rendered || [];
                    }

                    state.table_mode = true;
                    state.table_buffer = [];
                    state.table_align = align;
                    state.table_maxwidth = maxWidth;
                    return [];
                }

                // Inside a table, every line is just a row to buffer
                if (state.table_mode) {
                    state.table_buffer.push(line);
                    return [];
                }

                // Page partials: `{url`refresh`fields}
                if (line.startsWith("`{")) {
                    return this.parsePartial(line.slice(2), state) || [];
                }

                // Inline images: `(alt`w=..`h=..`a=c`url)
                if (line.startsWith("`(")) {
                    return this.parseImage(line.slice(2), state) || [];
                }

                // Reset section depth
                if (line[0] === "<") {
                    state.depth = 0;
                    return this.parseLine(line.slice(1), state);
                }

                // Section headings
                if (line[0] === ">") {
                    let i = 0;
                    while (i < line.length && line[i] === ">") {
                        i++;
                    }
                    state.depth = i;
                    let headingLine = line.slice(i);

                    if (headingLine.length > 0) {
                        // apply heading style if it exists
                        let style = null;
                        let wanted_style = "heading" + i;
                        if (this.SELECTED_STYLES[wanted_style]) {
                            style = this.SELECTED_STYLES[wanted_style];
                        } else {
                            style = this.SELECTED_STYLES.plain;
                        }

                        const latched_style = this.stateToStyle(state);
                        this.styleToState(style, state);

                        let outputParts = this.makeOutput(state, headingLine);
                        this.styleToState(latched_style, state);

                        // make outputParts full container width
                        if (outputParts && outputParts.length > 0) {
                            const outerDiv = document.createElement("div");
                            outerDiv.style.display = "inline-block";
                            outerDiv.style.width = "100%";
                            this.applyStyleToElement(outerDiv, style);

                            const innerDiv = document.createElement("div");
                            this.applySectionIndent(innerDiv, state);

                            this.appendOutput(innerDiv, outputParts, state);

                            // Collapsible section: tag the heading and let the
                            // post-pass group the lines under it. The marker
                            // goes in first so it lines up with the text.
                            if (collapsible) {
                                outerDiv.dataset.micronFold = collapsedInitial ? "collapsed" : "open";
                                outerDiv.dataset.foldDepth = String(i);
                                outerDiv.dataset.foldGlyphs = state.fold_glyphs.join(",");
                                outerDiv.style.cursor = "pointer";
                                const marker = document.createElement("span");
                                marker.className = "micron-fold-marker";
                                marker.textContent =
                                    (collapsedInitial ? state.fold_glyphs[1] : state.fold_glyphs[0]) + " ";
                                innerDiv.insertBefore(marker, innerDiv.firstChild);
                            }

                            outerDiv.appendChild(innerDiv);

                            const br = document.createElement("br");
                            return [outerDiv, br]
                        }
                        // wrap in a heading container
                        if (outputParts && outputParts.length > 0) {
                            const div = document.createElement("div");
                            this.applyAlignment(div, state);
                            this.applySectionIndent(div, state);
                            // merge text nodes
                            this.appendOutput(div, outputParts, state);
                            return [div];
                        } else {
                            return null;
                        }
                    } else {
                        return null;
                    }
                }

                // horizontal dividers
                if (line[0] === "-") {
                    // if the line is  just "-", do a normal <hr>
                    if (line.length === 1) {
                        const hr = document.createElement("hr");
                        hr.style.all = "revert";
                        hr.style.borderColor = this.colorToCss(state.fg_color);
                        hr.style.margin = "0.5em 0.5em 0.5em 0.5em";
                        hr.style.boxShadow = "0 0 0 0.5em " + this.colorToCss(state.bg_color);
                        this.applySectionIndent(hr, state);
                        return [hr];
                    } else {
                        // if second char given
                        const dividerChar = line[1];  // use the following character for creating the divider
                        const repeated = dividerChar.repeat(250);

                        const div = document.createElement("div");
                        div.style.whiteSpace = "pre";   // needs to not wrap and ignore container formatting
                        div.textContent = repeated;
                        div.style.width = "100%";
                        div.style.whiteSpace = "nowrap";
                        div.style.overflow = "hidden";
                        div.style.color = this.colorToCss(state.fg_color);
                        div.style.backgroundColor = this.colorToCss(state.bg_color);
                        this.applySectionIndent(div, state);

                        return [div];
                    }
                }

            }

            let outputParts = this.makeOutput(state, line);
            // outputParts can contain text (tuple) and special objects (fields/checkbox)
            if (outputParts) {

                // create parent div container to apply proper section indent
                let container = document.createElement("div");
                this.applyAlignment(container, state);
                this.applySectionIndent(container, state);

                this.appendOutput(container, outputParts, state);

                // if theres a background color, wrap with outer div
                if (state.bg_color !== this.DEFAULT_BG) {
                    const outerDiv = document.createElement("div");
                    outerDiv.style.backgroundColor = this.colorToCss(state.bg_color);
                    outerDiv.style.width = "100%";
                    outerDiv.style.display = "block";
                    // same downward bleed as on the inline runs
                    outerDiv.style.boxShadow = "0 1px 0 0 " + this.colorToCss(state.bg_color);
                    outerDiv.appendChild(container);
                    return [outerDiv];
                }
                return [container];
            } else {
                // empty line but maintain background color if set
                const br = document.createElement("br");
                if (state.bg_color !== this.DEFAULT_BG) {
                    const outerDiv = document.createElement("div");
                    outerDiv.style.backgroundColor = this.colorToCss(state.bg_color);
                    outerDiv.style.width = "100%";
                    outerDiv.style.height = "1em";
                    outerDiv.style.lineHeight = "inherit";
                    outerDiv.style.display = "block";
                    outerDiv.style.boxShadow = "0 1px 0 0 " + this.colorToCss(state.bg_color);

                    const innerDiv = document.createElement("div");
                    this.applySectionIndent(innerDiv, state);
                    innerDiv.appendChild(br);
                    outerDiv.appendChild(innerDiv);

                    return [outerDiv];
                }
                return [br];
            }
        } else {
            // Empty line handling for just newline background color
            const br = document.createElement("br");
            if (state.bg_color !== this.DEFAULT_BG) {
                const outerDiv = document.createElement("div");
                outerDiv.style.backgroundColor = this.colorToCss(state.bg_color);
                outerDiv.style.width = "100%";
                outerDiv.style.height = "1em";
                outerDiv.style.lineHeight = "inherit";
                outerDiv.style.display = "block";
                outerDiv.style.boxShadow = "0 1px 0 0 " + this.colorToCss(state.bg_color);

                const innerDiv = document.createElement("div");
                this.applySectionIndent(innerDiv, state);
                innerDiv.appendChild(br);
                outerDiv.appendChild(innerDiv);

                return [outerDiv];
            }
            return [br];
        }
    }

    applyAlignment(el, state) {
        // use CSS text-align for alignment
        el.style.textAlign = state.align || "left";
    }

    applySectionIndent(el, state) {
        // indent by state.depth
        let indent = (state.depth - 1) * 2;
        if (indent > 0 ) {
            // Indent according to forceMonospace() character width
            el.style.marginLeft = (indent * 0.6) + "em";
        }
    }

    // convert current state to a style object
    stateToStyle(state) {
        return {
            fg: state.fg_color,
            bg: state.bg_color,
            bold: state.formatting.bold,
            underline: state.formatting.underline,
            italic: state.formatting.italic
        };
    }

    styleToState(style, state) {
        if (style.fg !== undefined && style.fg !== null) state.fg_color = style.fg;
        if (style.bg !== undefined && style.bg !== null) state.bg_color = style.bg;
        if (style.bold !== undefined && style.bold !== null) state.formatting.bold = style.bold;
        if (style.underline !== undefined && style.underline !== null) state.formatting.underline = style.underline;
        if (style.italic !== undefined && style.italic !== null) state.formatting.italic = style.italic;
    }

    appendOutput(container, parts, state) {

        let currentSpan = null;
        let currentStyle = null;

         const flushSpan = () => {
            if (currentSpan) {
                if (currentStyle && currentStyle.bg !== this.DEFAULT_BG) {
                    currentSpan.style.display = "inline-block";
                    // No horizontal padding. It used to add 2px on each side
                    // of every coloured run: in artwork, which is dozens of
                    // short runs per line, that is 4px of invented width per
                    // run, and the columns drift further out of line with
                    // every colour change across the row.
                    currentSpan.style.lineHeight = "inherit";
                    currentSpan.style.verticalAlign = "top";
                    // Same one-pixel downward bleed as applyStyleToElement:
                    // closes the rounding seam with the row below without
                    // taking space or changing the width.
                    const bleed = this.colorToCss(currentStyle.bg);
                    if (bleed) currentSpan.style.boxShadow = "0 1px 0 0 " + bleed;
                }
                container.appendChild(currentSpan);
                currentSpan = null;
                currentStyle = null;
            }
        };

        for (let p of parts) {
            if (typeof p === 'string') {
                let span = document.createElement("span");
                span.innerHTML = p;
                container.appendChild(span);
            } else if (Array.isArray(p) && p.length === 2) {
                // tuple: [styleSpec, text]
                let [styleSpec, text] = p;
                // if different style, flush currentSpan
                if (!this.stylesEqual(styleSpec, currentStyle)) {
                    flushSpan();
                    currentSpan = document.createElement("span");
                    this.applyStyleToElement(currentSpan, styleSpec);
                    currentStyle = styleSpec;
                }
                currentSpan.innerHTML += text;
            } else if (p && typeof p === 'object') {
                // field, checkbox, radio, link, raw element
                flushSpan();
                if (p.type === "element") {
                    container.appendChild(p.element);
                    continue;
                }
                if (p.type === "field" && p.rows && p.rows > 1) {
                    // Multi-row field: NomadNet writes these as `<24x5|name`>
                    // and expects a real text area, not a one-line box.
                    let area = document.createElement("textarea");
                    area.name = p.name;
                    area.value = p.data || "";
                    area.rows = p.rows;
                    area.cols = p.width || 24;
                    this.applyStyleToElement(area, this.styleFromState(p.style));
                    container.appendChild(area);
                } else if (p.type === "field") {
                    let input = document.createElement("input");
                    input.type = p.masked ? "password" : "text";
                    input.name = p.name;
                    input.setAttribute('value', p.data);
                    if (p.width) {
                        input.size = p.width;
                    }
                    this.applyStyleToElement(input, this.styleFromState(p.style));
                    container.appendChild(input);
                } else if (p.type === "checkbox") {
                    let label = document.createElement("label");
                    let cb = document.createElement("input");
                    cb.type = "checkbox";
                    cb.name = p.name;
                    cb.value = p.value;
                    if (p.prechecked) cb.setAttribute('checked', true);
                    label.appendChild(cb);
                    label.appendChild(document.createTextNode(" " + p.label));
                    this.applyStyleToElement(label, this.styleFromState(p.style));
                    container.appendChild(label);
                } else if (p.type === "radio") {
                    let label = document.createElement("label");
                    let rb = document.createElement("input");
                    rb.type = "radio";
                    rb.name = p.name;
                    rb.value = p.value;
                    if (p.prechecked) rb.setAttribute('checked', true);
                    label.appendChild(rb);
                    label.appendChild(document.createTextNode(" " + p.label));
                    this.applyStyleToElement(label, this.styleFromState(p.style));
                    container.appendChild(label);
                } else if (p.type === "link") {

                    // lxmf:// stays: an LXMF address (rbrowser.js lxmfUrlToAt), not a node.
                    let directURL = p.url.replace('nomadnetwork://', '');
                    // use p.url as is for the href
                    const formattedUrl = p.url;

                    let a = document.createElement("a");
                    a.href = formattedUrl;
                    a.title = formattedUrl;

                    let fieldsToSubmit = [];
                    let requestVars = {};
                    let foundAll = false;

                    if (p.fields && p.fields.length > 0) {
                        for (const f of p.fields) {
                            if (f === '*') {
                                // submit all fields
                                foundAll = true;
                            } else if (f.includes('=')) {
                                // this is a request variable (key=value)
                                const [k, v] = f.split('=');
                                requestVars[k] = v;
                            } else {
                                // this is a field name to submit
                                fieldsToSubmit.push(f);
                            }
                        }

                        let fieldStr = '';
                        if (foundAll) {
                            // if '*' was found, submit all fields
                            fieldStr = '*';
                        } else {
                            fieldStr = fieldsToSubmit.join('|');
                        }

                        // append request variables directly to the directURL as query parameters
                        const varEntries = Object.entries(requestVars);
                        if (varEntries.length > 0) {
                            const queryString = varEntries.map(([k, v]) => `${k}=${v}`).join('|');

                            directURL += directURL.includes('`') ? `|${queryString}` : `\`${queryString}`;
                        }

                        a.setAttribute("data-destination", `${directURL}`);
                        a.setAttribute("data-fields", `${fieldStr}`);
                    } else {
                        // no fields or request variables, just handle the direct URL
                        a.setAttribute("data-destination", `${directURL}`);
                    }
                    a.classList.add('Mu-nl');
                    a.setAttribute('data-action', "openNode");
                    a.innerHTML = p.label;
                    this.applyStyleToElement(a, this.styleFromState(p.style));
                    container.appendChild(a);
                }

            }
        }

        flushSpan();
    }

    stylesEqual(s1, s2) {
        if (!s1 && !s2) return true;
        if (!s1 || !s2) return false;
        return (s1.fg === s2.fg && s1.bg === s2.bg && s1.bold === s2.bold && s1.underline === s2.underline && s1.italic === s2.italic);
    }

    styleFromState(stateStyle) {
        // stateStyle is a name of a style or a style object
        // in this code, p.style is actually a style name. j,ust return that
        return stateStyle;
    }

applyStyleToElement(el, style) {
        if (!style) return;
        // convert style fg/bg to colors
        let fgColor = this.colorToCss(style.fg);
        let bgColor = this.colorToCss(style.bg);

        if (fgColor && fgColor !== "default") {
            el.style.color = fgColor;
        }
        if (bgColor && bgColor !== "default") {
            el.style.backgroundColor = bgColor;
            el.style.display = "inline-block";
            el.style.lineHeight = "inherit";
            el.style.verticalAlign = "top";
            // Bleed the colour one pixel DOWNWARD past the box.
            //
            // A row is font-size x line-height tall, which is almost never a
            // whole number of device pixels - 15px at 1.15 is 17.25, and any
            // zoom factor makes it worse. The boundary pixel row is then
            // shared: the row above covers a quarter of it and the row below
            // three quarters, and what shows through the gap in the middle
            // is the page background. That is the scanline.
            //
            // One pixel, not half: at a device pixel ratio of 1 - an
            // ordinary desktop monitor - half a CSS pixel can round away to
            // nothing and paint no shadow at all. On a phone, where the
            // ratio is 2.5 or 3, half a pixel was already enough, which is
            // why the seams showed on desktop only.
            //
            // Downward only, not on every side: a shadow spreading sideways
            // would eat a pixel of the run before it, shifting every
            // vertical colour boundary in the artwork. Offsetting with no
            // spread keeps the box exactly as wide as it was.
            //
            // A box-shadow takes no space and shifts nothing, so none of
            // this touches the character grid.
            el.style.boxShadow = "0 1px 0 0 " + bgColor;
        }

        if (style.bold) {
            el.style.fontWeight = "bold";
        }
        if (style.underline) {
            el.style.textDecoration = (el.style.textDecoration ? el.style.textDecoration + " underline" : "underline");
        }
        if (style.italic) {
            el.style.fontStyle = "italic";
        }
    }

    colorToCss(c) {
        if (!c || c === "default") return null;
        // if 3 hex chars (like '222') => expand to #222
        if (c.length === 3 && /^[0-9a-fA-F]{3}$/.test(c)) {
            return "#" + c;
        }
        // If 6 hex chars
        if (c.length === 6 && /^[0-9a-fA-F]{6}$/.test(c)) {
            return "#" + c;
        }
        // If grayscale 'gxx'
        if (c.length === 3 && c[0] === 'g') {
            // treat xx as a number and map to gray
            let val = parseInt(c.slice(1), 10);
            if (isNaN(val)) val = 50;
            // map 0-99 scale to a gray hex
            let h = Math.floor(val * 2.55).toString(16).padStart(2, '0');
            return "#" + h + h + h;
        }

        // fallback: just return a known CSS color or tailwind class if not known
        return null;
    }

    makeOutput(state, line) {
        if (state.literal) {
            // literal mode: output as is, except if `= line
            if (line === "\\`=") {
                line = "`=";
            }
            if(this.enableForceMonospace) {
                return [[this.stateToStyle(state), this.splitAtSpaces(line)]];
            } else {
                return [[this.stateToStyle(state), line]];
            }
        }

        let output = [];
        let part = "";
        let mode = "text";
        let escape = false;
        let skip = 0;

        const flushPart = () => {
            if (part.length > 0) {
                if(this.enableForceMonospace) {
                    output.push([this.stateToStyle(state), this.splitAtSpaces(part)]);
                } else {
                    output.push([this.stateToStyle(state), part]);
                }
                part = "";
            }
        };

        let i = 0;
        while (i < line.length) {
            let c = line[i];

            if (skip > 0) {
                skip--;
                i++;
                continue;
            }

            if (mode === "formatting") {
                switch (c) {
                    case '_':
                        state.formatting.underline = !state.formatting.underline;
                        break;
                    case '!':
                        state.formatting.bold = !state.formatting.bold;
                        break;
                    case '*':
                        state.formatting.italic = !state.formatting.italic;
                        break;

                    case 'F':
                        // `Frgb is the 12-bit shorthand; `FTrrggbb is the
                        // 24-bit form NomadNet also accepts
                        // (MicronParser.py, the "T" branch of F and B).
                        // Reading a fixed three characters turned `FTff8800
                        // into the colour "Tff" followed by "8800" printed
                        // as page text.
                        if (line.length >= i + 8 && line[i + 1] === 'T') {
                            state.fg_color = line.substr(i + 2, 6);
                            skip = 7;
                        } else if (line.length >= i + 4) {
                            state.fg_color = line.substr(i + 1, 3);
                            skip = 3;
                        }
                        break;
                    case 'f':
                        // reset fg
                        state.fg_color = state.page_fg;
                        break;
                    case 'B':
                        // `Brgb, or `BTrrggbb for 24-bit. Same as F above.
                        if (line.length >= i + 8 && line[i + 1] === 'T') {
                            state.bg_color = line.substr(i + 2, 6);
                            skip = 7;
                            flushPart(); // flush current part when background color changes
                        } else if (line.length >= i + 4) {
                            state.bg_color = line.substr(i + 1, 3);
                            skip = 3;
                            flushPart();
                        }
                        break;
                     case 'b':
                        // reset bg
                        state.bg_color = this.DEFAULT_BG;
                        flushPart(); // flush to allow for ` tags on same line
                        break;
                    case '`':
                        state.formatting.bold = false;
                        state.formatting.underline = false;
                        state.formatting.italic = false;
                        state.fg_color = state.page_fg;
                        state.bg_color = this.DEFAULT_BG;
                        state.align = state.default_align;
                        mode = "text";
                        break;
                    case 'c':
                        state.align = 'center';
                        break;
                    case 'l':
                        state.align = 'left';
                        break;
                    case 'r':
                        state.align = 'right';
                        break;
                    case 'a':
                        state.align = state.default_align;
                        break;

                    case ':': {
                        // Anchor declaration: `:name - a zero width marker a
                        // link can jump to. Consume the name so it does not
                        // end up printed as page text.
                        let nameEnd = i + 1;
                        while (nameEnd < line.length && /[A-Za-z0-9_-]/.test(line[nameEnd])) {
                            nameEnd++;
                        }
                        const anchorName = line.slice(i + 1, nameEnd);
                        if (anchorName) {
                            flushPart();
                            const anchor = document.createElement("span");
                            anchor.id = "micron-anchor-" + anchorName;
                            anchor.className = "micron-anchor";
                            output.push({type: "element", element: anchor});
                        }
                        skip = Math.max(0, (nameEnd - i) - 1);
                        break;
                    }

                    case '<':
                        // if there's already text, flush it
                        flushPart();
                        let fieldData = this.parseField(line, i, state);
                        if (fieldData) {
                            output.push(fieldData.obj);
                            i += fieldData.skip;
                            // do not i++ here or we'll skip an extra char
                            continue;
                        }
                        break;

                    case '[':
                        // flush current text first
                        flushPart();
                        let linkData = this.parseLink(line, i, state);
                        if (linkData) {
                            output.push(linkData.obj);
                            i += linkData.skip;
                            continue;
                        }
                        break;

                    default:
                        // unknown formatting char, ignore
                        break;
                }
                mode = "text";
                i++;
                continue;

            } else {
                // mode === "text"
                if (escape) {
                    part += c;
                    escape = false;
                } else if (c === '\\') {
                    escape = true;
                } else if (c === '`') {
                    if (i + 1 < line.length && line[i + 1] === '`') {
                        flushPart();
                        state.formatting.bold = false;
                        state.formatting.underline = false;
                        state.formatting.italic = false;
                        state.fg_color = state.page_fg;
                        state.bg_color = this.DEFAULT_BG;
                        state.align = state.default_align;
                        i += 2;
                        continue;
                    } else {
                        flushPart();
                        mode = "formatting";
                        i++;
                        continue;
                    }
                } else if (c === '[') {
                    // A link is `[label`url] - with the backtick. NomadNet
                    // treats a bare '[' as plain text, always. This parser
                    // used to take any bare [...] as a link, which had two
                    // effects: "[1]" or "[note]" in running text became links
                    // to nomadnetwork://1, and pages that forgot the backtick
                    // ("[BOARD`:/page/board.mu]") showed "BOARD]" - the
                    // closing bracket was never consumed, because this branch
                    // has no formatting-mode pass to swallow it.
                    //
                    // Now a bare [...] is a link only when it unmistakably is
                    // one: a label, a backtick, and a NomadNet target. It is
                    // shown with its brackets, "[BOARD]", as the author typed
                    // them. Anything else stays text, as in NomadNet.
                    let bare = this.parseBareLink(line, i, state);
                    if (bare) {
                        flushPart();
                        output.push(bare.obj);
                        i += bare.skip + 1;   // past the closing ']'
                        continue;
                    }
                    part += '[';
                } else {
                    // normal text char
                    part += c;
                }
                i++;
            }
        }
        // end of line
        if (part.length > 0) {
            if(this.enableForceMonospace) {
                output.push([this.stateToStyle(state), this.splitAtSpaces(part)]);
            } else {
                output.push([this.stateToStyle(state), part]);
            }
        }

        return output;
    }

    // ------------------------------------------------------------------ //
    // NomadNet 1.4.x constructs                                          //
    // ------------------------------------------------------------------ //

    /**
     * Tables. The buffered lines are Markdown table syntax: row 0 is the
     * header, row 1 the alignment separator (---, :--, --:, :-:), the rest
     * are data. NomadNet renders these as fixed-width ASCII because it draws
     * into a terminal; we have a real browser, so we emit a real <table> and
     * let the layout engine size the columns. The declared max width becomes
     * a CSS max-width rather than a character count.
     */
    renderTable(rows, state) {
        if (!rows || rows.length < 2) return null;

        const splitRow = (line) => {
            let s = line.trim();
            if (s.startsWith("|")) s = s.slice(1);
            if (s.endsWith("|")) s = s.slice(0, -1);
            const cells = [];
            let current = "";
            let escaped = false;
            for (const ch of s) {
                if (escaped) { current += ch; escaped = false; }
                else if (ch === "\\") { escaped = true; }
                else if (ch === "|") { cells.push(current.trim()); current = ""; }
                else { current += ch; }
            }
            cells.push(current.trim());
            return cells;
        };

        const header = splitRow(rows[0]);
        const alignCells = splitRow(rows[1]);
        const alignments = alignCells.map(c => {
            const t = c.trim();
            if (t.startsWith(":") && t.endsWith(":")) return "center";
            if (t.endsWith(":")) return "right";
            return "left";
        });
        while (alignments.length < header.length) alignments.push("left");

        const table = document.createElement("table");
        table.className = "micron-table";
        if (state.table_maxwidth) table.style.maxWidth = state.table_maxwidth + "ch";
        if (state.table_align === "c") table.style.margin = "0 auto";
        else if (state.table_align === "r") table.style.marginLeft = "auto";

        // Cells can carry inline micron markup, so each one goes back through
        // makeOutput instead of being dropped in as plain text.
        const renderCell = (text, tag, align) => {
            const cell = document.createElement(tag);
            cell.style.textAlign = align || "left";
            const sub = Object.assign({}, state, { table_mode: false, table_buffer: [] });
            const parts = this.makeOutput(sub, text);
            if (parts && parts.length) this.appendOutput(cell, parts, sub);
            else cell.textContent = text;
            return cell;
        };

        const thead = document.createElement("thead");
        const headRow = document.createElement("tr");
        header.forEach((text, i) => headRow.appendChild(renderCell(text, "th", alignments[i])));
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement("tbody");
        for (let r = 2; r < rows.length; r++) {
            const cells = splitRow(rows[r]);
            while (cells.length < header.length) cells.push("");
            const tr = document.createElement("tr");
            cells.slice(0, header.length).forEach(
                (text, i) => tr.appendChild(renderCell(text, "td", alignments[i])));
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);

        const wrapper = document.createElement("div");
        wrapper.className = "micron-table-wrap";
        wrapper.appendChild(table);
        this.applySectionIndent(wrapper, state);
        return [wrapper];
    }

    /**
     * Inline image: `(alt text`w=320`h=200`a=c`hash:/media/pic.webp)
     *
     * The parser does not know which node the page came from and has no
     * business making network requests, so it emits a placeholder carrying
     * the raw URL. The page hydrates it into a real <img> once it knows the
     * node hash - same division of labour as links.
     */
    parseImage(line, state) {
        const endpos = line.lastIndexOf(")");
        if (endpos <= 0) return null;

        const fields = line.slice(0, endpos).split("`");
        if (fields.length < 2) return null;

        const altText = fields[0].trim();
        const imageUrl = fields[fields.length - 1].trim();
        if (!imageUrl) return null;

        let width = null, height = null, align = null;
        for (const prop of fields.slice(1, -1)) {
            const eq = prop.indexOf("=");
            if (eq < 0) continue;
            const key = prop.slice(0, eq).trim();
            const value = prop.slice(eq + 1).trim();
            if (key === "w") width = value;
            else if (key === "h") height = value;
            else if (key === "a") align = value;
        }
        if (align === "c") align = "center";
        else if (align === "l") align = "left";
        else if (align === "r") align = "right";

        const holder = document.createElement("div");
        holder.className = "micron-image";
        holder.dataset.micronImage = "1";
        holder.dataset.imageUrl = imageUrl;
        holder.dataset.imageAlt = altText;
        if (width) holder.dataset.imageWidth = width;
        if (height) holder.dataset.imageHeight = height;
        if (align) holder.style.textAlign = align;

        const placeholder = document.createElement("span");
        placeholder.className = "micron-image-placeholder";
        placeholder.textContent = "🖼 " + (altText || imageUrl);
        holder.appendChild(placeholder);

        this.applySectionIndent(holder, state);
        return [holder];
    }

    /**
     * Page partial: `{url`refresh`fields}
     *
     * A region of the page that reloads on its own. Only the URL is required;
     * refresh is in seconds (values below 1 are ignored, as in NomadNet) and
     * fields are pipe separated, with pid=<name> naming the partial.
     */
    parsePartial(line, state) {
        const endpos = line.indexOf("}");
        if (endpos === -1) return null;

        const components = line.slice(0, endpos).split("`");
        let url = "", refresh = null, fieldsRaw = "";

        if (components.length === 1) {
            url = components[0];
        } else if (components.length === 2) {
            url = components[0];
            refresh = parseFloat(components[1]);
        } else if (components.length >= 3) {
            url = components[0];
            refresh = parseFloat(components[1]);
            fieldsRaw = components[2];
        }
        if (!url) return null;
        if (isNaN(refresh) || refresh === null || refresh < 1) refresh = null;

        const fields = fieldsRaw ? fieldsRaw.split("|").filter(f => f.length) : [];
        let partialId = null;
        for (const f of fields) {
            if (f.startsWith("pid=")) partialId = f.slice(4);
        }

        const holder = document.createElement("div");
        holder.className = "micron-partial";
        holder.dataset.micronPartial = "1";
        holder.dataset.partialUrl = url;
        if (refresh !== null) holder.dataset.partialRefresh = String(refresh);
        if (fields.length) holder.dataset.partialFields = fields.join("|");
        if (partialId) holder.dataset.partialId = partialId;

        const pending = document.createElement("span");
        pending.className = "micron-partial-pending";
        pending.textContent = "⧖";
        holder.appendChild(pending);

        this.applySectionIndent(holder, state);
        return [holder];
    }

    /**
     * Turn tagged headings into working collapsible sections.
     *
     * Has to run after the whole page exists, because a fold owns everything
     * between its heading and the next heading at the same or shallower
     * depth - which cannot be known while parsing line by line.
     */
    static applyFolds(container) {
        const headings = Array.from(container.querySelectorAll("[data-micron-fold]"));
        for (const heading of headings) {
            if (heading.dataset.foldApplied === "1") continue;
            heading.dataset.foldApplied = "1";

            const depth = parseInt(heading.dataset.foldDepth || "1", 10);
            const body = document.createElement("div");
            body.className = "micron-fold-body";

            let node = heading.nextSibling;
            while (node) {
                const next = node.nextSibling;
                if (node.nodeType === 1 && node.hasAttribute("data-micron-fold")) {
                    const otherDepth = parseInt(node.dataset.foldDepth || "1", 10);
                    if (otherDepth <= depth) break;
                }
                body.appendChild(node);
                node = next;
            }

            heading.parentNode.insertBefore(body, heading.nextSibling);

            const collapsed = heading.dataset.micronFold === "collapsed";
            body.style.display = collapsed ? "none" : "";

            heading.addEventListener("click", () => {
                const hidden = body.style.display === "none";
                body.style.display = hidden ? "" : "none";
                const marker = heading.querySelector(".micron-fold-marker");
                if (marker) {
                    const glyphs = (heading.dataset.foldGlyphs || "▼,▶").split(",");
                    marker.textContent = (hidden ? glyphs[0] : glyphs[1]) + " ";
                }
            });
        }
    }

    parseField(line, startIndex, state) {
        let field_start = startIndex + 1;
        let backtick_pos = line.indexOf('`', field_start);
        if (backtick_pos === -1) return null;

        let field_content = line.substring(field_start, backtick_pos);
        let field_masked = false;
        let field_width = 24;
        let field_rows = 1;
        let field_type = "field";
        let field_name = field_content;
        let field_value = "";
        let field_prechecked = false;

        if (field_content.includes('|')) {
            let f_components = field_content.split('|');
            let field_flags = f_components[0];
            field_name = f_components[1];

            if (field_flags.includes('^')) {
                field_type = "radio";
                field_flags = field_flags.replace('^', '');
            } else if (field_flags.includes('?')) {
                field_type = "checkbox";
                field_flags = field_flags.replace('?', '');
            } else if (field_flags.includes('!')) {
                field_masked = true;
                field_flags = field_flags.replace('!', '');
            }

            if (field_flags.length > 0) {
                // Width, optionally "WxR" for a multi-row field. parseInt on
                // its own reads "24x5" as 24 and throws the rows away, which
                // silently turned every textarea a node offered into a
                // one-line input.
                const xpos = field_flags.indexOf("x");
                const widthFlag = xpos >= 0 ? field_flags.slice(0, xpos) : field_flags;
                const rowsFlag = xpos >= 0 ? field_flags.slice(xpos + 1) : "";

                let w = parseInt(widthFlag, 10);
                if (!isNaN(w)) {
                    field_width = Math.min(w, 256);
                }
                if (rowsFlag) {
                    let r = parseInt(rowsFlag, 10);
                    if (!isNaN(r)) {
                        field_rows = Math.max(1, Math.min(r, 256));
                    }
                }
            }

            if (f_components.length > 2) {
                field_value = f_components[2];
            }

            if (f_components.length > 3) {
                if (f_components[3] === '*') {
                    field_prechecked = true;
                }
            }
        }

        let field_end = line.indexOf('>', backtick_pos);
        if (field_end === -1) return null;

        let field_data = line.substring(backtick_pos + 1, field_end);
        let style = this.stateToStyle(state);

        let obj = null;
        if (field_type === "checkbox" || field_type === "radio") {
            obj = {
                type: field_type,
                name: field_name,
                value: field_value || field_data,
                label: field_data,
                prechecked: field_prechecked,
                style: style
            };
        } else {
            obj = {
                type: "field",
                name: field_name,
                width: field_width,
                rows: field_rows,
                masked: field_masked,
                data: field_data,
                style: style
            };
        }

        let skip = (field_end - startIndex);
        return {obj: obj, skip: skip};
    }

    parseLink(line, startIndex, state) {
        let endpos = line.indexOf(']', startIndex);
        if (endpos === -1) return null;

        let link_data = line.substring(startIndex + 1, endpos);
        let link_components = link_data.split('`');
        let link_label = "";
        let link_url = "";
        let link_fields = "";

        if (link_components.length === 1) {
            link_label = "";
            link_url = link_data;
        } else if (link_components.length === 2) {
            link_label = link_components[0];
            link_url = link_components[1];
        } else if (link_components.length === 3) {
            link_label = link_components[0];
            link_url = link_components[1];
            link_fields = link_components[2];
        }

        if (link_url.length === 0) {
            return null;
        }

        if (link_label === "") {
            link_label = link_url;
        }

        // format the URL
        link_url = MicronParser.formatNomadnetworkUrl(link_url);

        // Apply forceMonospace
        if(this.enableForceMonospace) {
            link_label = this.splitAtSpaces(link_label);
        }

        let style = this.stateToStyle(state);
        let obj = {
            type: "link",
            url: link_url,
            label: link_label,
            fields: (link_fields ? link_fields.split("|") : []),
            style: style
        };

        let skip = (endpos - startIndex);
        return {obj: obj, skip: skip};
    }

    // A '[' without the backtick in front: see the text-mode branch. Returns
    // a link only for [label`target] where target is something a NomadNet
    // link can point at; null means "this is just a bracket".
    parseBareLink(line, startIndex, state) {
        let endpos = line.indexOf(']', startIndex);
        if (endpos === -1) return null;
        let components = line.substring(startIndex + 1, endpos).split('`');
        if (components.length < 2 || components.length > 3) return null;
        let label = components[0];
        let target = components[1];
        if (!label || !MicronParser.looksLikeNomadTarget(target)) return null;

        let result = this.parseLink(line, startIndex, state);
        if (!result) return null;
        let shown = '[' + label + ']';
        result.obj.label = this.enableForceMonospace ? this.splitAtSpaces(shown) : shown;
        return result;
    }

    // ":/page/x.mu", "/page/x.mu", "<32 hex>", "<32 hex>:/page/x.mu",
    // "lxmf@<32 hex>", or a full nomadnetwork:// URL.
    static looksLikeNomadTarget(target) {
        return /^(:?\/[^\s]*|[0-9a-f]{32}(:\/[^\s]*)?|lxmf@[0-9a-f]{32}|nomadnetwork:\/\/\S+)$/i.test(target);
    }

    splitAtSpaces(line) {
        // The separator space used to be emitted OUTSIDE the word spans:
        //
        //     <span>word</span> <span>word</span>
        //                      ^ bare text node
        //
        // Micron artwork is drawn with background-coloured SPACES, and a
        // space sitting outside the styled span loses its colour. Every run
        // of art therefore came out as coloured dashes separated by unpainted
        // gaps, instead of the solid blocks NomadNet draws. Keeping the space
        // inside a span of its own preserves both the colour and the cell.
        let out = "";
        let wordArr = line.split(" ");
        for (let i = 0; i < wordArr.length; i++) {
            // Skip empty words. A run of n spaces splits into n+1 empty
            // strings, and emitting a span for each produced a pile of
            // zero-width elements - on a page of artwork, thousands of DOM
            // nodes that paint nothing.
            if (wordArr[i].length > 0) {
                out += "<span class='Mu-mws'>" + this.forceMonospace(wordArr[i]) + "</span>";
            }
            if (i < wordArr.length - 1) {
                out += "<span class='Mu-mws'>" + this.forceMonospace(" ") + "</span>";
            }
        }
        return out;
    }

    forceMonospace(line) {
        let out = "";
        // Properly split compount emoji, source: https://stackoverflow.com/a/71619350
        let charArr = [...new Intl.Segmenter().segment(line)].map(x => x.segment);
        for (let char of charArr) {
            out += "<span class='Mu-mnt'>" + char + "</span>";
        }
        return out;
    }
}

window.MicronParser = MicronParser;