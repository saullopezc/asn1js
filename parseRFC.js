#! /usr/bin/env node

// RFC ASN.1 definition parser
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

import * as fs from 'node:fs';
import { SchemaParser } from './asn1schema.js';

const
    patches = { // to fix some known RFCs' ASN.1 syntax errors
        0: [
            [ /\n\n[A-Z].*\n\f\n[A-Z].*\n\n/g, '' ], // page change
        ],
        2459: [ // currently unsupported
            [ 'videotex (8) } (0..ub-integer-options)', 'videotex (8) }' ],
            [ /OBJECT IDENTIFIER \( id-qt-cps \| id-qt-unotice \)/g, 'OBJECT IDENTIFIER' ],
            [ /SIGNED \{ (SEQUENCE \{[^}]+\})\s*\}/g, 'SEQUENCE { toBeSigned $1, algorithm AlgorithmIdentifier, signature BIT STRING }' ],
            [ /EXTENSION\.&[^,]+/g, 'OBJECT IDENTIFIER'],
        ],
        2986: [ // currently unsupported
            [ /FROM (InformationFramework|AuthenticationFramework) [a-zA-Z]+/g, 'FROM $1 {joint-iso-itu-t(2) ds(5) module(1) usefulDefinitions(0) 3}' ],
            [ /[(]v1,[^)]+[)]/g, '' ],
            [ /[{][{][^}]+[}][}]/g, '' ],
            [ 'SubjectPublicKeyInfo {ALGORITHM: IOSet}', 'SubjectPublicKeyInfo' ],
            [ /PKInfoAlgorithms ALGORITHM ::=[^}]+[}]/g, '' ],
            [ /(Attributes?) [{] ATTRIBUTE:IOSet [}]/g, '$1' ],
            [ /CRIAttributes +ATTRIBUTE +::=[^}]+[}]/g, '' ],
            [ /[A-Z]+[.]&id[(][{]IOSet[}][)]/g, 'OBJECT IDENTIFIER' ],
            [ /[A-Z]+[.]&Type[(][{]IOSet[}][{]@[a-z]+[}][)]/g, 'ANY' ],
            [ /(AlgorithmIdentifier) [{]ALGORITHM:IOSet [}]/g, '$1' ],
            [ /SignatureAlgorithms ALGORITHM ::=[^}]+[}]/g, '' ],
        ],
        3161: [ // actual syntax errors
            [ /--.*}/g, '}' ],
            [ /^( +)--.*\n(?:\1 .*\n)+/mg, '' ],
            [ /addInfoNotAvailable \(17\)/g, '$&,' ],
        ],
        5208: [ // currently unsupported
            [ 'FROM InformationFramework informationFramework', 'FROM InformationFramework {joint-iso-itu-t(2) ds(5) module(1) usefulDefinitions(0) 3}' ],
            [ ' {{PrivateKeyAlgorithms}}', '' ],
            [ 'Version ::= INTEGER {v1(0)} (v1,...)', 'Version ::= INTEGER {v1(0)}' ],
            [ ' {{KeyEncryptionAlgorithms}}', '' ],
            [ /\.\.\. -- For local profiles/g, '' ],
        ],
        5280: [ // currently unsupported
            [ 'videotex     (8) } (0..ub-integer-options)', 'videotex     (8) }' ],
            [ /OBJECT IDENTIFIER \( id-qt-cps \| id-qt-unotice \)/g, 'OBJECT IDENTIFIER' ],
        ],
        4210: [
            [ /^\s+-- .*\r?\n/mg, '' ], // comments
        ],
        8017: [ // this RFC uses a lot of currently unsupported syntax
            [ /ALGORITHM-IDENTIFIER ::= CLASS[^-]+--/, '--' ],
            [ /\n +\S+ +ALGORITHM-IDENTIFIER[^\n]+(\n {6}[^\n]+)+\n {3}[}]/g, '' ],
            [ /AlgorithmIdentifier [{] ALGORITHM-IDENTIFIER:InfoObjectSet [}] ::=(\n {6}[^\n]+)+\n {3}[}]/, 'AlgorithmIdentifier ::= ANY'],
            [ /algorithm +id-[^,\n]+,/g, 'algorithm ANY,' ],
            [ / (sha1 {4}HashAlgorithm|mgf1SHA1 {4}MaskGenAlgorithm|pSpecifiedEmpty {4}PSourceAlgorithm|rSAES-OAEP-Default-Identifier {4}RSAES-AlgorithmIdentifier|rSASSA-PSS-Default-Identifier {4}RSASSA-AlgorithmIdentifier) ::= [{](\n( {6}[^\n]+)?)+\n {3}[}]/g, '' ],
            [ / ::= AlgorithmIdentifier [{]\s+[{][^}]+[}]\s+[}]/g, ' ::= AlgorithmIdentifier' ],
            [ /OCTET STRING[(]SIZE[(]0..MAX[)][)]/g, 'OCTET STRING' ],
            [ /emptyString {4}EncodingParameters ::= ''H/g, '' ],
            [ /[(]CONSTRAINED BY[^)]+[)]/g, '' ],
        ],
        4511: [
            [ /^\s+-- .*\r?\n/mg, '' ], // comments
            [ 'EXTENSIBILITY IMPLIED', '' ],
            [ /\.\.\.(,| {2})/g, '' ],
            [ /value AttributeValue/g, 'AttributeValue' ],
            [ /control Control/g, 'Control' ],
            [ /Attribute ::= PartialAttribute\(WITH COMPONENTS \{[^}]+\}\)/g, 'PartialAttribute ::= SEQUENCE { type AttributeDescription, vals SET SIZE (1..MAX) OF AttributeValue }' ],
            [ /,\s+\}/g, '}' ],
            [ /SaslCredentials,/g, 'SaslCredentials' ],
            [ /(BindResponse|ExtendedResponse) ::= \[APPLICATION [0-9]+\] SEQUENCE \{[^}]+\}/g, '$1 ::= ANY' ],
            [ /selector LDAPString/g, 'LDAPString' ],
            [ /filter Filter/g, 'Filter' ],
            [ /MatchingRuleAssertion,/g, 'MatchingRuleAssertion' ],
            [ /OF substring CHOICE/g, 'OF CHOICE' ],
            [ /partialAttribute PartialAttribute/g, 'PartialAttribute' ],
            [ /uri URI/g, 'URI' ],
            [ /OF change SEQUENCE/g, 'OF SEQUENCE' ],
            [ /attribute Attribute/g, 'Attribute' ],
        ],
    };

let s = fs.readFileSync(process.argv[2], 'utf8');
let num = /^Request for Comments: ([0-9]+)/m.exec(s)[1];
console.log('RFC:', num);
for (let p of patches[0])
    s = s.replace(p[0], p[1]);
if (num in patches)
    for (let p of patches[num])
        s = s.replace(p[0], p[1]);
fs.writeFileSync(process.argv[2].replace(/[.]txt$/, '_patched.txt'), s, 'utf8');
// console.log(s);
const asn1 = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const reModuleDefinition = /\s[A-Z](?:[-]?[a-zA-Z0-9])*\s*\{[^}]+\}\s*(^--.*|\n)*DEFINITIONS/gm;
let m;
while ((m = reModuleDefinition.exec(s))) {
    const mod = new SchemaParser(s, m.index, asn1).parseModuleDefinition(process.argv[2]);
    console.log('Module:', mod.name);
    // fs.writeFileSync('rfc' + num + '.json', JSON.stringify(mod, null, 2) + '\n', 'utf8');
    asn1[mod.oid] = mod;
}
/*asn1 = Object.keys(asn1).sort().reduce(
    (obj, key) => {
        obj[key] = asn1[key];
        return obj;
    },
    {}
);*/
fs.writeFileSync(process.argv[3], JSON.stringify(asn1, null, 2) + '\n', 'utf8');
// console.log('Module:', mod);
/*while ((idx = s.indexOf('::=', idx + 1)) >= 0) {
    let line = s.lastIndexOf('\n', idx) + 1;
    // console.log('[line] ' + s.slice(line, line+30));
    try {
        let a = new DefStream(s, line).parseAssignment();
        // console.log('[assignment]', util.inspect(a, {showHidden: false, depth: null, colors: true}));
    } catch (e) {
        console.log('Error:', e);
    }
}*/
console.log('Done.');
