import './theme.js';
import { Stream } from './asn1.js';
import { ASN1DOM } from './dom.js';
import { Base64 } from './base64.js';
import { Hex } from './hex.js';
import { Defs } from './defs.js';
import { parseSchema, checkReferences } from './asn1schema.js';
import { encodeNode, encodeInteger, buildElementTLV, defaultContent } from './encoder.js';
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
    butFind = id('butFind'),
    butFindPrev = id('butFindPrev'),
    butFindNext = id('butFindNext'),
    searchInfo = id('searchInfo');

let hash = null;
let records = [],
    recIndex = 0,
    recRemain = null,
    currentType = null,
    userMods = [],
    currentDer = null,
    currentName = null,
    currentSchemaText = null,
    currentSchemaName = null,
    searchResults = [],
    searchIndex = -1;

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
    const asn1 = records[recIndex];
    Defs.match(asn1, wantDef.checked ? currentType : null);
    recnav.style.display = (records.length > 1) ? '' : 'none';
    recLabel.innerText = 'record ' + (recIndex + 1) + ' of ' + records.length;
    recPrev.disabled = (recIndex === 0);
    recNext.disabled = (recIndex === records.length - 1);
    show(asn1);
    // re-apply search marks (the tree is rebuilt on every render)
    for (const r of searchResults)
        if (r.ri === recIndex && r.node.head)
            r.node.head.classList.add('found');
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
        (records.length > 1 ? ' (record ' + (r.ri + 1) + ')' : '');
    if (r.node.head) {
        r.node.head.classList.add('foundCurrent');
        r.node.head.scrollIntoView({ block: 'center' });
    }
}
function doSearch() {
    const term = searchText.value.trim().toLowerCase();
    searchResults = [];
    searchIndex = -1;
    if (!term || records.length === 0) {
        searchInfo.innerText = '';
        if (records.length) showCurrent();
        return;
    }
    records.forEach((rec, ri) => {
        if (wantDef.checked) // annotate field names also on non-visible records
            Defs.match(rec, currentType);
        (function walk(n) {
            let hay = n.typeName();
            if (n.def?.id) hay += ' ' + n.def.id;
            if (n.def?.name) hay += ' ' + n.def.name;
            try {
                const c = n.content(Infinity);
                if (c !== null) hay += ' ' + c;
            } catch (ignore) { /*ignore*/ }
            if (hay.toLowerCase().indexOf(term) >= 0)
                searchResults.push({ ri, node: n });
            if (n.sub)
                n.sub.forEach(walk);
        })(rec);
    });
    if (searchResults.length)
        gotoResult(0);
    else
        searchInfo.innerText = 'no matches';
}
function rebuildDefs() {
    const first = records[0];
    currentType = null;
    if (!first)
        return;
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
        if (records.length)
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
    const parts = [];
    let dataB64 = '';
    if (currentDer && records.length && currentDer.length < maxLength)
        dataB64 = records[0].stream.b64Dump(0, currentDer.length);
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
    // re-decode a modified buffer, staying on the same record if possible
    const idx = recIndex;
    decode(out);
    if (records.length) {
        recIndex = Math.min(idx, records.length - 1);
        showCurrent();
    }
}
function rebuildRecord(edits) {
    // re-encode the current record (with optional content edits or a mutated
    // sub tree) and splice it into the file buffer; offsets become stale
    const rec = records[recIndex];
    const recBytes = encodeNode(rec, edits);
    reload(spliceFile(rec.posStart(), rec.posEnd(), recBytes));
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
    if (!currentDer || records.length === 0)
        return;
    const isUniversal = asn1.tag.isUniversal(),
        tn = asn1.tag.tagNumber,
        label = asn1.def?.id || asn1.typeName();
    let content;
    try {
        if (isUniversal && (tn == 0x02 || tn == 0x0A)) { // INTEGER, ENUMERATED
            const cur = asn1.content(Infinity).replace(/^\(\d+ bit\)\n/, '');
            const v = prompt('New value for ' + label + ' (decimal integer):', cur);
            if (v === null) return;
            content = encodeInteger(v);
        } else if (isUniversal && tn == 0x01) { // BOOLEAN
            const v = prompt('New value for ' + label + ' (true/false):', asn1.content());
            if (v === null) return;
            content = Uint8Array.of(/^t(rue)?$/i.test(v.trim()) ? 0xFF : 0x00);
        } else if (isUniversal && [0x0C, 0x12, 0x13, 0x16, 0x17, 0x18, 0x1A, 0x1B].includes(tn)) {
            // string and time types: edit as text, encoded as UTF-8/ASCII
            const v = prompt('New value for ' + label + ' (text):', asn1.content(Infinity));
            if (v === null) return;
            content = new TextEncoder().encode(v);
        } else { // everything else (context tags, OCTET STRING, BIT STRING, OID…): raw hex
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
    if (!currentDer || records.length === 0)
        return false;
    if (records.includes(asn1))
        return true;
    const parent = findParent(records[recIndex], asn1);
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
    if (records.includes(asn1)) { // whole record: insert a copy right after it
        reload(spliceFile(asn1.posEnd(), asn1.posEnd(), nodeBytes(asn1)));
        return;
    }
    const parent = findParent(records[recIndex], asn1);
    parent.sub.splice(parent.sub.indexOf(asn1) + 1, 0, { rawBytes: nodeBytes(asn1).slice() });
    rebuildRecord();
}
function isMandatoryField(asn1) {
    // a value that the schema marks as a non-optional field of its container
    // (never a whole record nor an element of a list)
    if (!currentDer || records.length === 0 || records.includes(asn1))
        return false;
    const parent = findParent(records[recIndex], asn1);
    if (!parent || !parent.tag.tagConstructed || isListParent(parent))
        return false;
    return Boolean(asn1.def?.id && asn1.def.optional !== true);
}
function removeValue(asn1) {
    if (!currentDer)
        return;
    const label = asn1.def?.id || asn1.typeName();
    if (records.includes(asn1)) { // whole record
        if (!confirm('Delete record ' + (recIndex + 1) + ' of ' + records.length + '?'))
            return;
        reload(spliceFile(asn1.posStart(), asn1.posEnd(), null));
        return;
    }
    const rec = records[recIndex];
    const parent = findParent(rec, asn1);
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
    records = [];
    recIndex = 0;
    recRemain = null;
    currentType = null;
    searchResults = []; // decoded trees are rebuilt: previous results are stale
    searchIndex = -1;
    searchInfo.innerText = '';
    try {
        // decode all concatenated structures (e.g. CDR files contain many records)
        let pos = offset;
        while (pos < der.length) {
            try {
                const asn1 = ASN1DOM.decode(der, pos);
                records.push(asn1);
                pos = asn1.posEnd();
            } catch (e) {
                if (records.length === 0)
                    throw e;
                recRemain = 'Input contains ' + (der.length - pos) + ' undecoded bytes at offset ' + pos + '. ' + e;
                break;
            }
        }
        if (records.length === 0)
            throw new Error('No ASN.1 structure found.');
        rebuildDefs();
        showCurrent();
        let b64 = der.length < maxLength ? records[0].stream.b64Dump(offset, der.length) : '';
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
export function decodeBinaryString(str) {
    let der;
    try {
        if (reHex.test(str)) der = Hex.decode(str);
        else if (Base64.re.test(str)) der = Base64.unarmor(str);
        else der = str;
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
        records = [];
        recRemain = null;
        currentDer = null;
        currentName = null;
        searchResults = [];
        searchIndex = -1;
        searchInfo.innerText = '';
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
recPrev.onclick = () => {
    if (recIndex > 0) {
        --recIndex;
        showCurrent();
    }
};
recNext.onclick = () => {
    if (recIndex < records.length - 1) {
        ++recIndex;
        showCurrent();
    }
};
butFind.onclick = doSearch;
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
        else decodeBinaryString(r.result);
    };
    r.readAsBinaryString(f);
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
if ('FileReader' in window && 'readAsBinaryString' in new FileReader()) {
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
