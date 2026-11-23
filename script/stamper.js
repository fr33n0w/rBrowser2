// Announce stamp solver (RNS destination stamps), run in Web Workers.
// Finds a stamp so that sha256(material + stamp) <= target, same as RNS.Stamps._loop_hash.
(function (root) {
    'use strict';

    const K = new Int32Array([
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
    const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

    // One SHA-256 compression of the 16 words in w (from offset wo) into st.
    function compress(st, w, wo, W) {
        for (let i = 0; i < 16; i++) W[i] = w[wo + i];
        for (let i = 16; i < 64; i++) {
            const a = W[i - 15], b = W[i - 2];
            const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
            const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
            W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
        }
        let a = st[0], b = st[1], c = st[2], d = st[3], e = st[4], f = st[5], g = st[6], h = st[7];
        for (let i = 0; i < 64; i++) {
            const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
            const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
            h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        st[0] = (st[0] + a) | 0; st[1] = (st[1] + b) | 0; st[2] = (st[2] + c) | 0; st[3] = (st[3] + d) | 0;
        st[4] = (st[4] + e) | 0; st[5] = (st[5] + f) | 0; st[6] = (st[6] + g) | 0; st[7] = (st[7] + h) | 0;
    }

    function hexToBytes(hex) {
        const out = new Uint8Array(hex.length >> 1);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
        return out;
    }

    function bytesToHex(b) {
        let s = '';
        for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
        return s;
    }

    function sha256(bytes) {
        const nb = Math.ceil((bytes.length + 9) / 64);
        const buf = new Uint8Array(nb * 64);
        buf.set(bytes); buf[bytes.length] = 0x80;
        const bits = bytes.length * 8;
        buf[buf.length - 4] = (bits >>> 24) & 255; buf[buf.length - 3] = (bits >>> 16) & 255;
        buf[buf.length - 2] = (bits >>> 8) & 255; buf[buf.length - 1] = bits & 255;
        const w = new Int32Array(nb * 16);
        for (let i = 0; i < w.length; i++) w[i] = (buf[i * 4] << 24) | (buf[i * 4 + 1] << 16) | (buf[i * 4 + 2] << 8) | buf[i * 4 + 3];
        const st = new Int32Array(IV), W = new Int32Array(64);
        for (let i = 0; i < nb; i++) compress(st, w, i * 16, W);
        const out = new Uint8Array(32);
        for (let i = 0; i < 8; i++) { out[i * 4] = st[i] >>> 24; out[i * 4 + 1] = st[i] >>> 16; out[i * 4 + 2] = st[i] >>> 8; out[i * 4 + 3] = st[i]; }
        return out;
    }

    // Searches up to maxRounds stamps starting from the start bytes; the last 4 bytes are a counter.
    // Returns {stamp, rounds} (stamp null if not found).
    function search(material, target, start, maxRounds) {
        const size = start.length;
        const total = material.length + size;
        const full = Math.floor(material.length / 64);
        const tailLen = total - full * 64;
        const nb = Math.ceil((tailLen + 9) / 64);
        const mid = new Int32Array(IV), W = new Int32Array(64);
        const mw = new Int32Array(16);
        for (let blk = 0; blk < full; blk++) {
            for (let i = 0; i < 16; i++) {
                const o = blk * 64 + i * 4;
                mw[i] = (material[o] << 24) | (material[o + 1] << 16) | (material[o + 2] << 8) | material[o + 3];
            }
            compress(mid, mw, 0, W);
        }
        const tail = new Uint8Array(nb * 64);
        tail.set(material.subarray(full * 64));
        const so = material.length - full * 64;
        tail.set(start, so);
        tail[tailLen] = 0x80;
        const bits = total * 8;
        tail[tail.length - 4] = (bits >>> 24) & 255; tail[tail.length - 3] = (bits >>> 16) & 255;
        tail[tail.length - 2] = (bits >>> 8) & 255; tail[tail.length - 1] = bits & 255;
        const tw = new Int32Array(nb * 16);
        for (let i = 0; i < tw.length; i++) tw[i] = (tail[i * 4] << 24) | (tail[i * 4 + 1] << 16) | (tail[i * 4 + 2] << 8) | tail[i * 4 + 3];
        const t = new Uint32Array(8);
        for (let i = 0; i < 8; i++) t[i] = (target[i * 4] << 24 | target[i * 4 + 1] << 16 | target[i * 4 + 2] << 8 | target[i * 4 + 3]) >>> 0;

        const co = so + size - 4;
        const w0 = co >> 2, w1 = (co + 3) >> 2;
        let ctr = ((start[size - 4] << 24) | (start[size - 3] << 16) | (start[size - 2] << 8) | start[size - 1]) >>> 0;
        const st = new Int32Array(8);
        for (let r = 0; r < maxRounds; r++) {
            tail[co] = ctr >>> 24; tail[co + 1] = ctr >>> 16; tail[co + 2] = ctr >>> 8; tail[co + 3] = ctr;
            for (let i = w0; i <= w1; i++) tw[i] = (tail[i * 4] << 24) | (tail[i * 4 + 1] << 16) | (tail[i * 4 + 2] << 8) | tail[i * 4 + 3];
            st.set(mid);
            for (let b = 0; b < nb; b++) compress(st, tw, b * 16, W);
            for (let i = 0; i < 8; i++) {
                const h = st[i] >>> 0;
                if (h < t[i]) return { stamp: tail.slice(so, so + size), rounds: r + 1 };
                if (h > t[i]) break;
                if (i === 7) return { stamp: tail.slice(so, so + size), rounds: r + 1 };
            }
            ctr = (ctr + 1) >>> 0;
        }
        return { stamp: null, rounds: maxRounds };
    }

    const api = { sha256, search, hexToBytes, bytesToHex };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;

    // Worker side: {material, target, size} -> progress {rounds} ... then {stamp}
    if (typeof WorkerGlobalScope !== 'undefined' && root instanceof WorkerGlobalScope) {
        root.onmessage = (ev) => {
            const m = ev.data || {};
            const material = hexToBytes(m.material), target = hexToBytes(m.target);
            const size = m.size || 14, chunk = 200000;
            const start = new Uint8Array(size);
            for (;;) {
                crypto.getRandomValues(start);
                const res = search(material, target, start, chunk);
                if (res.stamp) { root.postMessage({ stamp: bytesToHex(res.stamp), rounds: res.rounds }); return; }
                root.postMessage({ rounds: chunk });
            }
        };
    }
})(typeof self !== 'undefined' ? self : this);
