#!/usr/bin/env node

// usage:
// ./dumpASN1.js [options] filename
// ./dumpASN1.js data:base64,MDMCAQFjLgQACgEACgEAAgEAAgEAAQEAoA+jDQQFTnRWZXIEBAEAAAAwCgQITmV0bG9nb24===
// cat file.der | ./dumpASN1.js -
// options:
//   --schema file.asn   parse and validate a user ASN.1 schema and match with it
//   --type TypeName     root type to match (default: best-scoring type)
//   --json              print every record as one JSON array on stdout
// legacy positional form: ./dumpASN1.js filename <moduleOid> <TypeName>

import * as fs from 'node:fs';
import { text as streamAsString } from 'node:stream/consumers';
import { Base64 } from './base64.js';
import { ASN1 } from './asn1.js';
import { Defs } from './defs.js';
import { parseSchema, checkReferences } from './asn1schema.js';
import { formats3gpp } from './formats3gpp.js';

ASN1.typeFormatters = formats3gpp; // only fires on schema-matched fields

const
    colYellow = '\x1b[33m',
    colBlue = '\x1b[34m',
    colReset = '\x1b[0m',
    reDataURI = /^data:(?:[a-z-]+[/][a-z.+-]+;)?base64,([A-Za-z0-9+/=\s]+)$/;

function usage() {
    console.error('usage: dumpASN1 [--schema file.asn] [--type TypeName] [--json] <filename|data:base64,…|->');
}

function print(value, indent) {
    if (indent === undefined) indent = '';
    const def = value.def;
    let name = '';
    if (def?.type) {
        if (def.id) name += colBlue + def.id + colReset;
        if (typeof def.type == 'object' && def.name) name = (name ? name + ' ' : '') + def.name;
        if (def.mismatch) name = (name ? name + ' ' : '') + '[?]';
        if (name) name += ' ';
    }
    let s = indent + name + colYellow + value.typeName() + colReset + ' @' + value.stream.pos;
    if (value.length >= 0)
        s += '+';
    s += value.length;
    if (value.tag.tagConstructed)
        s += ' (constructed)';
    else if ((value.tag.isUniversal() && ((value.tag.tagNumber == 0x03) || (value.tag.tagNumber == 0x04))) && (value.sub !== null))
        s += ' (encapsulates)';
    let content = value.content();
    if (content)
        s += ': ' + content.replace(/\n/g, '|');
    s += '\n';
    if (value.sub !== null) {
        indent += '  ';
        for (const subval of value.sub)
            s += print(subval, indent);
    }
    return s;
}

// --- arguments
const args = process.argv.slice(2);
let schemaFile = null,
    rootType = null,
    json = false;
const positional = [];
for (let i = 0; i < args.length; ++i) {
    const a = args[i];
    if (a == '--schema') schemaFile = args[++i];
    else if (a == '--type') rootType = args[++i];
    else if (a == '--json') json = true;
    else if (a == '--help' || a == '-h') {
        usage();
        process.exit(0);
    } else positional.push(a);
}
const filename = positional[0];
if (!filename) {
    usage();
    process.exit(1);
}
const info = json ? console.error : console.log; // keep stdout clean for JSON

// --- input
let content;
const match = reDataURI.exec(filename);
if (match)
    content = Buffer.from(match[1]);
else if (filename == '-') // stdin
    content = await streamAsString(process.stdin);
else
    content = fs.readFileSync(filename);
try { // try PEM first
    content = Base64.unarmor(content);
} catch (ignore) { // try DER/BER then
}

// --- user schema
let userMod = null;
if (schemaFile) {
    try {
        userMod = parseSchema(fs.readFileSync(schemaFile, 'utf8'), schemaFile);
    } catch (e) {
        console.error('Error: cannot parse schema: ' + (e.message || e));
        process.exit(1);
    }
    for (const w of userMod.warnings ?? [])
        console.error('Warning: ' + w.split('\n')[0]);
    const missing = checkReferences(userMod, name => {
        try {
            Defs.searchType(name);
            return true;
        } catch (ignore) {
            return false;
        }
    });
    if (missing.length)
        console.error('Warning: unresolved references: ' + missing.join(', '));
    Defs.RFC[userMod.oid || userMod.name] = userMod;
    info('Schema ' + userMod.name + ': ' + Object.keys(userMod.types).length + ' types');
}

// --- index all concatenated records
const scan = ASN1.scanRecords(content, 0, 10000000);
if (scan.offsets.length === 0) {
    console.error('Error: ' + (scan.error ? scan.error.message : 'no ASN.1 structure found'));
    process.exit(1);
}
if (scan.error)
    console.error('Warning: ' + scan.error.message + ' — dumping the ' + scan.offsets.length + ' record(s) before offset ' + scan.error.offset);

// --- choose the definition to match against
const first = ASN1.decode(content, scan.offsets[0]);
let def = null;
const t0 = performance.now();
if (positional.length == 3) { // legacy: filename <moduleOid> <TypeName>
    def = Defs.moduleAndType(Defs.RFC[positional[1]], positional[2]);
} else if (rootType && userMod) {
    if (!(rootType in userMod.types)) {
        console.error('Error: type ' + rootType + ' not found in ' + userMod.name);
        process.exit(1);
    }
    def = Defs.moduleAndType(userMod, rootType);
} else if (rootType) {
    def = Defs.searchType(rootType);
} else {
    const candidates = [];
    if (userMod)
        for (const name of Object.keys(userMod.types))
            candidates.push(Object.assign({ description: name + ' (' + userMod.name + ')' }, Defs.moduleAndType(userMod, name)));
    candidates.push(...Defs.commonTypes);
    const types = candidates
        .map(type => {
            const stats = Defs.match(first, type);
            return { type, match: stats.recognized / stats.total };
        })
        .sort((a, b) => b.match - a.match);
    const t1 = performance.now();
    info('Parsed in ' + (t1 - t0).toFixed(2) + ' ms; best types:');
    for (const t of types.slice(0, 5))
        info((t.match * 100).toFixed(2).padStart(6) + '% ' + t.type.description);
    def = types[0].type;
}

// --- output
if (json) {
    const out = [];
    for (let i = 0; i < scan.offsets.length; ++i)
        try {
            const rec = (i === 0) ? first : ASN1.decode(content, scan.offsets[i]);
            if (def)
                Defs.match(rec, def);
            out.push({ [rec.def?.id || rec.typeName()]: rec.toJSON() });
        } catch (e) {
            out.push({ error: 'record ' + (i + 1) + ' cannot be decoded: ' + (e.message || e) });
        }
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} else
    for (let i = 0; i < scan.offsets.length; ++i)
        try {
            const rec = (i === 0) ? first : ASN1.decode(content, scan.offsets[i]);
            if (def)
                Defs.match(rec, def);
            if (scan.offsets.length > 1)
                console.log('--- record ' + (i + 1) + ' of ' + scan.offsets.length + ' ---');
            console.log(print(rec));
        } catch (e) {
            console.log('--- record ' + (i + 1) + ' of ' + scan.offsets.length + ': cannot be decoded: ' + (e.message || e));
        }
