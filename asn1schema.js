// ASN.1 module (schema) parser, usable both in browser and NodeJS
// Extracted from parseRFC.js
// Copyright (c) 2021 Lapo Luchini <lapo@lapo.it>

// Permission to use, copy, modify, and/or distribute this software for any
// purpose with or without fee is hereby granted, provided that the above
// copyright notice and this permission notice appear in all copies.
//
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
// ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
// ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
// OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

const reWhitespace = /(?:\s|--(?:-?[^\n-])*(?:\n|--))*/my;
const reIdentifier = /[a-zA-Z](?:[-]?[a-zA-Z0-9])*/y;
const reNumber = /0|[1-9][0-9]*/y;
const reToken = /[(){},[\];]|::=|OPTIONAL|DEFAULT|NULL|TRUE|FALSE|\.\.|OF|SIZE|MIN|MAX|DEFINED BY|DEFINITIONS|TAGS|BEGIN|EXPORTS|IMPORTS|FROM|END/y;
const reType = /ANY|NULL|BOOLEAN|INTEGER|(?:BIT|OCTET)\s+STRING|OBJECT\s+IDENTIFIER|SEQUENCE|SET|CHOICE|ENUMERATED|(?:Generalized|UTC)Time|(?:BMP|General|Graphic|IA5|ISO64|Numeric|Printable|Teletex|T61|Universal|UTF8|Videotex|Visible)String/y;
const reTagClass = /UNIVERSAL|APPLICATION|PRIVATE|/y;
const reTagType = /IMPLICIT|EXPLICIT|/y;
const reTagDefault = /(AUTOMATIC|IMPLICIT|EXPLICIT) TAGS|/y;

export class SchemaParser {
    /**
     * Creates an ASN.1 module parser.
     * @param {string} enc - the text to parse
     * @param {number} pos - starting position
     * @param {Object} modules - registry of already-known modules (indexed by OID), used to resolve IMPORTS
     */
    constructor(enc, pos = 0, modules = {}) {
        this.enc = enc;
        this.pos = pos;
        this.start = pos;
        this.modules = modules;
        this.currentMod = null;
        this.warnings = [];
        this.depth = 0;
    }
    getChar(pos) {
        if (pos === undefined)
            pos = this.pos++;
        if (pos >= this.enc.length)
            throw 'Requesting byte offset ' + pos + ' on a stream of length ' + this.enc.length;
        return this.enc.charAt(pos);
    }
    exception(s) {
        const pos = this.pos;
        let from = Math.max(pos - 30, this.start);
        let to   = Math.min(pos + 30, this.enc.length);
        let ctx  = '';
        let arrow = '';
        let i = from;
        for (; i < pos; ++i) {
            ctx += this.getChar(i);
            arrow += ' ';
        }
        ctx += this.getChar(i++);
        arrow += '^';
        for (; i < to; ++i)
            ctx += this.getChar(i);
        // calculate line/column
        let line = 1;
        let lastLF = 0;
        for (let i = 0; i < pos; ++i)
            if (this.enc.charAt(i) == '\n') {
                ++line;
                lastLF = i;
            }
        let column = pos - lastLF;
        throw new Error('[position ' + pos + ', line ' + line + ':' + column + '] ' + s + '\n' + ctx.replace(/\s/g, ' ') + '\n' + arrow);
    }
    peek() {
        return this.enc.charCodeAt(this.pos);
    }
    peekChar() {
        return this.enc.charAt(this.pos);
    }
    isWhitespace() {
        let c = this.peekChar();
        return c == ' ' || c == '\n';
    }
    isDigit() {
        let c = this.peekChar();
        return c >= '0' && c <= '9';
    }
    skipWhitespace() {
        reWhitespace.lastIndex = this.pos;
        let s = reWhitespace.exec(this.enc);
        if (s)
            this.pos = reWhitespace.lastIndex;
    }
    getRegEx(type, re) {
        this.skipWhitespace();
        re.lastIndex = this.pos;
        let s = re.exec(this.enc); //TODO: does not work with typed arrays
        if (!s)
            this.exception("Found '" + this.peekChar() + "', was expecting a " + type);
        s = s[0];
        this.pos = re.lastIndex;
        this.skipWhitespace();
        return s;
    }
    parseIdentifier() {
        return this.getRegEx('identifier', reIdentifier);
    }
    parseNumber() {
        return this.getRegEx('number', reNumber);
    }
    parseToken() {
        return this.getRegEx('token', reToken);
    }
    tryToken(expect) {
        let p = this.pos;
        let t;
        try { t = this.parseToken(); } catch (ignore) { /*ignore*/ }
        if (t == expect)
            return true;
        else {
            this.pos = p;
            return false;
        }
    }
    expectToken(expect) {
        let p = this.pos;
        let t;
        try { t = this.parseToken(); }
        catch (ignore) { /*ignore*/ }
        if (t != expect) {
            this.pos = p;
            this.exception("Found '" + t + "', was expecting '" + expect + "'");
        }
    }
    parseNumberOrValue() {
        this.skipWhitespace();
        if (this.peekChar() == '-') { // negative bound, e.g. INTEGER (-2147483648..2147483647)
            this.getChar();
            return -this.parseNumber();
        }
        if (this.isDigit())
            return +this.parseNumber();
        return this.parseIdentifier();
    }
    parseRange() {
        let min = this.tryToken('MIN') ? 'MIN' : this.parseNumberOrValue();
        if (this.tryToken('..')) {
            let max = this.tryToken('MAX') ? 'MAX' : this.parseNumberOrValue();
            return [min, max];
        }
        return min;
    }
    /**
     * Skips a parenthesized constraint (SIZE, value range, etc.) if present.
     * Constraints are not needed to decode/map values, so they are consumed
     * without being interpreted (subtypes like `X ::= Y (SIZE (1..n))`).
     */
    skipConstraint() {
        this.skipWhitespace();
        while (this.peekChar() == '(') {
            let depth = 0;
            do {
                const c = this.getChar();
                if (c == '(') ++depth;
                else if (c == ')') --depth;
            } while (depth > 0);
            this.skipWhitespace();
        }
    }
    parseBuiltinType() {
        let x = {
            name: this.getRegEx('type', reType),
            type: 'builtin',
        };
        try {
            switch (x.name) {
            case 'ANY':
                if (this.tryToken('DEFINED BY'))
                    x.definedBy = this.parseIdentifier();
                break;
            case 'NULL':
            case 'BOOLEAN':
            case 'OCTET STRING':
            case 'OBJECT IDENTIFIER':
                break;
            case 'CHOICE':
                x.content = this.parseElementTypeList();
                break;
            case 'SEQUENCE':
            case 'SET':
                if (this.peekChar() == '{') {
                    x.content = this.parseElementTypeList();
                } else {
                    x.typeOf = 1;
                    if (this.tryToken('SIZE')) {
                        this.expectToken('(');
                        x.size = this.parseRange();
                        this.expectToken(')');
                    }
                    this.expectToken('OF');
                    x.content = [this.parseType()];
                }
                break;
            case 'INTEGER': {
                const pInt = this.pos;
                if (this.tryToken('('))
                    try {
                        x.range = this.parseRange();
                        this.expectToken(')');
                    } catch (ignoreRange) {
                        // complex constraint (unions, etc.): skipConstraint eats it
                        delete x.range;
                        this.pos = pInt;
                    }
            }
            // falls through
            case 'ENUMERATED':
            case 'BIT STRING':
                if (this.tryToken('{')) {
                    x.content = {};
                    do {
                        let id = this.parseIdentifier();
                        this.expectToken('(');
                        let val = this.parseNumber(); //TODO: signed
                        this.expectToken(')');
                        x.content[id] = +val;
                    } while (this.tryToken(','));
                    this.expectToken('}');
                }
                break;
            case 'BMPString':
            case 'GeneralString':
            case 'GraphicString':
            case 'IA5String':
            case 'ISO646String':
            case 'NumericString':
            case 'PrintableString':
            case 'TeletexString':
            case 'T61String':
            case 'UniversalString':
            case 'UTF8String':
            case 'VideotexString':
            case 'VisibleString': {
                const p = this.pos;
                if (this.tryToken('(')) {
                    if (this.tryToken('SIZE')) {
                        this.expectToken('(');
                        x.size = this.parseRange();
                        this.expectToken(')');
                        this.expectToken(')');
                    } else // other constraints (e.g. contained subtype): skipConstraint eats them
                        this.pos = p;
                }
                break;
            }
            case 'UTCTime':
            case 'GeneralizedTime':
                break;
            default:
                x.warning = 'type unknown';
            }
        } catch (e) {
            this.warnings.push(e.message || String(e));
            x.warning = 'type exception';
        }
        return x;
    }
    parseTaggedType() {
        this.expectToken('[');
        let tagClass = this.getRegEx('class', reTagClass) || 'CONTEXT'; //TODO: use module defaults
        let t = this.parseNumber();
        this.expectToken(']');
        let plicit = this.getRegEx('explicit/implicit', reTagType);
        if (plicit == '') plicit = this.currentMod.tagDefault;
        let x = this.parseType();
        let name;
        switch (tagClass) { // keep in sync with ASN1.typeName
        case 'APPLICATION':
            name = 'Application ' + t;
            break;
        case 'PRIVATE':
            name = 'Private ' + t;
            break;
        case 'CONTEXT':
            // fall through
        default:
            name = '[' + t + ']';
            break;
        }
        return {
            name,
            type: 'tag',
            'class': tagClass,
            explicit: (plicit == 'EXPLICIT'),
            content: [{ name: '', type: x }],
        };
    }
    parseType() {
        if (++this.depth > 100) // untrusted schemas must not blow the stack
            this.exception('Type nesting exceeds maximum depth of 100');
        try {
            if (this.peekChar() == '[')
                return this.parseTaggedType();
            let p = this.pos;
            let x;
            try {
                x = this.parseBuiltinType();
            } catch (ignore) {
                this.pos = p;
                x = {
                    name: this.parseIdentifier(),
                    type: 'defined',
                };
                //TODO "restricted string type"
            }
            this.skipConstraint();
            return x;
        } finally {
            --this.depth;
        }
    }
    parseValueOID() {
        this.expectToken('{');
        let v = '';
        while (!this.tryToken('}')) {
            let p = this.pos;
            let val;
            if (this.isDigit())
                val = this.parseNumber();
            else {
                this.pos = p;
                let id = this.parseIdentifier();
                if (this.tryToken('(')) {
                    val = this.parseNumber();
                    this.expectToken(')');
                } else {
                    if (id in this.currentMod.values) // defined in local module
                        val = this.currentMod.values[id].value;
                    else try {
                        val = this.searchImportedValue(id);
                    } catch (e) {
                        this.exception(e.message);
                    }
                }
            }
            if (v.length) v += '.';
            v += val;
        }
        return v;
    }
    searchImportedValue(id) {
        for (let imp of Object.values(this.currentMod.imports ?? {}))
            for (let name of imp.types)
                if (name == id) {
                    if (!(imp.oid in this.modules))
                        throw new Error('Cannot find module: ' + imp.oid + ' ' + id);
                    if (id in this.modules[imp.oid].values)
                        return this.modules[imp.oid].values[id];
                    throw new Error('Cannot find imported value: ' + imp.oid + ' ' + id);
                }
        throw new Error('Cannot find imported value in any module: ' + id);
    }
    parseValue() {
        let c = this.peekChar();
        if (c == '{')
            return this.parseValueOID();
        if (c >= '0' && c <= '9')
            return +this.parseNumber();
        if (c == '-')
            return -this.parseNumber();
        let p = this.pos;
        try {
            switch (this.parseToken()) {
            case 'TRUE':
                return true;
            case 'FALSE':
                return false;
            case 'NULL':
                return null;
            }
        } catch (ignore) {
            this.pos = p;
        }
        p = this.pos;
        try {
            return this.parseIdentifier();
        } catch (ignore) {
            this.pos = p;
        }
        this.exception('Unknown value type.');
    }
    parseElementType() {
        let x = Object.assign({ id: this.parseIdentifier() }, this.parseType());
        if (this.tryToken('OPTIONAL'))
            x.optional = true;
        if (this.tryToken('DEFAULT'))
            x.default = this.parseValue(x.type);
        return x;
    }
    parseElementTypeList() {
        let v = [];
        this.expectToken('{');
        do {
            v.push(this.parseElementType());
        } while (this.tryToken(','));
        this.expectToken('}');
        return v;
    }
    parseAssignment() {
        let name = this.parseIdentifier();
        if (this.tryToken('::=')) { // type assignment
            let type = this.parseType();
            this.currentMod.types[name] = { name, type };
            return this.currentMod.types[name];
        } else { // value assignment
            let type = this.parseType();
            this.expectToken('::=');
            let value = this.parseValue(type);
            this.currentMod.values[name] = { name, type, value };
            return this.currentMod.values[name];
        }
    }
    parseModuleIdentifier() {
        const mod = { name: this.parseIdentifier() };
        this.skipWhitespace();
        if (this.peekChar() == '{') // module OID is optional (user schemas often omit it)
            mod.oid = this.parseValueOID();
        return mod;
    }
    parseSymbolsImported() {
        let imports = {};
        do {
            let l = [];
            do {
                l.push(this.parseIdentifier());
            } while (this.tryToken(','));
            this.expectToken('FROM');
            let mod = this.parseModuleIdentifier();
            mod.types = l;
            imports[mod.oid] = mod;
        } while (this.peekChar() != ';');
        return imports;
    }
    parseModuleDefinition(file) {
        let mod = this.parseModuleIdentifier();
        this.currentMod = mod; // for deeply nested parsers
        mod.source = file;
        this.expectToken('DEFINITIONS');
        mod.tagDefault = this.getRegEx('tag default', reTagDefault).split(' ')[0];
        this.expectToken('::=');
        this.expectToken('BEGIN');
        //TODO this.tryToken('EXPORTS')
        if (this.tryToken('IMPORTS')) {
            mod.imports = this.parseSymbolsImported();
            this.expectToken(';');
        }
        mod.values = {};
        mod.types = {};
        while (!this.tryToken('END'))
            this.parseAssignment();
        if (this.warnings.length)
            mod.warnings = this.warnings;
        return mod;
    }
}

/**
 * Parses the first ASN.1 module found in a schema text.
 * @param {string} text - full text of the schema (module definition)
 * @param {string} source - name to record as source of the module (e.g. file name)
 * @param {Object} modules - registry of known modules, used to resolve IMPORTS
 * @returns {Object} the parsed module {name, oid?, tagDefault, types, values, imports?}
 */
export function parseSchema(text, source = 'schema', modules = {}) {
    const parser = new SchemaParser(text.replace(/^\uFEFF/, ''), 0, modules);
    parser.skipWhitespace();
    return parser.parseModuleDefinition(source);
}

/**
 * Checks that every referenced type is defined in the module, its imports,
 * or resolvable externally.
 * @param {Object} mod - a module returned by parseSchema
 * @param {?Function} external - optional callback (name) => boolean for types known elsewhere
 * @returns {Array<string>} names of referenced types that could not be resolved
 */
export function checkReferences(mod, external) {
    const known = new Set(Object.keys(mod.types));
    for (const imp of Object.values(mod.imports ?? {}))
        for (const t of imp.types)
            known.add(t);
    const missing = new Set();
    const seen = new Set();
    function walk(t) {
        if (!t || typeof t != 'object' || seen.has(t))
            return;
        seen.add(t);
        if (t.type == 'defined' && !known.has(t.name) && !(external && external(t.name)))
            missing.add(t.name);
        if (typeof t.type == 'object')
            walk(t.type);
        if (Array.isArray(t.content))
            t.content.forEach(walk);
    }
    Object.values(mod.types).forEach(walk);
    return [...missing];
}
