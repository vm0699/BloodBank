'use strict';
// Aadhaar number format check (12 digits, first digit 2-9, Verhoeff check digit). Format only: it does not prove who the person is.
const D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
const verhoeff = n => { let c = 0; String(n).split('').reverse().forEach((d, i) => { c = D[c][P[i % 8][+d]]; }); return c === 0; };
const valid = n => /^[2-9]\d{11}$/.test(String(n)) && verhoeff(n);
// helper for tests / tooling: append the check digit to an 11-digit prefix
const withCheck = p11 => { for (let k = 0; k < 10; k++) if (verhoeff(p11 + k)) return p11 + k; return null; };
module.exports = { valid, verhoeff, withCheck };
