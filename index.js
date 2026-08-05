import './theme.js';
import { ASN1, Stream } from './asn1.js';
import { ASN1DOM } from './dom.js';
import { formats3gpp } from './formats3gpp.js';
import { Base64 } from './base64.js';
import { Hex } from './hex.js';
import { Defs } from './defs.js';
import { parseSchema, checkReferences } from './asn1schema.js';
import { encodeNode, encodeInteger, buildElementTLV, defaultContent, universalTags } from './encoder.js';
import { setHandlers } from './context.js';
import { tags } from './tags.js';

const
    maxLength = 10240,
    reHex = /^\s*(?:[0-9A-Fa-f][0-9A-Fa-f]\s*)+$/,
    tree = id('tree'),
    dump = id('dump'),
    wantHex = checkbox('wantHex'),
    trimHex = checkbox('trimHex'),
    wantDef = checkbox('wantDef'),
    wantUrl = checkbox('wantUrl'),
    area = id('area'),
    file = id('file'),
    examples = id('examples'),
    selectDefs = id('definitions'),
    selectTag = id('tags'),
    recnav = id('recnav'),
    recPrev = id('recPrev'),
    recNext = id('recNext'),
    recLabel = id('recLabel'),
    schemaFile = id('schemaFile'),
    schemaStatus = id('schemaStatus'),
    searchText = id('searchText'),
    searchIn = id('searchIn'),
    butFind = id('butFind'),
    butFindPrev = id('butFindPrev'),
    butFindNext = id('butFindNext'),
    replaceText = id('replaceText'),
    butReplace = id('butReplace'),
    butFilter = id('butFilter'),
    searchInfo = id('searchInfo');

const
    maxRecords = 1000000, // safety cap: malformed input must not exhaust memory
    recCacheMax = 16, // decoded trees kept for fast navigation
    maxSearchContent = 16384; // cap per-value preview built during search

ASN1.typeFormatters = formats3gpp; // telco-friendly rendering of CDR fields

let hash = null;
let recOffsets = [], // start offset of each record; trees are decoded lazily
    recCache = new Map(), // record index -> decoded tree (insertion order = LRU)
    currentRec = null, // decoded tree of the visible record
    recIndex = 0,
    recRemain = null,
    currentType = null,
    userMods = [],
    currentDer = null,
    currentName = null,
    currentSchemaText = null,
    currentSchemaName = null,
    searchResults = [], // {ri, path}: node paths, valid across re-renders
    searchIndex = -1,
    filterList = null; // sorted record indexes matching the active filter

function recordAt(i) {
    let r = recCache.get(i);
    if (r) {
        recCache.delete(i); // re-insert: Map iteration order doubles as LRU
        recCache.set(i, r);
        return r;
    }
    r = ASN1DOM.decode(currentDer, recOffsets[i]);
    recCache.set(i, r);
    if (recCache.size > recCacheMax)
        recCache.delete(recCache.keys().next().value);
    return r;
}
function nodeByPath(root, path) {
    let n = root;
    for (const i of path) {
        if (!n.sub || !n.sub[i])
            return null;
        n = n.sub[i];
    }
    return n;
}

if (!window.console || !window.console.log) // IE8 with closed developer tools
    window.console = { log: function () {} };
function id(elem) {
    return document.getElementById(elem);
}
function text(el, string) {
    if ('textContent' in el) el.textContent = string;
    else el.innerText = string;
}
function checkbox(name) {
    const el = id(name);
    const cfg = localStorage.getItem(name);
    if (cfg === 'false')
        el.checked = false;
    el.onchange = () => localStorage.setItem(name, el.checked);
    return el;
}
function show(asn1) {
    tree.innerHTML = '';
    dump.innerHTML = '';
    let ul = document.createElement('ul');
    ul.className = 'treecollapse';
    tree.appendChild(ul);
    ul.appendChild(asn1.toDOM());
    if (wantHex.checked) dump.appendChild(asn1.toHexDOM(undefined, trimHex.checked));
}
function showCurrent() {
    recnav.style.display = (recOffsets.length > 1) ? '' : 'none';
    let label = 'record ' + (recIndex + 1) + ' of ' + recOffsets.length;
    if (filterList) {
        const pos = filterList.indexOf(recIndex);
        label += ' — filtered ' + (pos >= 0 ? (pos + 1) : '·') + ' of ' + filterList.length;
        recPrev.disabled = !filterList.some(ri => ri < recIndex);
        recNext.disabled = !filterList.some(ri => ri > recIndex);
    } else {
        recPrev.disabled = (recIndex === 0);
        recNext.disabled = (recIndex === recOffsets.length - 1);
    }
    recLabel.innerText = label;
    try {
        currentRec = recordAt(recIndex);
    } catch (e) { // lazily-decoded record may turn out corrupted
        currentRec = null;
        text(tree, 'Record ' + (recIndex + 1) + ' cannot be decoded: ' + e);
        dump.innerHTML = '';
        return;
    }
    Defs.match(currentRec, wantDef.checked ? currentType : null);
    show(currentRec);
    // re-apply search marks (the tree is rebuilt on every render)
    for (const r of searchResults)
        if (r.ri === recIndex) {
            const n = nodeByPath(currentRec, r.path);
            if (n && n.head)
                n.head.classList.add('found');
        }
    if (recRemain) {
        let p = document.createElement('p');
        p.innerText = recRemain;
        tree.insertBefore(p, tree.firstChild);
    }
}
function gotoResult(i) {
    if (searchResults.length === 0)
        return;
    searchIndex = (i + searchResults.length) % searchResults.length;
    const r = searchResults[searchIndex];
    recIndex = r.ri;
    showCurrent();
    searchInfo.innerText = 'match ' + (searchIndex + 1) + ' of ' + searchResults.length +
        (recOffsets.length > 1 ? ' (record ' + (r.ri + 1) + ')' : '');
    const n = currentRec && nodeByPath(currentRec, r.path);
    if (n && n.head) {
        n.head.classList.add('foundCurrent');
        n.head.scrollIntoView({ block: 'center' });
    }
}
function nodeHay(n, scope) {
    // the text a node offers to search/filter, per scope: 'values' | 'names' | 'all'
    let hay = '';
    if (scope != 'values') {
        hay += n.typeName();
        if (n.def?.id) hay += ' ' + n.def.id;
        if (n.def?.name) hay += ' ' + n.def.name;
    }
    if (scope != 'names')
        try {
            const c = n.content(maxSearchContent);
            if (c !== null) hay += ' ' + c;
        } catch (ignore) { /*ignore*/ }
    return hay;
}
function recordMatches(rec, term, scope) {
    let found = false;
    (function walk(n) {
        if (found)
            return;
        if (nodeHay(n, scope).toLowerCase().indexOf(term) >= 0) {
            found = true;
            return;
        }
        if (n.sub)
            n.sub.forEach(walk);
    })(rec);
    return found;
}
function doFilter() {
    if (filterList) { // toggle off
        filterList = null;
        butFilter.value = 'filter';
        searchInfo.innerText = '';
        if (recOffsets.length)
            showCurrent();
        return;
    }
    const term = searchText.value.trim().toLowerCase();
    if (!term || recOffsets.length === 0)
        return;
    const scope = searchIn.value;
    const list = [];
    for (let ri = 0; ri < recOffsets.length; ++ri)
        try {
            const rec = (ri === recIndex && currentRec) ? currentRec : ASN1DOM.decode(currentDer, recOffsets[ri]);
            if (wantDef.checked)
                Defs.match(rec, currentType);
            if (recordMatches(rec, term, scope))
                list.push(ri);
        } catch (ignore) { /* corrupted record: not part of the filter */ }
    if (list.length === 0) {
        searchInfo.innerText = 'no records match the filter';
        return;
    }
    filterList = list;
    butFilter.value = 'unfilter';
    if (!list.includes(recIndex))
        recIndex = list[0];
    showCurrent();
    searchInfo.innerText = 'filter: ' + list.length + ' of ' + recOffsets.length + ' records';
}
function doSearch() {
    const term = searchText.value.trim().toLowerCase();
    searchResults = [];
    searchIndex = -1;
    if (!term || recOffsets.length === 0) {
        searchInfo.innerText = '';
        if (recOffsets.length) showCurrent();
        return;
    }
    // records are decoded transiently one at a time (memory stays flat);
    // matches are stored as node paths so they survive re-renders
    const path = [];
    for (let ri = 0; ri < recOffsets.length; ++ri) {
        let rec;
        try {
            rec = (ri === recIndex && currentRec) ? currentRec : ASN1DOM.decode(currentDer, recOffsets[ri]);
        } catch (ignore) {
            continue; // corrupted record: skip
        }
        if (wantDef.checked) // annotate field names also on non-visible records
            Defs.match(rec, currentType);
        const scope = searchIn.value; // 'values' | 'names' | 'all'
        (function walk(n) {
            if (nodeHay(n, scope).toLowerCase().indexOf(term) >= 0)
                searchResults.push({ ri, path: path.slice() });
            if (n.sub)
                n.sub.forEach((s, i) => {
                    path.push(i);
                    walk(s);
                    path.pop();
                });
        })(rec);
    }
    if (searchResults.length)
        gotoResult(0);
    else
        searchInfo.innerText = 'no matches';
}
function editableRepr(n) {
    // the text form of a primitive value that can be edited and re-encoded,
    // chosen by the effective type (same rules as editValue)
    if (n.sub !== null)
        return null;
    const tn = n.tag.isUniversal() ? n.tag.tagNumber : universalTags[n.defType()?.name];
    if (tn == 0x02 || tn == 0x0A)
        return { kind: 'int', text: n.content(Infinity).replace(/^\(\d+ bit\)\n/, '').split(' ')[0] };
    if ([0x0C, 0x12, 0x13, 0x16, 0x17, 0x18, 0x1A, 0x1B].includes(tn))
        return { kind: 'text', text: n.content(Infinity) };
    return { kind: 'hex', text: n.stream.hexDump(n.posContent(), n.posEnd(), 'raw') };
}
function encodeRepr(kind, text) {
    if (kind == 'int')
        return encodeInteger(text);
    if (kind == 'text')
        return new TextEncoder().encode(text);
    return Hex.decode(text);
}
function collectReplacements(rec, term, repl) {
    // finds the values of a record whose editable text contains `term`;
    // with repl !== null it also builds the content edits for encodeNode
    const edits = new Map();
    let occurrences = 0, values = 0, skipped = 0;
    (function walk(n) {
        const r = editableRepr(n);
        if (r && r.text.indexOf(term) >= 0) {
            occurrences += r.text.split(term).length - 1;
            ++values;
            if (repl !== null)
                try {
                    edits.set(n, encodeRepr(r.kind, r.text.split(term).join(repl)));
                } catch (ignore) {
                    ++skipped; // the replacement is not valid for this type
                }
        }
        if (n.sub)
            n.sub.forEach(walk);
    })(rec);
    return { edits, occurrences, values, skipped };
}
function doReplaceAll() {
    const term = searchText.value; // replacing is case-sensitive on purpose
    const repl = replaceText.value;
    if (!term || !currentDer || recOffsets.length === 0)
        return;
    const recordAtTransient = ri => {
        const rec = ASN1DOM.decode(currentDer, recOffsets[ri]);
        if (wantDef.checked)
            Defs.match(rec, currentType);
        return rec;
    };
    // pass 1 (dry run): count occurrences to confirm before touching anything
    let occurrences = 0, values = 0;
    const recs = new Set();
    for (let ri = 0; ri < recOffsets.length; ++ri)
        try {
            const c = collectReplacements(recordAtTransient(ri), term, null);
            if (c.occurrences) {
                occurrences += c.occurrences;
                values += c.values;
                recs.add(ri);
            }
        } catch (ignore) { /* corrupted record: left untouched */ }
    if (occurrences === 0) {
        searchInfo.innerText = 'nothing to replace';
        return;
    }
    if (!confirm('Replace ' + occurrences + ' occurrence(s) in ' + values + ' value(s) across ' +
        recs.size + ' record(s) of ' + recOffsets.length + '?\n\n"' + term + '" → "' + repl + '"'))
        return;
    // pass 2: re-encode each affected record and rebuild the file buffer,
    // preserving corrupted records and trailing bytes verbatim
    const parts = [];
    let skipped = 0;
    parts.push(currentDer.subarray(0, recOffsets[0]));
    for (let ri = 0; ri < recOffsets.length; ++ri) {
        const start = recOffsets[ri];
        const end = (ri + 1 < recOffsets.length) ? recOffsets[ri + 1] : currentDer.length;
        let rec = null;
        try {
            rec = recordAtTransient(ri);
        } catch (ignore) { /* keep raw bytes below */ }
        if (!rec) {
            parts.push(currentDer.subarray(start, end));
            continue;
        }
        const c = collectReplacements(rec, term, repl);
        skipped += c.skipped;
        parts.push(c.edits.size ? encodeNode(rec, c.edits) : currentDer.subarray(start, rec.posEnd()));
        if (rec.posEnd() < end) // trailing/undecoded bytes after the record
            parts.push(currentDer.subarray(rec.posEnd(), end));
    }
    const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    reload(out);
    searchInfo.innerText = 'replaced ' + occurrences + ' occurrence(s) in ' + recs.size + ' record(s)' +
        (skipped ? ' — ' + skipped + ' value(s) skipped (replacement not valid for their type)' : '');
}
function rebuildDefs() {
    currentType = null;
    if (recOffsets.length === 0)
        return;
    let first;
    try {
        first = recordAt(0);
    } catch (ignore) {
        return;
    }
    if (wantDef.checked) {
        selectDefs.innerHTML = '';
        // candidate root types: every type of each user schema + the common RFC types
        const candidates = [];
        for (const mod of userMods)
            for (const name of Object.keys(mod.types))
                candidates.push(Object.assign({ description: name + ' (' + mod.name + ')' }, Defs.moduleAndType(mod, name)));
        candidates.push(...Defs.commonTypes);
        const types = candidates
            .map(type => {
                const stats = Defs.match(first, type);
                return { type, match: stats.recognized / stats.total };
            })
            .sort((a, b) => b.match - a.match);
        for (const t of types) {
            t.element = document.createElement('option');
            t.element.innerText = (t.match * 100).toFixed(1) + '% ' + t.type.description;
            selectDefs.appendChild(t.element);
        }
        let not = document.createElement('option');
        not.innerText = 'no definition';
        selectDefs.appendChild(not);
        currentType = types[0].type;
        selectDefs.onchange = () => {
            currentType = null;
            for (const t of types)
                if (t.element == selectDefs.selectedOptions[0])
                    currentType = t.type;
            showCurrent();
        };
    } else
        selectDefs.innerHTML = '<option>no definition</option>';
}
function loadSchema(text, source) {
    try {
        const mod = parseSchema(text, source, Defs.RFC);
        const missing = checkReferences(mod, name => {
            try {
                Defs.searchType(name);
                return true;
            } catch (ignore) {
                return false;
            }
        });
        Defs.RFC[mod.oid || mod.name] = mod;
        userMods = userMods.filter(m => m.name != mod.name); // reloading replaces
        userMods.push(mod);
        const warnings = (mod.warnings ?? []).concat(
            missing.length ? ['unresolved references: ' + missing.join(', ')] : []);
        let s = 'OK: ' + mod.name + ', ' + Object.keys(mod.types).length + ' types';
        for (const w of warnings)
            s += '\nWarning: ' + w;
        schemaStatus.innerText = s;
        schemaStatus.className = warnings.length ? 'schema-warn' : 'schema-ok';
        currentSchemaText = text;
        currentSchemaName = source;
        rebuildDefs();
        if (recOffsets.length)
            showCurrent();
        updateHash();
    } catch (e) {
        schemaStatus.innerText = 'Error: ' + (e.message || e);
        schemaStatus.className = 'schema-err';
    }
}
const maxSchemaHash = 100000; // schemas bigger than this are not reflected in the URL
function updateHash() {
    // keep the URL in sync so a refresh (or a shared link) restores the
    // session; without a schema the legacy '#<base64>' form is kept
    if (!wantUrl.checked) {
        // privacy: keep data and schema out of the URL and browser history
        try {
            window.location.hash = hash = '';
        } catch (ignore) { /*ignore*/ }
        return;
    }
    const parts = [];
    let dataB64 = '';
    if (currentDer && recOffsets.length && currentDer.length < maxLength)
        dataB64 = new Stream(currentDer, 0).b64Dump(0, currentDer.length);
    if (currentSchemaText) {
        const bytes = new TextEncoder().encode(currentSchemaText);
        const schemaB64 = new Stream(bytes, 0).b64Dump(0, bytes.length);
        if (schemaB64.length <= maxSchemaHash) {
            if (dataB64)
                parts.push('data=' + dataB64);
            parts.push('schema=' + schemaB64);
            if (currentSchemaName)
                parts.push('sname=' + encodeURIComponent(currentSchemaName));
        }
    }
    const h = parts.length ? '#' + parts.join('&') : (dataB64 ? '#' + dataB64 : '');
    try {
        window.location.hash = hash = h;
    } catch (ignore) {
        // fails with "Access Denied" on IE with URLs longer than ~2048 chars
        window.location.hash = hash = '#';
    }
}
function spliceFile(start, end, insert) {
    // returns a new buffer where bytes [start, end) are replaced by `insert`
    const ins = insert || new Uint8Array(0);
    const out = new Uint8Array(currentDer.length - (end - start) + ins.length);
    out.set(currentDer.subarray(0, start), 0);
    out.set(ins, start);
    out.set(currentDer.subarray(end), start + ins.length);
    return out;
}
function reload(out) {
    // re-index a modified buffer, staying on the same record if possible
    const idx = recIndex;
    decode(out);
    if (recOffsets.length) {
        recIndex = Math.min(idx, recOffsets.length - 1);
        showCurrent();
    }
}
function rebuildRecord(edits) {
    // re-encode the current record (with optional content edits or a mutated
    // sub tree) and splice it into the file buffer; offsets become stale
    const recBytes = encodeNode(currentRec, edits);
    reload(spliceFile(currentRec.posStart(), currentRec.posEnd(), recBytes));
}
function applyEdit(asn1, content) {
    rebuildRecord(new Map([[asn1, content]]));
}
function findParent(root, target) {
    if (root.sub)
        for (const c of root.sub) {
            if (c === target)
                return root;
            const p = findParent(c, target);
            if (p)
                return p;
        }
    return null;
}
function nodeBytes(asn1) {
    return currentDer.subarray(asn1.posStart(), asn1.posEnd());
}
function editValue(asn1) {
    if (!currentDer || !currentRec)
        return;
    const label = asn1.def?.id || asn1.typeName();
    // effective type: the value's own universal tag, or (for implicit tags)
    // the type resolved by the matched schema definition
    const tn = asn1.tag.isUniversal()
        ? asn1.tag.tagNumber
        : universalTags[asn1.defType()?.name];
    let content;
    try {
        if (tn == 0x02 || tn == 0x0A) { // INTEGER, ENUMERATED
            const cur = asn1.content(Infinity).replace(/^\(\d+ bit\)\n/, '').split(' ')[0];
            const v = prompt('New value for ' + label + ' (decimal integer):', cur);
            if (v === null) return;
            content = encodeInteger(v);
        } else if (tn == 0x01) { // BOOLEAN
            const v = prompt('New value for ' + label + ' (true/false):', asn1.content());
            if (v === null) return;
            content = Uint8Array.of(/^t(rue)?$/i.test(v.trim()) ? 0xFF : 0x00);
        } else if ([0x0C, 0x12, 0x13, 0x16, 0x17, 0x18, 0x1A, 0x1B].includes(tn)) {
            // string and time types: edit as text, encoded as UTF-8/ASCII
            const v = prompt('New value for ' + label + ' (text):', asn1.content(Infinity));
            if (v === null) return;
            content = new TextEncoder().encode(v);
        } else { // everything else (OCTET STRING, BIT STRING, OID, unknown…): raw hex
            const cur = asn1.stream.hexDump(asn1.posContent(), asn1.posEnd(), 'raw');
            const v = prompt('New value for ' + label + ' (hex bytes):', cur);
            if (v === null) return;
            content = Hex.decode(v);
        }
        applyEdit(asn1, content);
    } catch (e) {
        alert('Cannot edit value: ' + e);
    }
}
const resolveType = name => Defs.searchType(name).type;
function isListParent(parent) {
    return parent.def?.typeOf == 1 || parent.def?.type?.typeOf == 1;
}
function canDuplicate(asn1) {
    // duplicating is only valid where repetition is legal: whole records,
    // elements of a SEQUENCE OF / SET OF, or (without schema) values whose
    // siblings already repeat the same tag; unique fields would be malformed
    if (!currentDer || !currentRec)
        return false;
    if (asn1 === currentRec)
        return true;
    const parent = findParent(currentRec, asn1);
    if (!parent || !parent.tag.tagConstructed)
        return false;
    if (isListParent(parent))
        return true;
    if (Array.isArray(parent.def?.type?.content) || Array.isArray(parent.def?.content))
        return false; // schema matched: named fields are unique
    return parent.sub.some(s => s !== asn1 &&
        s.tag.tagClass == asn1.tag.tagClass && s.tag.tagNumber == asn1.tag.tagNumber);
}
function duplicateValue(asn1) {
    if (!canDuplicate(asn1)) {
        alert('Only whole records and elements of a list (SEQUENCE OF / SET OF) can be duplicated: unique fields would malform the record.');
        return;
    }
    if (asn1 === currentRec) { // whole record: insert a copy right after it
        reload(spliceFile(asn1.posEnd(), asn1.posEnd(), nodeBytes(asn1)));
        return;
    }
    const parent = findParent(currentRec, asn1);
    parent.sub.splice(parent.sub.indexOf(asn1) + 1, 0, { rawBytes: nodeBytes(asn1).slice() });
    rebuildRecord();
}
function isMandatoryField(asn1) {
    // a value that the schema marks as a non-optional field of its container
    // (never a whole record nor an element of a list)
    if (!currentDer || !currentRec || asn1 === currentRec)
        return false;
    const parent = findParent(currentRec, asn1);
    if (!parent || !parent.tag.tagConstructed || isListParent(parent))
        return false;
    return Boolean(asn1.def?.id && asn1.def.optional !== true);
}
function removeValue(asn1) {
    if (!currentDer || !currentRec)
        return;
    const label = asn1.def?.id || asn1.typeName();
    if (asn1 === currentRec) { // whole record
        if (!confirm('Delete record ' + (recIndex + 1) + ' of ' + recOffsets.length + '?'))
            return;
        reload(spliceFile(asn1.posStart(), asn1.posEnd(), null));
        return;
    }
    const parent = findParent(currentRec, asn1);
    if (!parent || !parent.tag.tagConstructed) {
        alert('Cannot delete here: the container is not a constructed value.');
        return;
    }
    if (isMandatoryField(asn1)) {
        // mandatory field per schema: empty it instead of removing it
        if (!confirm('Clear ' + label + '? (mandatory field: its value is emptied, the field remains)'))
            return;
        applyEdit(asn1, defaultContent(asn1.def.type?.name));
        return;
    }
    if (!confirm('Delete ' + label + '?'))
        return;
    parent.sub.splice(parent.sub.indexOf(asn1), 1);
    rebuildRecord();
}
function addField(asn1) {
    if (!currentDer)
        return;
    const content = asn1.def?.type?.content;
    if (!Array.isArray(content)) {
        alert('No schema definition matched for this value: load a schema first.');
        return;
    }
    const present = new Set(asn1.sub.map(s => s.def?.id).filter(Boolean));
    const missing = content.filter(el => el.id && !present.has(el.id));
    if (missing.length === 0) {
        alert('All schema fields are already present.');
        return;
    }
    let msg = 'Add field to ' + (asn1.def?.id || asn1.typeName()) + ' — type a name or number:\n';
    missing.forEach((el, i) => {
        msg += (i + 1) + ') ' + el.id + (el.optional ? '' : ' (mandatory, missing!)') + '\n';
    });
    const v = prompt(msg, '');
    if (v === null || v.trim() === '')
        return;
    const pick = v.trim();
    const el = missing[+pick - 1] ?? missing.find(m => m.id == pick);
    if (!el) {
        alert('Unknown field: ' + pick);
        return;
    }
    try {
        const tlv = buildElementTLV(el, resolveType);
        // insert respecting the schema order of the container
        const orderOf = id => content.findIndex(c => c.id == id);
        const newOrder = orderOf(el.id);
        let pos = 0;
        for (const child of asn1.sub) {
            if (orderOf(child.def?.id) > newOrder)
                break;
            ++pos;
        }
        asn1.sub.splice(pos, 0, { rawBytes: tlv });
        rebuildRecord();
    } catch (e) {
        alert('Cannot add ' + el.id + ': ' + (e.message || e));
    }
}
setHandlers({
    edit: editValue,
    duplicate: duplicateValue,
    canDuplicate,
    remove: removeValue,
    removeLabel: asn1 => isMandatoryField(asn1) ? 'Clear value' : 'Delete',
    addField,
});
export function decode(der, offset) {
    offset = offset || 0;
    if (typeof der == 'string') { // e.g. binary string from FileReader
        const u8 = new Uint8Array(der.length);
        for (let i = 0; i < der.length; ++i)
            u8[i] = der.charCodeAt(i) & 0xFF;
        der = u8;
    }
    currentDer = der;
    recOffsets = [];
    recCache.clear();
    currentRec = null;
    recIndex = 0;
    recRemain = null;
    currentType = null;
    searchResults = []; // decoded trees are rebuilt: previous results are stale
    searchIndex = -1;
    searchInfo.innerText = '';
    filterList = null;
    butFilter.value = 'filter';
    try {
        // index all concatenated structures (e.g. CDR files contain many
        // records) WITHOUT decoding them: trees are built lazily per record
        const scan = ASN1DOM.scanRecords(der, offset, maxRecords);
        recOffsets = scan.offsets;
        if (scan.error) {
            if (recOffsets.length === 0)
                throw new Error(scan.error.message);
            recRemain = 'Input contains ' + (der.length - scan.error.offset) +
                ' undecoded bytes at offset ' + scan.error.offset + '. ' + scan.error.message;
        }
        rebuildDefs();
        showCurrent();
        let b64 = der.length < maxLength ? new Stream(der, 0).b64Dump(offset, der.length) : '';
        if (area.value === '') area.value = Base64.pretty(b64);
        updateHash();
    } catch (e) {
        text(tree, e);
        dump.innerHTML = '';
        recnav.style.display = 'none';
    }
}
export function decodeText(val) {
    try {
        let der = reHex.test(val) ? Hex.decode(val) : Base64.unarmor(val);
        decode(der);
    } catch (e) {
        text(tree, e);
        dump.innerHTML = '';
    }
}
function looksLikeText(u8) {
    // sniff a printable-ASCII prefix (hex / base64 / PEM files)
    const n = Math.min(u8.length, 4096);
    if (n === 0)
        return false;
    for (let i = 0; i < n; ++i) {
        const b = u8[i];
        if (b != 9 && b != 10 && b != 13 && (b < 32 || b > 126))
            return false;
    }
    return true;
}
export function decodeBinaryString(data) {
    // accepts the file content as Uint8Array (or a legacy binary string)
    let der;
    try {
        if (typeof data == 'string') {
            if (reHex.test(data)) der = Hex.decode(data);
            else if (Base64.re.test(data)) der = Base64.unarmor(data);
            else der = data;
        } else if (looksLikeText(data)) {
            const s = new TextDecoder().decode(data);
            if (reHex.test(s)) der = Hex.decode(s);
            else if (Base64.re.test(s)) der = Base64.unarmor(s);
            else der = data;
        } else
            der = data; // raw BER/DER: no intermediate string is built
        decode(der);
    } catch (ignore) {
        text(tree, 'Cannot decode file.');
        dump.innerHTML = '';
    }
}
// set up buttons
const butClickHandlers = {
    butDecode: () => {
        decodeText(area.value);
    },
    butClear: () => {
        area.value = '';
        file.value = '';
        tree.innerHTML = '';
        dump.innerHTML = '';
        selectDefs.innerHTML = '';
        recOffsets = [];
        recCache.clear();
        currentRec = null;
        recRemain = null;
        currentDer = null;
        currentName = null;
        searchResults = [];
        searchIndex = -1;
        searchInfo.innerText = '';
        filterList = null;
        butFilter.value = 'filter';
        recnav.style.display = 'none';
        updateHash(); // keeps the loaded schema in the URL, drops the data
    },
    butDownload: () => {
        if (!currentDer) {
            alert('Nothing to save: decode some data first.');
            return;
        }
        const blob = new Blob([currentDer], { type: 'application/octet-stream' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = currentName || 'data.der';
        a.click();
        URL.revokeObjectURL(a.href);
    },
    butStats: () => {
        if (!currentDer || recOffsets.length === 0) {
            alert('Nothing to analyze: decode some data first.');
            return;
        }
        const roots = {}, // root name -> count
            named = {}, // field -> {rendered value -> count}
            numeric = {}; // field -> {count, min, max, sum}
        let bad = 0;
        for (let ri = 0; ri < recOffsets.length; ++ri) {
            let rec;
            try {
                rec = ASN1DOM.decode(currentDer, recOffsets[ri]);
            } catch (ignore) {
                ++bad;
                continue;
            }
            if (wantDef.checked)
                Defs.match(rec, currentType);
            const rootName = rec.def?.id || rec.typeName();
            roots[rootName] = (roots[rootName] || 0) + 1;
            (function walk(n) {
                if (n.sub) {
                    n.sub.forEach(walk);
                    return;
                }
                const tn = n.tag.isUniversal() ? n.tag.tagNumber : universalTags[n.defType()?.name];
                if (tn != 0x02 && tn != 0x0A)
                    return; // only INTEGER/ENUMERATED fields are aggregated
                const label = n.def?.id || n.typeName();
                let c;
                try {
                    c = n.content(Infinity);
                } catch (ignore) {
                    return;
                }
                if (typeof c != 'string')
                    return;
                c = c.replace(/^\(\d+ bit\)\n/, '');
                if (c.indexOf(' (') >= 0 || tn == 0x0A) { // named values: frequency
                    const m = named[label] || (named[label] = {});
                    m[c] = (m[c] || 0) + 1;
                } else if (c.length <= 15) { // plain integers: totals
                    const v = Number(c);
                    if (!Number.isFinite(v))
                        return;
                    const st = numeric[label] || (numeric[label] = { count: 0, min: v, max: v, sum: 0 });
                    ++st.count;
                    st.sum += v;
                    st.min = Math.min(st.min, v);
                    st.max = Math.max(st.max, v);
                }
            })(rec);
        }
        let s = (currentName || 'input') + ': ' + recOffsets.length + ' records, ' +
            currentDer.length + ' bytes' + (bad ? ' (' + bad + ' undecodable)' : '') + '\n';
        s += '\nRecords by type:\n';
        for (const [k, v] of Object.entries(roots).sort((a, b) => b[1] - a[1]))
            s += '    ' + k + ': ' + v + '\n';
        const namedKeys = Object.keys(named).sort();
        if (namedKeys.length) {
            s += '\nValue frequencies:\n';
            for (const field of namedKeys) {
                s += '    ' + field + ':\n';
                const entries = Object.entries(named[field]).sort((a, b) => b[1] - a[1]);
                for (const [val, count] of entries.slice(0, 15))
                    s += '        ' + val + ': ' + count + '\n';
                if (entries.length > 15)
                    s += '        … ' + (entries.length - 15) + ' more distinct value(s)\n';
            }
        }
        const numKeys = Object.keys(numeric).sort();
        if (numKeys.length) {
            s += '\nNumeric fields:\n';
            for (const field of numKeys) {
                const st = numeric[field];
                s += '    ' + field + ': count=' + st.count + ' min=' + st.min +
                    ' max=' + st.max + ' sum=' + st.sum + '\n';
            }
        }
        s += '\n(use the record navigation or find to go back to the tree)';
        tree.innerHTML = '';
        dump.innerHTML = '';
        const pre = document.createElement('pre');
        pre.innerText = s;
        tree.appendChild(pre);
    },
    butExportJSON: () => {
        if (!currentDer || recOffsets.length === 0) {
            alert('Nothing to export: decode some data first.');
            return;
        }
        // every record, decoded transiently, as one JSON array
        const out = [];
        for (let ri = 0; ri < recOffsets.length; ++ri)
            try {
                const rec = ASN1DOM.decode(currentDer, recOffsets[ri]);
                if (wantDef.checked)
                    Defs.match(rec, currentType);
                out.push({ [rec.def?.id || rec.typeName()]: rec.toJSON() });
            } catch (e) {
                out.push({ error: 'record ' + (ri + 1) + ' cannot be decoded: ' + (e.message || e) });
            }
        const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (currentName ? currentName.replace(/\.[^.]*$/, '') : 'records') + '.json';
        a.click();
        URL.revokeObjectURL(a.href);
    },
    butExample: () => {
        console.log('Loading example:', examples.value);
        let request = new XMLHttpRequest();
        request.open('GET', 'examples/' + examples.value, true);
        request.onreadystatechange = function () {
            if (this.readyState !== 4) return;
            if (this.status >= 200 && this.status < 400) {
                area.value = this.responseText;
                decodeText(this.responseText);
            } else {
                console.log('Error loading example.');
            }
        };
        request.send();
    },
};
for (const [name, onClick] of Object.entries(butClickHandlers)) {
    let elem = id(name);
    if (elem)
        elem.onclick = onClick;
}
function stepRecord(delta) {
    if (filterList) { // move within the filtered list only
        let i = filterList.findIndex(ri => ri >= recIndex);
        if (i < 0)
            i = filterList.length;
        if (delta > 0) {
            if (i < filterList.length && filterList[i] === recIndex)
                ++i;
            if (i >= filterList.length)
                return;
        } else {
            --i;
            if (i < 0)
                return;
        }
        recIndex = filterList[i];
    } else {
        const next = recIndex + delta;
        if (next < 0 || next >= recOffsets.length)
            return;
        recIndex = next;
    }
    showCurrent();
}
recPrev.onclick = () => stepRecord(-1);
recNext.onclick = () => stepRecord(1);
wantUrl.addEventListener('change', updateHash); // applies (or clears) the hash right away
butFind.onclick = doSearch;
butReplace.onclick = doReplaceAll;
butFilter.onclick = doFilter;
butFindPrev.onclick = () => gotoResult(searchIndex - 1);
butFindNext.onclick = () => gotoResult(searchIndex + 1);
searchText.onkeydown = (ev) => {
    if (ev.key == 'Enter') {
        ev.preventDefault();
        doSearch();
    }
};
schemaFile.onchange = () => {
    if (schemaFile.files.length === 0) return;
    const f = schemaFile.files[0];
    const r = new FileReader();
    r.onloadend = () => {
        if (r.error) schemaStatus.innerText = 'Error reading file: ' + r.error;
        else loadSchema(r.result, f.name);
    };
    r.readAsText(f);
};
// this is only used if window.FileReader
function read(f) {
    area.value = ''; // clear text area, will get b64 content
    currentName = f.name;
    let r = new FileReader();
    r.onloadend = function () {
        if (r.error) alert("Your browser couldn't read the specified file (error code " + r.error.code + ').');
        else decodeBinaryString(new Uint8Array(r.result));
    };
    // ArrayBuffer avoids the memory-hungry (and deprecated) binary string
    r.readAsArrayBuffer(f);
}
function load() {
    if (file.files.length === 0) alert('Select a file to load first.');
    else read(file.files[0]);
}
function loadFromHash() {
    if (window.location.hash && window.location.hash != hash) {
        hash = window.location.hash;
        const raw = hash.substr(1);
        if (/^(data|schema|sname)=/.test(raw)) { // session form: data + user schema
            const params = new URLSearchParams(raw);
            const schemaB64 = params.get('schema');
            if (schemaB64)
                try {
                    const text = new TextDecoder().decode(Base64.decode(schemaB64));
                    loadSchema(text, params.get('sname') || 'schema from URL');
                } catch (e) {
                    schemaStatus.innerText = 'Error: cannot load schema from URL: ' + (e.message || e);
                    schemaStatus.className = 'schema-err';
                }
            const data = params.get('data');
            if (data) decodeText(data);
            return;
        }
        // Firefox is not consistent with other browsers and returns an
        // already-decoded hash string so we risk double-decoding here,
        // but since % is not allowed in base64 nor hexadecimal, it's ok
        let val = decodeURIComponent(raw);
        if (val.length) decodeText(val);
    }
}
function stop(e) {
    e.stopPropagation();
    e.preventDefault();
}
function dragAccept(e) {
    stop(e);
    if (e.dataTransfer.files.length > 0) read(e.dataTransfer.files[0]);
}
// main
if ('onhashchange' in window) window.onhashchange = loadFromHash;
loadFromHash();
document.ondragover = stop;
document.ondragleave = stop;
if ('FileReader' in window) {
    file.style.display = 'block';
    file.onchange = load;
    document.ondrop = dragAccept;
}
for (let tag in tags) {
    let date = tags[tag];
    let el = document.createElement('option');
    el.value = tag;
    el.innerText = date + ' ' + tag;
    selectTag.appendChild(el);
}
selectTag.onchange = function (ev) {
    let tag = ev.target.selectedOptions[0].value;
    window.location.href = 'https://rawcdn.githack.com/lapo-luchini/asn1js/' + tag + '/index.html';
};
