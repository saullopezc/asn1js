const
    id = (elem) => document.getElementById(elem),
    contextMenu = id('contextmenu'),
    btnCopyHex = id('btnCopyHex'),
    btnCopyB64 = id('btnCopyB64'),
    btnCopyTree = id('btnCopyTree'),
    btnCopyValue = id('btnCopyValue'),
    btnCopyJSON = id('btnCopyJSON'),
    btnSaveJSON = id('btnSaveJSON'),
    btnEdit = id('btnEdit'),
    btnDuplicate = id('btnDuplicate'),
    btnDelete = id('btnDelete'),
    btnAddField = id('btnAddField');

let handlers = {};

/**
 * Registers the callbacks invoked by the editing menu entries
 * ({edit, duplicate, remove, addField}). Wired from index.js to
 * avoid a circular import.
 */
export function setHandlers(h) {
    handlers = h;
}

function nodeJSON(node) {
    const asn1 = node.asn1;
    return JSON.stringify({ [asn1.def?.id || asn1.typeName()]: asn1 }, null, 2);
}

export function bindContextMenu(node) {
    const type = node.asn1.typeName();
    const valueEnabled = type != 'SET' && type != 'SEQUENCE';
    const editEnabled = node.asn1.sub === null; // only primitive values are editable
    node.onclick = function (event) {
        // do not show the menu in case of clicking the icon
        if (event.srcElement.nodeName != 'SPAN') return;
        contextMenu.style.left = event.pageX + 'px';
        contextMenu.style.top = event.pageY + 'px';
        contextMenu.style.visibility = 'visible';
        contextMenu.node = this;
        btnCopyValue.style.display = valueEnabled ? 'block' : 'none';
        btnEdit.style.display = (editEnabled && handlers.edit) ? 'block' : 'none';
        const dupOk = handlers.duplicate && (!handlers.canDuplicate || handlers.canDuplicate(node.asn1));
        btnDuplicate.style.display = dupOk ? 'block' : 'none';
        btnDelete.style.display = handlers.remove ? 'block' : 'none';
        if (handlers.removeLabel) // mandatory fields are cleared, not removed
            btnDelete.innerText = handlers.removeLabel(node.asn1);
        // adding fields needs a constructed node with a matched schema definition
        const canAdd = node.asn1.sub !== null && Array.isArray(node.asn1.def?.type?.content);
        btnAddField.style.display = (canAdd && handlers.addField) ? 'block' : 'none';
        event.preventDefault();
        event.stopPropagation();
    };
}

function close(event) {
    contextMenu.style.visibility = 'hidden';
    event.stopPropagation();
}

contextMenu.onmouseleave = close;

btnCopyHex.onclick = function (event) {
    navigator.clipboard.writeText(contextMenu.node.asn1.toHexString('byte'));
    close(event);
};

btnCopyB64.onclick = function (event) {
    event.stopPropagation();
    navigator.clipboard.writeText(contextMenu.node.asn1.toB64String());
    close(event);
};

btnCopyTree.onclick = function (event) {
    event.stopPropagation();
    navigator.clipboard.writeText(contextMenu.node.asn1.toPrettyString());
    close(event);
};

btnCopyValue.onclick = function (event) {
    event.stopPropagation();
    navigator.clipboard.writeText(contextMenu.node.asn1.content());
    close(event);
};

btnCopyJSON.onclick = function (event) {
    event.stopPropagation();
    navigator.clipboard.writeText(nodeJSON(contextMenu.node));
    close(event);
};

btnSaveJSON.onclick = function (event) {
    event.stopPropagation();
    const asn1 = contextMenu.node.asn1;
    const blob = new Blob([nodeJSON(contextMenu.node)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (asn1.def?.id || asn1.typeName()) + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    close(event);
};

function actionButton(button, name) {
    button.onclick = function (event) {
        event.stopPropagation();
        const node = contextMenu.node;
        close(event);
        if (handlers[name])
            handlers[name](node.asn1);
    };
}
actionButton(btnEdit, 'edit');
actionButton(btnDuplicate, 'duplicate');
actionButton(btnDelete, 'remove');
actionButton(btnAddField, 'addField');
