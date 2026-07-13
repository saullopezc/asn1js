// ASN.1 DER encoder (minimal): re-encodes decoded nodes, applying edits
// Copyright (c) 2026 Saul Lopez

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

/**
 * Copies a byte range of a Stream into a new Uint8Array.
 */
function streamBytes(stream, start, end) {
    const b = new Uint8Array(end - start);
    for (let i = start; i < end; ++i)
        b[i - start] = stream.get(i);
    return b;
}

/**
 * Encodes a length in DER definite form (minimal octets).
 * @param {number} len - content length in bytes
 * @returns {Array<number>} the length octets
 */
function encodeLength(len) {
    if (len < 0x80)
        return [len];
    const bytes = [];
    let n = len;
    while (n > 0) {
        bytes.unshift(n & 0xFF);
        n = Math.floor(n / 256);
    }
    bytes.unshift(0x80 | bytes.length);
    return bytes;
}

/**
 * Re-encodes an ASN1 node to DER bytes.
 * Unmodified primitive content is copied verbatim from the original stream;
 * constructed nodes are rebuilt from their children, so edits deep in the
 * tree propagate lengths upwards. BER indefinite lengths and non-minimal
 * length octets are normalized to DER definite form.
 * @param {ASN1} node - the decoded node (from ASN1.decode)
 * @param {?Map} edits - optional map: ASN1 node -> Uint8Array of new content bytes
 * @returns {Uint8Array} the encoded bytes
 */
export function encodeNode(node, edits) {
    if (node.rawBytes) // synthetic node inserted by structural edits (add/duplicate)
        return node.rawBytes;
    let content;
    if (edits && edits.has(node))
        content = edits.get(node);
    else if (node.tag.tagConstructed && node.sub !== null) {
        const parts = node.sub.map(s => encodeNode(s, edits));
        content = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
        let at = 0;
        for (const p of parts) {
            content.set(p, at);
            at += p.length;
        }
    } else // primitive (encapsulating BIT/OCTET STRING content is copied verbatim)
        content = streamBytes(node.stream, node.posContent(), node.posEnd());
    const tag = streamBytes(node.stream, node.posStart(), node.posLen());
    const lenBytes = encodeLength(content.length);
    const out = new Uint8Array(tag.length + lenBytes.length + content.length);
    out.set(tag, 0);
    out.set(lenBytes, tag.length);
    out.set(content, tag.length + lenBytes.length);
    return out;
}

/**
 * Encodes an ASN.1 tag (identifier octets), using long form when needed.
 * @param {number} cls - class bits: 0x00 universal, 0x40 application, 0x80 context, 0xC0 private
 * @param {boolean} constructed - whether the constructed bit is set
 * @param {number} number - the tag number
 * @returns {Array<number>} the identifier octets
 */
export function encodeTag(cls, constructed, number) {
    const b0 = cls | (constructed ? 0x20 : 0);
    if (number < 31)
        return [b0 | number];
    const groups = [];
    let n = number;
    do {
        groups.unshift(n & 0x7F);
        n = Math.floor(n / 128);
    } while (n > 0);
    for (let i = 0; i < groups.length - 1; ++i)
        groups[i] |= 0x80;
    return [b0 | 0x1F, ...groups];
}

/**
 * Assembles a full TLV from identifier octets and content.
 * @param {Array<number>} tagBytes - identifier octets (e.g. from encodeTag)
 * @param {Uint8Array|Array<number>} content - content octets
 * @returns {Uint8Array} tag + DER length + content
 */
export function encodeTLV(tagBytes, content) {
    const lenBytes = encodeLength(content.length);
    const out = new Uint8Array(tagBytes.length + lenBytes.length + content.length);
    out.set(tagBytes, 0);
    out.set(lenBytes, tagBytes.length);
    out.set(content, tagBytes.length + lenBytes.length);
    return out;
}

const universalTags = { // keep in sync with ASN1.typeName
    'BOOLEAN': 0x01, 'INTEGER': 0x02, 'BIT STRING': 0x03, 'OCTET STRING': 0x04,
    'NULL': 0x05, 'OBJECT IDENTIFIER': 0x06, 'ENUMERATED': 0x0A, 'UTF8String': 0x0C,
    'SEQUENCE': 0x10, 'SET': 0x11, 'NumericString': 0x12, 'PrintableString': 0x13,
    'TeletexString': 0x14, 'T61String': 0x14, 'VideotexString': 0x15, 'IA5String': 0x16,
    'UTCTime': 0x17, 'GeneralizedTime': 0x18, 'GraphicString': 0x19, 'VisibleString': 0x1A,
    'ISO646String': 0x1A, 'GeneralString': 0x1B, 'UniversalString': 0x1C, 'BMPString': 0x1E,
};

function isConstructedType(name) {
    return name == 'SEQUENCE' || name == 'SET';
}

/**
 * Minimal VALID default content for a builtin type: INTEGER/ENUMERATED/BOOLEAN
 * need one octet, BIT STRING needs the unused-bits octet; the rest can be empty.
 * @param {?string} typeName - builtin type name (e.g. 'INTEGER')
 * @returns {Uint8Array} the default content octets
 */
export function defaultContent(typeName) {
    if (typeName == 'INTEGER' || typeName == 'ENUMERATED' || typeName == 'BOOLEAN' || typeName == 'BIT STRING')
        return Uint8Array.of(0);
    return new Uint8Array(0);
}

function resolveBuiltin(type, resolveType) {
    // follows `defined` references until a builtin type (or null)
    let t = type;
    for (let guard = 0; t && guard < 20; ++guard) {
        if (t.type == 'defined') {
            try {
                t = resolveType(t.name);
            } catch (ignore) {
                return null;
            }
        } else if (t.type == 'builtin')
            return t;
        else if (typeof t.type == 'object')
            t = t.type;
        else
            return null;
    }
    return null;
}

/**
 * Builds an empty TLV (default content) for a schema element definition,
 * e.g. to add a missing field of a SET/SEQUENCE.
 * @param {Object} el - schema element ({id, name, type, class?, explicit?, content?})
 * @param {Function} resolveType - (name) => type object, e.g. name => Defs.searchType(name).type
 * @returns {Uint8Array} the encoded TLV
 * @throws {Error} when the element type cannot be resolved or built (e.g. CHOICE)
 */
export function buildElementTLV(el, resolveType) {
    if (el.type == 'tag') {
        const number = +(/\d+/.exec(el.name)[0]);
        const cls = { 'UNIVERSAL': 0x00, 'APPLICATION': 0x40, 'PRIVATE': 0xC0 }[el['class']] ?? 0x80;
        const inner = resolveBuiltin(el.content[0].type, resolveType);
        if (!inner || !(inner.name in universalTags))
            throw new Error('cannot build a value of type ' + (inner ? inner.name : '(unresolved)'));
        if (el.explicit)
            return encodeTLV(encodeTag(cls, true, number),
                encodeTLV(encodeTag(0, isConstructedType(inner.name), universalTags[inner.name]), defaultContent(inner.name)));
        return encodeTLV(encodeTag(cls, isConstructedType(inner.name), number), defaultContent(inner.name));
    }
    const inner = resolveBuiltin(el, resolveType);
    if (!inner || !(inner.name in universalTags))
        throw new Error('cannot build a value of type ' + (inner ? inner.name : '(unresolved)'));
    return encodeTLV(encodeTag(0, isConstructedType(inner.name), universalTags[inner.name]), defaultContent(inner.name));
}

/**
 * Encodes a decimal integer string as ASN.1 INTEGER content bytes
 * (two's complement, minimal length).
 * @param {string} s - decimal value, may be negative and arbitrarily big
 * @returns {Uint8Array} the content octets
 */
export function encodeInteger(s) {
    let n = BigInt(String(s).trim());
    const out = [];
    for (;;) {
        out.unshift(Number(n & 0xFFn));
        n >>= 8n; // arithmetic shift: negatives converge to -1n
        if ((n == 0n && (out[0] & 0x80) == 0) || (n == -1n && (out[0] & 0x80) != 0))
            break;
    }
    return Uint8Array.from(out);
}
