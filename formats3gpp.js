// 3GPP-convention formatters for telco CDR fields, keyed by the schema type
// or field name (TS 32.298 TimeStamp, TS 29.002 TBCD/AddressString,
// TS 24.008 PLMN). Registered from index.js via ASN1.typeFormatters.
// Every formatter returns null when the bytes do not fit the convention,
// so the caller falls back to the default rendering.
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

function bcdDigit(n) {
    return (n <= 9) ? String(n) : null;
}

function bcd2(b) { // two BCD digits, high nibble first (0x20 -> '20')
    const h = bcdDigit(b >> 4 & 0xF),
        l = bcdDigit(b & 0xF);
    return (h !== null && l !== null) ? h + l : null;
}

function tbcdDigits(bytes, from = 0) { // swapped nibbles, 0xF = filler
    let s = '';
    for (let i = from; i < bytes.length; ++i) {
        const lo = bytes[i] & 0xF,
            hi = bytes[i] >> 4 & 0xF;
        if (lo === 0xF)
            break;
        const dl = bcdDigit(lo);
        if (dl === null)
            return null;
        s += dl;
        if (hi === 0xF)
            break;
        const dh = bcdDigit(hi);
        if (dh === null)
            return null;
        s += dh;
    }
    return s.length ? s : null;
}

function timeStamp(bytes) { // TS 32.298: YYMMDDhhmmss BCD, '+'/'-', hhmm BCD
    if (bytes.length != 9)
        return null;
    const p = [];
    for (let i = 0; i < 6; ++i) {
        const d = bcd2(bytes[i]);
        if (d === null)
            return null;
        p.push(d);
    }
    const sign = String.fromCharCode(bytes[6]);
    if (sign != '+' && sign != '-')
        return null;
    const tzh = bcd2(bytes[7]),
        tzm = bcd2(bytes[8]);
    if (tzh === null || tzm === null)
        return null;
    let year = +p[0];
    year += (year < 70) ? 2000 : 1900; // same sliding window as UTCTime
    return year + '-' + p[1] + '-' + p[2] + ' ' + p[3] + ':' + p[4] + ':' + p[5] +
        ' UTC' + sign + tzh + ':' + tzm;
}

function tbcdString(bytes) {
    return tbcdDigits(bytes);
}

function addressString(bytes) { // TS 29.002: TON/NPI octet + TBCD digits
    if (bytes.length < 2)
        return null;
    const digits = tbcdDigits(bytes, 1);
    if (digits === null)
        return null;
    const international = (bytes[0] >> 4 & 0x7) == 1;
    return (international ? '+' : '') + digits +
        ' (TON/NPI ' + bytes[0].toString(16).toUpperCase().padStart(2, '0') + ')';
}

function plmnId(bytes) { // TS 24.008: MCC digit2|digit1, MNC digit3|MCC digit3, MNC digit2|digit1
    if (bytes.length != 3)
        return null;
    const mcc = [bytes[0] & 0xF, bytes[0] >> 4 & 0xF, bytes[1] & 0xF].map(bcdDigit),
        mnc = [bytes[2] & 0xF, bytes[2] >> 4 & 0xF].map(bcdDigit),
        mnc3 = bytes[1] >> 4 & 0xF;
    if (mcc.includes(null) || mnc.includes(null))
        return null;
    if (mnc3 != 0xF) {
        const d3 = bcdDigit(mnc3);
        if (d3 === null)
            return null;
        mnc.push(d3);
    }
    return 'MCC ' + mcc.join('') + ' MNC ' + mnc.join('');
}

function ipv4(bytes) {
    return (bytes.length == 4) ? Array.from(bytes).join('.') : null;
}

function ipv6(bytes) {
    if (bytes.length != 16)
        return null;
    const groups = [];
    for (let i = 0; i < 16; i += 2)
        groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
    return groups.join(':');
}

export const formats3gpp = {
    'TimeStamp': timeStamp,
    'TBCD-STRING': tbcdString,
    'IMSI': tbcdString,
    'IMEI': tbcdString,
    'MSISDN': addressString,
    'ISDN-AddressString': addressString,
    'AddressString': addressString,
    'PLMN-Id': plmnId,
    'iPBinV4Address': ipv4,
    'iPBinV6Address': ipv6,
};
