/*
 * 中国电信小组件（Egern 版，单文件双模式）
 * 移植自 Scriptable 版 ChinaTelecom_2024（作者 2Ya&脑瓜）
 *
 * 同一个文件，两种用法（在 Egern 里建两个脚本条目，脚本 URL 填同一个）：
 *   1. generic 类型 → iOS 小组件：显示剩余话费 / 剩余（或已用）流量 / 剩余语音
 *   2. request 类型 → 登录捕获：Safari 里登录 e.dlife.cn 成功时自动捕获登录地址，
 *      存入存储，小组件下次运行自动读取登录，全程无需手动复制粘贴。
 *
 * 环境变量（在模块/小组件的 Env 中配置）：
 *   CT_LOGIN_URL            电信登录地址（抓包得到的登录 URL，用于自动更新 cookie）
 *   CT_COOKIE               直接填写 cookie（与 CT_LOGIN_URL 二选一，URL 优先）
 *   CT_SHOW_USED_FLOW       'true' 显示已用流量，否则显示剩余流量

 *   CT_SHOW_DIRECT          'false' 隐藏定向卡（3卡模式）；'true' 强制4卡；不填则自动判断
 *   CT_TITLE                小组件标题，默认 "中国电信"
 *
 * 数据来源：https://e.dlife.cn/user/package_detail.do + balance.do（cookie/MITM 捕获）
 */

const URLS = {
  login: 'https://e.dlife.cn/index.do',
  detail: 'https://e.dlife.cn/user/package_detail.do',
  balance: 'https://e.dlife.cn/user/balance.do',
};


/* ================= App 登录链（服务密码→ticket→统一登录） ================= */
// 与 china-telecom-app.js 独立模块同源；App 优先，失败回退 cookie
/*
 * 中国电信 App 登录版（Egern 独立模块）
 * 移植自 gumson 的 Scripting 版（api/loginchain.ts + api/appdata.ts + 加密模块）
 * 登录链按 36523_dx_auto.py 的 login_v2 实现：AndroidID 版
 *   ① 服务密码登录 → ② 换 ticket → ③ wapact 统一登录
 *
 * 环境变量：
 *   CT_APP_PHONE       手机号（11 位）
 *   CT_APP_PASSWORD    电信服务密码
 *   CT_APP_ANDROID_ID  AndroidID（16 位十六进制，从辅助网站短信登录获取）
 *   CT_SHOW_USED_FLOW  'true' 显示已用流量，否则显示剩余
 *   CT_TITLE           小组件标题，默认 "中国电信"
 *
 * 注意：App 接口不返回定向流量细分，走此通道时小组件为 3 卡（话费/通用/语音）。
 * token 存 storage，失效自动重登。
 */

/* ================= 工具函数 ================= */

function cdtCaesar2(s) {
  return [...String(s)].map((c) => String.fromCharCode((c.charCodeAt(0) + 2) & 0xffff)).join('');
}

function cdtTs14(d) {
  d = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function cdtHexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function cdtBytesToHex(b) {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function cdtUtf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}

const CDT_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function cdtBase64Encode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += CDT_B64[b0 >> 2] + CDT_B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? CDT_B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? CDT_B64[b2 & 63] : '=';
  }
  return out;
}

/* ================= RSA（PKCS#1 v1.5） ================= */

const CDT_RSA_N_HEX =
  'c190b4f5e53855833ebf34e97ab3c18d3e87dd5b359b0a45a791a026eced8b8e43351fb74cbf3922a9dc54d368da9864472d7fd934c0971e73dc5bfb0386214204dd7ca85bf2f20e9561bf50b6ba08d3d7b5efab3e642b62bfb85b8a7d9c0938fdf625299c4968666d7d9701f2a3af6ee543223cca6ad3f5ca04ef2562137f83';
const CDT_RSA_E = 65537n;
const CDT_RSA_N = BigInt('0x' + CDT_RSA_N_HEX);
const CDT_RSA_KEY_BYTES = 128;

function cdtModPow(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

function cdtBigintToBytes(v, len) {
  const out = new Uint8Array(len);
  let x = v;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** PKCS#1 v1.5 加密，返回 base64 */
function cdtRsaEncryptPkcs1(msg) {
  const m = cdtUtf8Bytes(msg);
  if (m.length > CDT_RSA_KEY_BYTES - 11) throw new Error('RSA 明文过长');
  const psLen = CDT_RSA_KEY_BYTES - 3 - m.length;
  const block = new Uint8Array(CDT_RSA_KEY_BYTES);
  block[0] = 0x00;
  block[1] = 0x02;
  for (let i = 0; i < psLen; i++) {
    let b = 0;
    while (b === 0) b = Math.floor(Math.random() * 256);
    block[2 + i] = b;
  }
  block[2 + psLen] = 0x00;
  block.set(m, 3 + psLen);
  let v = 0n;
  for (const b of block) v = (v << 8n) | BigInt(b);
  const c = cdtModPow(v, CDT_RSA_E, CDT_RSA_N);
  const cBytes = cdtBigintToBytes(c, CDT_RSA_KEY_BYTES);
  let bin = '';
  for (const b of cBytes) bin += String.fromCharCode(b);
  // Egern 无 btoa，手动 base64
  return cdtBase64Encode(cBytes);
}

/* ================= TripleDES-CBC ================= */

const CDT_DES_IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
  62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];
const CDT_DES_FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
  38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
  34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
];
const CDT_DES_E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9,
  8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
  16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25,
  24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
];
const CDT_DES_P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
  2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
];
const CDT_DES_PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18,
  10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
  63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22,
  14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4,
];
const CDT_DES_PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10,
  23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
  41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48,
  44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];
const CDT_DES_ROT = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const CDT_DES_SBOX = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];

function cdtDesBytesToBits(b) {
  const out = [];
  for (const byte of b) for (let i = 7; i >= 0; i--) out.push((byte >> i) & 1);
  return out;
}
function cdtDesBitsToBytes(bits) {
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j];
    out[i] = v;
  }
  return out;
}
function cdtDesPerm(bits, table) { return table.map((p) => bits[p - 1]); }
function cdtDesXor(a, b) { return a.map((v, i) => v ^ b[i]); }
function cdtDesRotL(bits, n) { return bits.slice(n).concat(bits.slice(0, n)); }

function cdtDesKeySchedule(key8) {
  const k56 = cdtDesPerm(cdtDesBytesToBits(key8), CDT_DES_PC1);
  let c = k56.slice(0, 28), d = k56.slice(28);
  const subs = [];
  for (let i = 0; i < 16; i++) {
    c = cdtDesRotL(c, CDT_DES_ROT[i]);
    d = cdtDesRotL(d, CDT_DES_ROT[i]);
    subs.push(cdtDesPerm(c.concat(d), CDT_DES_PC2));
  }
  return subs;
}

function cdtDesFeistel(r32, sub) {
  const e48 = cdtDesPerm(r32, CDT_DES_E);
  const x = cdtDesXor(e48, sub);
  const s32 = [];
  for (let s = 0; s < 8; s++) {
    const chunk = x.slice(s * 6, s * 6 + 6);
    const row = (chunk[0] << 1) | chunk[5];
    const col = (chunk[1] << 3) | (chunk[2] << 2) | (chunk[3] << 1) | chunk[4];
    const v = CDT_DES_SBOX[s][row * 16 + col];
    for (let i = 3; i >= 0; i--) s32.push((v >> i) & 1);
  }
  return cdtDesPerm(s32, CDT_DES_P);
}

function cdtDesBlock(block8, subs, decrypt) {
  const ip = cdtDesPerm(cdtDesBytesToBits(block8), CDT_DES_IP);
  let l = ip.slice(0, 32), r = ip.slice(32);
  for (let i = 0; i < 16; i++) {
    const sub = decrypt ? subs[15 - i] : subs[i];
    const nl = r, nr = cdtDesXor(l, cdtDesFeistel(r, sub));
    l = nl; r = nr;
  }
  return cdtDesBitsToBytes(cdtDesPerm(r.concat(l), CDT_DES_FP));
}

/** TripleDES-CBC。key24: 24 字节；iv8: 8 字节；encrypt: true=加密/false=解密。PKCS7 填充。 */
function cdtTripleDesCbc(data, key24, iv8, encrypt) {
  const k1 = cdtDesKeySchedule(key24.slice(0, 8));
  const k2 = cdtDesKeySchedule(key24.slice(8, 16));
  const k3 = cdtDesKeySchedule(key24.slice(16, 24));
  const single = (blk, ks, dec) => cdtDesBlock(blk, ks, dec);
  const ede = (blk, dec) => dec
    ? single(single(single(blk, k3, true), k2, false), k1, true)
    : single(single(single(blk, k1, false), k2, true), k3, false);
  let input;
  if (encrypt) {
    const pad = 8 - (data.length % 8);
    input = new Uint8Array(data.length + pad);
    input.set(data);
    input.fill(pad, data.length);
  } else {
    input = data;
  }
  const out = new Uint8Array(input.length);
  let prev = iv8;
  for (let off = 0; off < input.length; off += 8) {
    const blk = input.slice(off, off + 8);
    if (encrypt) {
      const x = new Uint8Array(8);
      for (let i = 0; i < 8; i++) x[i] = blk[i] ^ prev[i];
      const c = ede(x, false);
      out.set(c, off);
      prev = c;
    } else {
      const p = ede(blk, true);
      for (let i = 0; i < 8; i++) out[off + i] = p[i] ^ prev[i];
      prev = blk;
    }
  }
  if (!encrypt) {
    const pad = out[out.length - 1];
    if (pad < 1 || pad > 8) throw new Error('3DES 解密填充错误');
    return out.slice(0, out.length - pad);
  }
  return out;
}

/* ================= AES-128-ECB（PKCS7） ================= */

const CDT_AES_SBOX = [
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
];
const CDT_AES_RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

function cdtAesXtime(a) { return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff; }

function cdtAesExpandKey(key) {
  const ek = new Uint8Array(176);
  ek.set(key);
  for (let i = 16; i < 176; i += 4) {
    let t0 = ek[i - 4], t1 = ek[i - 3], t2 = ek[i - 2], t3 = ek[i - 1];
    if (i % 16 === 0) {
      const u = CDT_AES_SBOX[t1];
      t1 = CDT_AES_SBOX[t2]; t2 = CDT_AES_SBOX[t3]; t3 = CDT_AES_SBOX[t0];
      t0 = u ^ CDT_AES_RCON[i / 16 - 1];
    }
    ek[i] = ek[i - 16] ^ t0; ek[i + 1] = ek[i - 15] ^ t1;
    ek[i + 2] = ek[i - 14] ^ t2; ek[i + 3] = ek[i - 13] ^ t3;
  }
  return ek;
}

function cdtAesEncryptBlock(block, ek) {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = block[i] ^ ek[i];
  for (let round = 1; round <= 10; round++) {
    for (let i = 0; i < 16; i++) s[i] = CDT_AES_SBOX[s[i]];
    let t;
    t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
    t = s[2]; s[2] = s[10]; s[10] = t;
    t = s[6]; s[6] = s[14]; s[14] = t;
    t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t;
    if (round < 10) {
      for (let c = 0; c < 4; c++) {
        const i = c * 4;
        const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
        const b0 = cdtAesXtime(a0), b1 = cdtAesXtime(a1), b2 = cdtAesXtime(a2), b3 = cdtAesXtime(a3);
        s[i] = b0 ^ a1 ^ b1 ^ a2 ^ a3;
        s[i + 1] = a0 ^ b1 ^ a2 ^ b2 ^ a3;
        s[i + 2] = a0 ^ a1 ^ b2 ^ a3 ^ b3;
        s[i + 3] = a0 ^ b0 ^ a1 ^ a2 ^ b3;
      }
    }
    const off = round * 16;
    for (let i = 0; i < 16; i++) s[i] ^= ek[off + i];
  }
  return s;
}

/** AES-128-ECB + PKCS7，返回 base64 */
function cdtAes128EcbPkcs7Base64(plaintext, keyStr) {
  const key = cdtUtf8Bytes(keyStr);
  if (key.length !== 16) throw new Error('AES-128 需要 16 字节 key');
  const ek = cdtAesExpandKey(key);
  const pt = cdtUtf8Bytes(plaintext);
  const padLen = 16 - (pt.length % 16);
  const data = new Uint8Array(pt.length + padLen);
  data.set(pt);
  data.fill(padLen, pt.length);
  const out = new Uint8Array(data.length);
  for (let off = 0; off < data.length; off += 16) {
    out.set(cdtAesEncryptBlock(data.subarray(off, off + 16), ek), off);
  }
  return cdtBase64Encode(out);
}

/* ================= App 登录链 ================= */
// ① 服务密码登录 → ② 换 ticket → ③ wapact 统一登录拿 Bearer

const CDT_LOGIN_UA = 'Mozilla/5.0 (Linux; U; Android 12; zh-cn) AppleWebKit/533.1 (KHTML, like Gecko) Version/5.0 Mobile Safari/533.1';
const CDT_DES3_KEY_STR = '1234567`90koiuyhgtfrdews'; // 注意 key 里有个反引号
const CDT_AES_LOGIN_KEY = 'telecom_wap_2018';
const CDT_APP_CLIENT_TYPE = '#11.0.0#channel8#Xiaomi 20#';
const CDT_APPFUWU_UA = 'P216010901';

/** 3001/3006 等业务码的人话解释 */
function cdtExplainCode(rc) {
  if (rc === '3001') return '（手机号或密码有误；若确认无误，可能是账号被临时锁定，请等 1-2 小时再试）';
  if (rc === '3006') return '（服务端风控拒绝；可能是设备指纹异常或账号被锁定，请等 1-2 小时再试）';
  return '';
}

async function cdtHttpJson(ctx, url, body, contentType) {
  const resp = await ctx.http.post(url, {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: {
      'Content-Type': contentType || 'application/json',
      'User-Agent': CDT_LOGIN_UA,
    },
    timeout: 30000,
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: resp.status, text, json };
}

/** 跑完整登录链。返回 {steps, userId, token, ticket, uid, bearer} */
async function cdtRunLoginChain(ctx, phoneInput, passwdInput, androidIdInput) {
  const steps = [];
  const fail = (msg) => { steps.push({ ok: false, msg }); return { steps }; };

  const phone = String(phoneInput || '').trim();
  const passwd = String(passwdInput || '').trim();
  const androidId = String(androidIdInput || '').trim().toLowerCase();
  if (!/^1\d{10}$/.test(phone)) return fail('① 手机号格式不对，应为 11 位数字');
  if (!passwd) return fail('① 服务密码不能为空');
  if (!/^[0-9a-f]{16}$/.test(androidId)) return fail('① AndroidID 格式不对，应为 16 位十六进制字符');

  // ---------- ① 服务密码登录 ----------
  const t = cdtTs14();
  const plain = `Xiaomi 20 8.0.0.${androidId.slice(0, 12)}${phone}${t}${passwd}0$$$0.`;
  let cipherB64;
  try {
    cipherB64 = cdtRsaEncryptPkcs1(plain);
  } catch (e) {
    return fail(`① RSA 加密失败: ${e && e.message}`);
  }
  const body1 = {
    headerInfos: {
      code: 'userLoginNormal',
      timestamp: t,
      broadAccount: '',
      broadToken: '',
      clientType: CDT_APP_CLIENT_TYPE,
      shopId: '20002',
      source: '110003',
      sourcePassword: 'Sid98s',
      userLoginName: cdtCaesar2(phone),
    },
    content: {
      attach: 'test',
      fieldData: {
        loginType: '4',
        accountType: '',
        loginAuthCipherAsymmertric: cipherB64,
        deviceUid: '',
        phoneNum: cdtCaesar2(phone),
        isChinatelecom: '',
        systemVersion: '8.0.0',
        androidId: cdtCaesar2(androidId),
        loginAuthCipher: '',
        authentication: cdtCaesar2(passwd),
      },
    },
  };
  let r1;
  try {
    r1 = await cdtHttpJson(ctx, 'https://appgologin.189.cn:9031/login/client/userLoginNormal', body1);
  } catch (e) {
    return fail(`① 登录请求网络异常: ${e && e.message}`);
  }
  const respData = (r1.json && r1.json.responseData) || {};
  const rc1 = String(respData.resultCode || '');
  if (rc1 !== '0000') {
    const failDetail = respData && respData.data && respData.data.loginFailResult;
    const failJson = failDetail ? JSON.stringify(failDetail) : '';
    const msg = (r1.json && r1.json.msg) || respData.resultDetail || respData.resultDesc || '';
    return fail(`① 登录失败 resultCode=${rc1} ${msg}${cdtExplainCode(rc1)}`);
  }
  const loginData = respData.data.loginSuccessResult;
  const userId = loginData.userId, token = loginData.token;
  steps.push({ ok: true, msg: `① 登录成功 userId=${userId}` });

  // ---------- ② 换 ticket ----------
  const des3key = cdtUtf8Bytes(CDT_DES3_KEY_STR);
  const iv8 = new Uint8Array(8);
  let targetIdHex;
  try {
    targetIdHex = cdtBytesToHex(cdtTripleDesCbc(cdtUtf8Bytes(String(userId)), des3key, iv8, true));
  } catch (e) {
    return fail(`② 3DES 加密失败: ${e && e.message}`);
  }
  const xml =
`<Request>
    <HeaderInfos>
        <Code>getSingle</Code>
        <Timestamp>${t}</Timestamp>
        <BroadAccount></BroadAccount>
        <BroadToken></BroadToken>
        <ClientType>#9.6.1#channel50#iPhone 14 Pro Max#</ClientType>
        <ShopId>20002</ShopId>
        <Source>110003</Source>
        <SourcePassword>Sid98s</SourcePassword>
        <Token>${token}</Token>
        <UserLoginName>${phone}</UserLoginName>
    </HeaderInfos>
    <Content>
        <Attach>test</Attach>
        <FieldData>
            <TargetId>${targetIdHex}</TargetId>
            <Url>4a6862274835b451</Url>
        </FieldData>
    </Content>
</Request>`;
  let r2;
  try {
    r2 = await cdtHttpJson(ctx, 'https://appgologin.189.cn:9031/map/clientXML', xml, 'application/xml');
  } catch (e) {
    return fail(`② 换 ticket 请求网络异常: ${e && e.message}`);
  }
  if (typeof r2.text !== 'string' || !r2.text.includes('<Ticket>')) {
    return fail('② 未取到 Ticket');
  }
  let ticketHex, uid;
  try {
    ticketHex = r2.text.split('<Ticket>')[1].split('</Ticket>')[0];
    const dec = cdtTripleDesCbc(cdtHexToBytes(ticketHex), des3key, iv8, false);
    uid = String.fromCharCode(...dec);
  } catch (e) {
    return fail(`② Ticket 解密失败: ${e && e.message}`);
  }
  if (!uid) return fail('② Ticket 解密结果为空');
  steps.push({ ok: true, msg: '② 拿到 ticket' });

  // ---------- ③ wapact 统一登录拿 Bearer ----------
  const authPlain = JSON.stringify({
    ticket: uid,
    backUrl: 'https%3A%2F%2Fwapact.189.cn%3A9001',
    platformCode: 'P201010301',
    loginType: 2,
  });
  let authBody;
  try {
    authBody = cdtAes128EcbPkcs7Base64(authPlain, CDT_AES_LOGIN_KEY);
  } catch (e) {
    return fail(`③ AES 加密失败: ${e && e.message}`);
  }
  let r3;
  try {
    r3 = await cdtHttpJson(ctx, 'https://wapact.189.cn:9001/unified/user/login', authBody);
  } catch (e) {
    return fail(`③ 统一登录请求网络异常: ${e && e.message}`);
  }
  let bearer = '';
  if (r3.json && r3.json.code === 0 && r3.json.biz && r3.json.biz.token) {
    bearer = `Bearer ${r3.json.biz.token}`;
    steps.push({ ok: true, msg: '③ 统一登录成功，拿到 Bearer' });
  } else {
    steps.push({ ok: false, msg: `③ 统一登录未拿到 Bearer (code=${r3.json && r3.json.code})，但前两步已通` });
  }
  return { steps, userId: String(userId), token: String(token), ticket: ticketHex, uid, bearer };
}

/* ================= App 接口查数据 ================= */

function cdtTsMin(d) {
  d = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}00`;
}

/** 用 App token 查主要数据 */
async function cdtFetchImportantData(ctx, token, phone) {
  const t = cdtTsMin();
  const encPhone = cdtCaesar2(phone);
  const body = {
    content: {
      fieldData: {
        provinceCode: '600101',
        cityCode: '8441900',
        shopId: '20002',
        isChinatelecom: '0',
        account: encPhone,
      },
      attach: 'test',
    },
    headerInfos: {
      code: 'userFluxPackage',
      clientType: CDT_APP_CLIENT_TYPE,
      timestamp: t,
      shopId: '20002',
      source: '110003',
      sourcePassword: 'Sid98s',
      userLoginName: encPhone,
      token,
    },
  };
  const resp = await ctx.http.post('https://appfuwu.189.cn:9021/query/qryImportantData', {
    body: JSON.stringify(body),
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json; charset=UTF-8',
      'user-agent': CDT_APPFUWU_UA,
    },
    timeout: 30000,
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  const rd = json && json.responseData;
  if (!rd || rd.resultCode !== '0000') {
    throw new Error(`resultCode=${rd && rd.resultCode} | ${text.slice(0, 200)}`);
  }
  const d = rd.data;
  const num = (v) => { const n = parseInt(String(v ?? '0'), 10); return isNaN(n) ? 0 : n; };
  const total = (d && d.flowInfo && d.flowInfo.totalAmount) || {};
  const common = (d && d.flowInfo && d.flowInfo.commonFlow) || {};
  const special = (d && d.flowInfo && d.flowInfo.specialAmount) || {};
  const voice = (d && d.voiceInfo && d.voiceInfo.voiceDataInfo) || {};
  const balStr = (d && d.balanceInfo && d.balanceInfo.indexBalanceDataInfo && d.balanceInfo.indexBalanceDataInfo.balance) ?? '0';
  return {
    balanceFen: Math.round(parseFloat(String(balStr)) * 100) || 0,
    voiceUsed: num(voice.used),
    voiceBalance: num(voice.balance),
    voiceTotal: num(voice.total),
    flowUsedKB: num(total.used),
    flowBalanceKB: num(total.balance),
    commonUsedKB: num(common.used),
    commonBalanceKB: num(common.balance),
    specialUsedKB: num(special.used),
    specialBalanceKB: num(special.balance),
  };
}

/* ---------- 工具函数 ---------- */

function formatFlow(flow) {
  const remain = flow / 1024; // 接口单位换算：与原版保持一致
  if (remain < 1024) return { amount: remain.toFixed(2), unit: 'MB' };
  return { amount: (remain / 1024).toFixed(2), unit: 'GB' };
}

function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/* ---------- 数据层 ---------- */

async function refreshCookie(ctx) {
  // 登录地址来源：Env 的 CT_LOGIN_URL 优先，其次用捕获脚本存下的地址
  const loginUrl =
    (ctx.env.CT_LOGIN_URL || '').trim() || ctx.storage.get('ct_login_url') || '';
  if (!loginUrl) return ctx.storage.get('ct_cookie') || '';
  const url = (loginUrl.match(/(http.+)&sign/) || [])[1] || loginUrl;
  const resp = await ctx.http.get(url, {
    redirect: 'manual',
    timeout: 15000,
    credentials: 'omit',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    },
  });
  const setCookies = (resp.headers && resp.headers.getAll('set-cookie')) || [];
  const pairs = setCookies
    .map((c) => String(c).split(';')[0].trim())
    .filter(Boolean);
  if (pairs.length > 0) {
    // 合并而非覆盖：回放可能只返回部分 cookie，丢掉原有的反而坏事
    const merged = mergeCookies(ctx.storage.get('ct_cookie'), pairs.join('; '));
    if (merged) ctx.storage.set('ct_cookie', merged);
  }
  return ctx.storage.get('ct_cookie') || '';
}

function mergeCookies(oldCookie, newPairs) {
  const map = new Map();
  for (const p of String(oldCookie || '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0) map.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
  }
  for (const p of String(newPairs || '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0) map.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join('; ');
}

function harvestSetCookie(ctx, resp, cookie) {
  // 滑动续期：API 成功返回时若带了 Set-Cookie，合并进存储（同名覆盖）
  try {
    const setCookies = (resp.headers && resp.headers.getAll('set-cookie')) || [];
    const pairs = setCookies
      .map((c) => String(c).split(';')[0].trim())
      .filter(Boolean);
    if (pairs.length > 0) {
      const merged = mergeCookies(cookie, pairs.join('; '));
      if (merged && merged !== cookie) ctx.storage.set('ct_cookie', merged);
      return merged || cookie;
    }
  } catch (e) {}
  return cookie;
}

async function fetchJson(ctx, url, cookie) {
  const resp = await ctx.http.get(url, {
    headers: {
      Cookie: cookie,
      // 伪装成 iOS Safari，避免服务端因 UA 不一致踢掉 session
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    },
    timeout: 15000,
    credentials: 'omit',
  });
  if (!resp || resp.status !== 200) {
    const err = new Error(`HTTP ${resp ? resp.status : 'no-response'}: ${url}`);
    // 401/403 基本可以确定是登录态没了
    if (resp && (resp.status === 401 || resp.status === 403)) err.authDead = true;
    throw err;
  }
  let data;
  try {
    data = await resp.json();
  } catch (_) {
    // 正常应返回 JSON，拿到 HTML（多半是被踢回登录页）→ 登录失效
    const err = new Error(`登录失效（接口未返回 JSON）：${url}`);
    err.authDead = true;
    throw err;
  }
  harvestSetCookie(ctx, resp, cookie);
  return data;
}

// 解析套餐详情 + 余额，逻辑与原 Scriptable 版保持一致
function parseTelecom(detail, balance, opts) {
  let genTotal = 0, genBalance = 0, genUsed = 0;
  let dirTotal = 0, dirBalance = 0, dirUsed = 0;
  let totalVoiceAmount = 0;
  let totalBalanceVoiceAmount = 0;
  let isUnlimitedFlow = false;

  for (const data of detail?.items || []) {
    if (data.offerType === 19) continue;
    for (const item of data.items || []) {
      if (item.unitTypeId == 3) {
        const isDirectional = /定向/.test(item.ratableResourcename || '');
        const isInvalid = item.balanceAmount == '999999999999';
        if (!(item.usageAmount == 0 && item.balanceAmount == 0) && !isInvalid) {
          const t = parseFloat(item.ratableAmount) || 0;
          const b = parseFloat(item.balanceAmount) || 0;
          if (isDirectional) { dirTotal += t; dirBalance += b; }
          else { genTotal += t; genBalance += b; }
        }
        const u = parseFloat(item.usageAmount) || 0;
        if (isDirectional) dirUsed += u; else genUsed += u;
        if (data.offerType == 21 && item.ratableAmount == '0') {
          isUnlimitedFlow = true;
        }
      } else if (!detail.voiceBalance && item.unitTypeId == 1) {
        totalVoiceAmount += parseInt(item.ratableAmount, 10) || 0;
        totalBalanceVoiceAmount += parseInt(item.balanceAmount, 10) || 0;
      }
    }
  }
  if (detail.voiceAmount && detail.voiceBalance) {
    totalVoiceAmount = detail.voiceAmount;
    totalBalanceVoiceAmount = detail.voiceBalance;
  }

  const feeNum = Number(balance?.totalBalanceAvailable);
  return buildDs({
    feeFen: Number.isFinite(feeNum) ? feeNum : 0,
    genTotal, genBalance, genUsed,
    dirTotal, dirBalance, dirUsed,
    voiceTotal: totalVoiceAmount, voiceBalance: totalBalanceVoiceAmount,
    isUnlimitedFlow,
  }, opts);
}

// 统一 ds 构建：m = {feeFen(分), genTotal/Balance/Used(KB), dirTotal/Balance/Used(KB),
//                    voiceTotal/Balance(分钟), isUnlimitedFlow}
function buildDs(m, opts) {
  const { showUsedFlow } = opts || {};
  const mkFlow = (remainTitle, total, balanceAmt, usedAmt) => {
    const bal = formatFlow(balanceAmt);
    const used = formatFlow(usedAmt);
    const f = {
      title: remainTitle,
      number: bal.amount,
      unit: bal.unit,
      percent: +(((balanceAmt / (total || 1)) * 100).toFixed(2)),
    };
    if (showUsedFlow) {
      f.title = remainTitle.replace('剩余', '已用');
      f.number = used.amount;
      f.unit = used.unit;
    }
    return f;
  };

  const generalFlow = mkFlow('通用剩余', m.genTotal, m.genBalance, m.genUsed);
  generalFlow.color = GENERAL_ICON_COLOR;
  if (m.isUnlimitedFlow) {
    const used = formatFlow(m.genUsed);
    generalFlow.title = '通用已用';
    generalFlow.number = used.amount;
    generalFlow.unit = used.unit;
  }
  const directFlow = mkFlow('定向剩余', m.dirTotal, m.dirBalance, m.dirUsed);
  directFlow.color = DIRECT_ICON_COLOR;

  const voiceUsed = Math.max(0, m.voiceTotal - m.voiceBalance);
  const voice = {
    title: showUsedFlow ? '语音已用' : '语音剩余',
    number: `${showUsedFlow ? voiceUsed : m.voiceBalance}`,
    unit: '分钟',
    percent: +(((m.voiceBalance / (m.voiceTotal || 1)) * 100).toFixed(2)),
    color: VOICE_ICON_COLOR,
  };

  const fee = {
    title: '话费余额',
    number: (m.feeFen / 100).toFixed(2),
    unit: '元',
  };

  return { fee, generalFlow, directFlow, voice, updatedAt: Date.now(), hasDirectFlow: (m.dirTotal + m.dirBalance + m.dirUsed) > 0 };
}



// App 数据 → buildDs 模型（App 接口无定向细分，走此通道为 3 卡）
function cdtAppDataToDs(apiData, settings) {
  const m = {
    feeFen: apiData.balanceFen || 0,
    genTotal: (apiData.commonUsedKB || 0) + (apiData.commonBalanceKB || 0),
    genBalance: apiData.commonBalanceKB || 0,
    genUsed: apiData.commonUsedKB || 0,
    dirTotal: (apiData.specialUsedKB || 0) + (apiData.specialBalanceKB || 0),
    dirBalance: apiData.specialBalanceKB || 0,
    dirUsed: apiData.specialUsedKB || 0,
    voiceTotal: apiData.voiceTotal || 0,
    voiceBalance: apiData.voiceBalance || 0,
    isUnlimitedFlow: false,
  };
  return buildDs(m, settings);
}

async function tryAppApi(ctx, settings) {
  const phone = (ctx.env.CT_APP_PHONE || '').trim();
  const passwd = ctx.env.CT_APP_PASSWORD || '';
  const androidId = (ctx.env.CT_APP_ANDROID_ID || '').trim();
  // 先试缓存 token
  let token = ctx.storage.get('ct_app_token') || '';
  let apiData = null;
  if (token) {
    try {
      apiData = await cdtFetchImportantData(ctx, token, phone);
    } catch (e) {
      token = '';
    }
  }
  if (!apiData) {
    const r = await cdtRunLoginChain(ctx, phone, passwd, androidId);
    const allOk = r.steps.length >= 2 && r.steps.every((s) => s.ok);
    if (!allOk || !r.token) {
      const msg = r.steps.filter((s) => !s.ok).map((s) => s.msg).join('; ') || '登录失败';
      throw new Error(msg.slice(0, 100));
    }
    ctx.storage.set('ct_app_token', r.token);
    apiData = await cdtFetchImportantData(ctx, r.token, phone);
  }
  const ds = cdtAppDataToDs(apiData, settings);
  ds.updatedAt = Date.now();
  ds.source = 'app';
  ctx.storage.setJSON('ct_app_datasource', ds);
  return ds;
}

async function tryCookie(ctx, cookie, settings) {
  const detail = await fetchJson(ctx, URLS.detail, cookie);
  const balance = await fetchJson(ctx, URLS.balance, cookie);
  const ds = parseTelecom(detail, balance, settings);
  // balance.do 偶发返回空/异常时，用上次缓存的话费顶住，避免误显示 0.00
  const feeRaw = balance?.totalBalanceAvailable;
  if (feeRaw === undefined || feeRaw === null || feeRaw === '') {
    const cached = ctx.storage.getJSON('ct_datasource');
    if (cached?.fee?.number) ds.fee = cached.fee;
  }
  ds.source = 'cookie';
  ctx.storage.setJSON('ct_datasource', ds);
  // 多存一份原始接口数据：缓存兜底时按当前 Env 设置重新解析，避免旧缓存里的标题/数值跟新设置对不上
  try {
    ctx.storage.setJSON('ct_raw', { detail, balance, at: ds.updatedAt || Date.now() });
  } catch (_) {}
  return ds;
}

async function loadData(ctx) {
  const envCookie = (ctx.env.CT_COOKIE || '').trim();
  const loginUrl =
    (ctx.env.CT_LOGIN_URL || '').trim() || ctx.storage.get('ct_login_url') || '';
  const settings = {
    showUsedFlow: String(ctx.env.CT_SHOW_USED_FLOW || '').toLowerCase() === 'true',
  };
  // 0) App 登录链优先（配了手机号+密码+AndroidID 才走）
  const appConfigured = !!((ctx.env.CT_APP_PHONE || '').trim() && ctx.env.CT_APP_PASSWORD && (ctx.env.CT_APP_ANDROID_ID || '').trim());
  if (appConfigured) {
    try {
      const ds = await tryAppApi(ctx, settings);
      return { configured: true, ds, fromCache: false };
    } catch (e) {
      /* App 失败，掉到 cookie 兜底 */
    }
  }
  const storedCookie = ctx.storage.get('ct_cookie') || '';
  // 只要配了登录地址/cookie，或之前抓到过 cookie，就视为"已配置"
  const configured = !!(envCookie || loginUrl || storedCookie);

  // 1) 优先用已捕获的 cookie（从登录后的真实请求里抓的，最可靠）
  const firstCookie = envCookie || storedCookie;
  let cookieDead = false;
  if (firstCookie) {
    try {
      const ds = await tryCookie(ctx, firstCookie, settings);
      return { configured, ds, fromCache: false };
    } catch (e) {
      if (e && e.authDead) cookieDead = true; // 登录失效，继续往下走
    }
  }

  // 2) 回放登录地址刷新 cookie（备用方式）
  if (!envCookie && loginUrl) {
    try {
      const fresh = await refreshCookie(ctx);
      if (fresh && fresh !== firstCookie) {
        const ds = await tryCookie(ctx, fresh, settings);
        return { configured, ds, fromCache: false };
      }
    } catch (e) {
      if (e && e.authDead) cookieDead = true;
    }
  }

  // 3) 断网/过期时用缓存顶一下：有原始数据就按当前设置重新解析一次
  const raw = ctx.storage.getJSON('ct_raw');
  if (raw && raw.detail) {
    try {
      const ds = parseTelecom(raw.detail, raw.balance, settings);
      ds.updatedAt = raw.at || ds.updatedAt;
      return { configured, ds, fromCache: true, cookieDead };
    } catch (_) {
      /* 解析失败就掉到旧缓存 */
    }
  }
  const cached = ctx.storage.getJSON('ct_datasource');
  return { configured, ds: cached || null, fromCache: !!cached, cookieDead };
}

/* ---------- 渲染层（Widget DSL）· v23 iOS 液态玻璃仪表盘风格 ---------- */

const C_FEE = '#FF9F0A';
const C_FLOW = '#0A84FF';
const C_OTHER = '#64D2FF';
const C_VOICE = '#30D158';
const WARN = '#FF453A';
const TXT = { light: '#000000', dark: '#FFFFFF' };
const SUB = { light: '#3C3C4399', dark: '#EBEBF599' };
const GLASS = { light: '#FFFFFFA6', dark: '#FFFFFF1A' };

const FEE_ICON = 'yensign.circle.fill';
const FEE_ICON_COLOR = C_FEE;
const GENERAL_ICON = 'wifi';
const GENERAL_ICON_COLOR = C_FLOW;
const DIRECT_ICON = 'globe.asia.australia.fill';
const DIRECT_ICON_COLOR = C_OTHER;
const VOICE_ICON = 'phone.fill';
const VOICE_ICON_COLOR = C_VOICE;

function bg() {
  return {
    type: 'linear',
    colors: [
      { light: '#EAF3FF', dark: '#0B1A33' },
      { light: '#F4F0FF', dark: '#120B24' },
      { light: '#E9FBF3', dark: '#03140F' },
    ],
    stops: [0, 0.55, 1],
    startPoint: { x: 0, y: 0 },
    endPoint: { x: 1, y: 1 },
  };
}

function normPct(p) {
  const n = Number(p) || 0;
  return Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
}

function toMB(d) {
  const n = parseFloat(d && d.number);
  if (!Number.isFinite(n)) return null;
  return d.unit === 'GB' ? n * 1024 : n;
}

function fmtMB(mb) {
  if (mb == null || !Number.isFinite(mb)) return '--';
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(0)} MB`;
}

// 开关2：CT_SHOW_DIRECT=false → 3卡模式（隐藏定向）；=true → 强制4卡；不填 → 有定向数据才显示
function showDirectCard(ctx, ds) {
  const v = String(ctx?.env?.CT_SHOW_DIRECT || '').toLowerCase();
  if (v === 'false') return false;
  if (v === 'true') return true;
  return !!ds.hasDirectFlow;
}

function insights(ctx, ds) {
  const now = new Date();
  const dayKey = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft = Math.max(1, dim - now.getDate() + 1);
  const showUsed = String(ctx?.env?.CT_SHOW_USED_FLOW || '').toLowerCase() === 'true';
  const showDir = showDirectCard(ctx, ds);

  const _g = toMB(ds.generalFlow);
  const _o = showDir ? toMB(ds.directFlow) : 0;
  const flowMB = showUsed ? null : _g == null && !_o ? null : (_g || 0) + (_o || 0);

  let todayMB = null;
  if (flowMB != null) {
    let snap = null;
    try {
      snap = ctx.storage.getJSON('ct_day_snap');
    } catch (e) {}
    if (!snap || snap.date !== dayKey || flowMB > snap.start + 1) {
      snap = { date: dayKey, start: flowMB };
      try {
        ctx.storage.setJSON('ct_day_snap', snap);
      } catch (e) {}
    }
    todayMB = Math.max(0, snap.start - flowMB);
  }

  const hist = [];
  if (todayMB != null) {
    let h = {};
    try {
      h = ctx.storage.getJSON('ct_hist') || {};
    } catch (e) {}
    h[dayKey] = todayMB;
    const keep = {};
    for (let i = 7; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      const k = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      if (h[k] != null) keep[k] = h[k];
      if (i <= 6) hist.push(h[k] == null ? null : h[k]);
    }
    try {
      ctx.storage.setJSON('ct_hist', keep);
    } catch (e) {}
  }

  let forecast = { text: '用量统计中…', color: SUB };
  if (flowMB != null) {
    const past = hist.slice(0, 6).filter((v) => v != null && v > 0);
    const vals = past.length ? past : todayMB > 0 ? [todayMB] : [];
    if (vals.length) {
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const days = Math.floor(flowMB / avg);
      forecast =
        days >= daysLeft
          ? { text: days > 999 ? '按近期速度 充足' : `预计够用 ${days} 天 ✓`, color: C_VOICE }
          : { text: `约 ${days} 天用完 · 早于月底`, color: C_FEE };
    }
  }

  return {
    hist,
    forecast,
    daysLeft,
    todayMB,
    dailyMB: flowMB != null ? flowMB / daysLeft : null,
    lowFee: (() => {
      const n = parseFloat(ds.fee && ds.fee.number);
      return Number.isFinite(n) && n < 10;
    })(),
  };
}

// 半圆仪表 SVG
function gaugeSvg(pct, color, w) {
  const stroke = 12,
    r = (w - stroke) / 2,
    cx = w / 2,
    cy = w / 2,
    h = w / 2 + stroke / 2;
  const p = normPct(pct);
  const pt = (a) => [(cx - r * Math.cos(a)).toFixed(2), (cy - r * Math.sin(a)).toFixed(2)];
  const [x0, y0] = pt(0),
    [x1, y1] = pt(Math.PI),
    [xp, yp] = pt(Math.PI * p);
  let body = `<path d='M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}' fill='none' stroke='${color}' stroke-opacity='0.22' stroke-width='${stroke}' stroke-linecap='round'/>`;
  if (p > 0.005)
    body += `<path d='M ${x0} ${y0} A ${r} ${r} 0 0 1 ${xp} ${yp}' fill='none' stroke='${color}' stroke-width='${stroke}' stroke-linecap='round'/>`;
  return (
    'data:image/svg+xml,' +
    encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'>${body}</svg>`)
  );
}

// 近 7 天用量柱状图（最后一根是今天）
function sparkSvg(values, color, w, h) {
  const vals = values && values.length ? values : [null, null, null, null, null, null, null];
  const n = vals.length,
    gap = 3,
    bw = (w - gap * (n - 1)) / n;
  const max = Math.max(1, ...vals.map((v) => v || 0));
  let body = '';
  vals.forEach((v, i) => {
    const bh = v ? Math.max(2, (v / max) * h) : 2;
    const op = v == null ? 0.15 : i === n - 1 ? 1 : 0.55;
    body += `<rect x='${(i * (bw + gap)).toFixed(1)}' y='${(h - bh).toFixed(1)}' width='${bw.toFixed(1)}' height='${bh.toFixed(1)}' rx='${Math.min(2, bw / 2).toFixed(1)}' fill='${color}' fill-opacity='${op}'/>`;
  });
  return (
    'data:image/svg+xml,' +
    encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'>${body}</svg>`)
  );
}

function t(text, size, weight, color, extra) {
  return Object.assign(
    {
      type: 'text',
      text: String(text),
      font: { size, weight: weight || 'regular' },
      textColor: color || TXT,
      maxLines: 1,
      minScale: 0.6,
    },
    extra || {}
  );
}

function glass(children, extra) {
  return Object.assign(
    {
      type: 'stack',
      direction: 'column',
      alignItems: 'start',
      gap: 6,
      padding: 12,
      borderRadius: 22,
      backgroundColor: GLASS,
      children,
    },
    extra || {}
  );
}

function headerRow(title, ds, fromCache, cookieDead) {
  const timeStr = ds && ds.updatedAt ? fmtTime(ds.updatedAt) : '--';
  const statusStr = cookieDead
    ? '⚠️ 登录失效，点我重登'
    : `${fromCache ? '缓存 · ' : ''}更新 ${timeStr}`;
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 4,
    children: [
      {
        type: 'image',
        src: 'sf-symbol:antenna.radiowaves.left.and.right',
        width: 12,
        height: 12,
        color: C_FLOW,
      },
      t(title, 'footnote', 'semibold'),
      { type: 'spacer' },
      t(statusStr, 10, cookieDead ? 'semibold' : 'regular', cookieDead ? WARN : SUB, { minScale: 1 }),
    ],
  };
}

function feeCard(ds, ins, size, extra) {
  const low = ins.lowFee;
  return glass(
    [
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 3,
        children: [
          {
            type: 'image',
            src: 'sf-symbol:yensign.circle.fill',
            width: 10,
            height: 10,
            color: low ? WARN : C_FEE,
          },
          t(low ? '话费不足' : '剩余话费', 9, 'medium', low ? WARN : SUB, { minScale: 1 }),
        ],
      },
      { type: 'spacer' },
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'end',
        gap: 1,
        children: [
          t('¥', 12, 'semibold', low ? WARN : SUB, { minScale: 1 }),
          t(ds.fee.number, size || 24, 'bold', low ? WARN : TXT, { minScale: 0.6 }),
        ],
      },
      { type: 'spacer' },
      t(`本月剩 ${ins.daysLeft} 天`, 9, 'medium', SUB, { minScale: 1 }),
    ],
    Object.assign({ gap: 2, padding: [7, 9], borderRadius: 16 }, extra || {})
  );
}

function gaugeCard(icon, color, d, fallbackTitle, opt) {
  const o = opt || {};
  const data = d || { title: fallbackTitle, number: '--', unit: '', percent: 0 };
  const p = normPct(data.percent);
  const pct = p > 0 ? Math.round(p * 100) : 0;
  const gw = o.gw || 46;
  return glass(
    [
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 3,
        children: [
          { type: 'image', src: `sf-symbol:${icon}`, width: 10, height: 10, color },
          t(o.title || fallbackTitle || data.title, 9, 'medium', SUB, { minScale: 1 }),
        ],
      },
      {
        type: 'stack',
        direction: 'column',
        alignItems: 'center',
        gap: -3,
        children: [
          {
            type: 'image',
            src: gaugeSvg(p, color, 64),
            width: gw,
            height: Math.round((gw * 38) / 64),
          },
          t(`${pct}%`, 9, 'bold', color, { minScale: 1 }),
        ],
      },
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'end',
        gap: 2,
        children: [
          t(data.number, o.numSize || 15, 'bold', TXT, { minScale: 0.7 }),
          t(data.unit || '', 9, 'semibold', SUB, { minScale: 1 }),
        ],
      },
    ],
    {
      flex: 1,
      alignItems: 'center',
      gap: 2,
      padding: [7, 4],
      borderRadius: 16,
      ...(o.height ? { height: o.height } : {}),
    }
  );
}

function statsStrip(ins, sparkW) {
  return glass(
    [
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 6,
        children: [
          { type: 'image', src: sparkSvg(ins.hist, C_FLOW, 70, 14), width: sparkW || 46, height: 11 },
          t(`今日 ${fmtMB(ins.todayMB)}`, 9, 'semibold', TXT, { minScale: 1 }),
          t(`日均可用 ${fmtMB(ins.dailyMB)}`, 9, 'medium', SUB, { minScale: 1 }),
          { type: 'spacer' },
          t(ins.forecast.text, 9, 'semibold', ins.forecast.color, { minScale: 0.8 }),
        ],
      },
    ],
    { padding: [6, 9], borderRadius: 12, gap: 0 }
  );
}

function refresh30() {
  return new Date(Date.now() + 30 * 60 * 1000).toISOString();
}

function buildSmall(title, ds, fromCache, ctx, cookieDead) {
  const ins = insights(ctx, ds);
  const showDir = showDirectCard(ctx, ds);
  const showUsed = String(ctx?.env?.CT_SHOW_USED_FLOW || '').toLowerCase() === 'true';
  const flowPct = normPct(ds.generalFlow && ds.generalFlow.percent);
  const pctStr = flowPct > 0 ? `${Math.round(flowPct * 100)}%` : '0%';
  return {
    type: 'widget',
    padding: 12,
    gap: 5,
    backgroundGradient: bg(),
    refreshAfter: refresh30(),
    children: [
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 4,
        children: [
          {
            type: 'image',
            src: 'sf-symbol:antenna.radiowaves.left.and.right',
            width: 11,
            height: 11,
            color: C_FLOW,
          },
          t(title, 'caption1', 'semibold'),
          { type: 'spacer' },
          t(`¥${ds.fee.number}`, 11, 'bold', ins.lowFee ? WARN : C_FEE, { minScale: 1 }),
        ],
      },
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 4,
        flex: 1,
        children: [
          {
            type: 'stack',
            direction: 'column',
            alignItems: 'start',
            gap: 0,
            children: [
              t(showUsed ? '已用流量' : '剩余流量', 9, 'medium', SUB, { minScale: 1 }),
              {
                type: 'stack',
                direction: 'row',
                alignItems: 'end',
                gap: 2,
                children: [
                  t(ds.generalFlow.number, 22, 'bold', TXT),
                  t(ds.generalFlow.unit || '', 9, 'semibold', SUB, { minScale: 1 }),
                ],
              },
            ],
          },
          { type: 'spacer' },
          {
            type: 'stack',
            direction: 'column',
            alignItems: 'center',
            gap: -3,
            children: [
              { type: 'image', src: gaugeSvg(flowPct, C_FLOW, 64), width: 42, height: 25 },
              t(pctStr, 9, 'bold', C_FLOW, { minScale: 1 }),
            ],
          },
        ],
      },
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'end',
        gap: 5,
        children: [
          { type: 'image', src: sparkSvg(ins.hist, C_FLOW, 70, 14), width: 44, height: 11 },
          t(`今日 ${fmtMB(ins.todayMB)}`, 9, 'semibold', TXT, { minScale: 1 }),
        ],
      },
      t(
        showDir
          ? `其他 ${ds.directFlow ? ds.directFlow.number + (ds.directFlow.unit || '') : '--'} · 语音 ${ds.voice.number}${ds.voice.unit || ''}`
          : `语音 ${ds.voice.number}${ds.voice.unit || ''}`,
        9,
        'medium',
        SUB,
        { minScale: 0.75 }
      ),
      t(`日均可用 ${fmtMB(ins.dailyMB)} · ${ins.forecast.text}`, 9, 'semibold', ins.forecast.color, {
        minScale: 0.7,
      }),
    ],
  };
}

function buildMedium(title, ds, fromCache, ctx, cookieDead) {
  const ins = insights(ctx, ds);
  const four = showDirectCard(ctx, ds);
  const showUsed = String(ctx?.env?.CT_SHOW_USED_FLOW || '').toLowerCase() === 'true';
  return {
    type: 'widget',
    padding: [10, 11],
    gap: 6,
    backgroundGradient: bg(),
    refreshAfter: refresh30(),
    children: [
      headerRow(title, ds, fromCache, cookieDead),
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 6,
        flex: 1,
        children: [
          feeCard(ds, ins, 23, { width: 84, height: 82, alignItems: 'center' }),
          gaugeCard('wifi', C_FLOW, ds.generalFlow, showUsed ? '已用流量' : '剩余流量', { height: 82 }),
          ...(four
            ? [
                gaugeCard(
                  'globe.asia.australia.fill',
                  C_OTHER,
                  ds.directFlow,
                  showUsed ? '已用其他' : '其他流量',
                  { height: 82 }
                ),
              ]
            : []),
          gaugeCard('phone.fill', C_VOICE, ds.voice, showUsed ? '已用语音' : '剩余语音', { height: 82 }),
        ],
      },
      statsStrip(ins, 40),
    ],
  };
}

function buildLarge(title, ds, fromCache, ctx, cookieDead) {
  const ins = insights(ctx, ds);
  const showUsed = String(ctx?.env?.CT_SHOW_USED_FLOW || '').toLowerCase() === 'true';
  const phone = (ctx.env?.CT_APP_PHONE || '').trim();
  const masked = /^\d{11}$/.test(phone) ? `${phone.slice(0, 3)} **** ${phone.slice(7)}` : '';
  const labels = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    labels.push(i === 0 ? '今' : `${d.getDate()}`);
  }
  return {
    type: 'widget',
    padding: 14,
    gap: 9,
    backgroundGradient: bg(),
    refreshAfter: refresh30(),
    children: [
      headerRow(title, ds, fromCache, cookieDead),
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 8,
        children: [
          feeCard(ds, ins, 32, { flex: 1, height: 74, padding: [9, 12] }),
          glass(
            [
              t('当前号码', 9, 'medium', SUB, { minScale: 1 }),
              t(masked || '--', 13, 'semibold', TXT, { family: 'Menlo', minScale: 0.7 }),
              { type: 'spacer' },
              t(ins.forecast.text, 10, 'semibold', ins.forecast.color, { minScale: 0.7 }),
            ],
            { flex: 1, height: 74, gap: 2, padding: [9, 12], borderRadius: 16 }
          ),
        ],
      },
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 8,
        children: [
          gaugeCard('wifi', C_FLOW, ds.generalFlow, showUsed ? '已用流量' : '剩余流量', {
            gw: 62,
            numSize: 18,
          }),
          gaugeCard(
            'globe.asia.australia.fill',
            C_OTHER,
            ds.directFlow,
            showUsed ? '已用其他' : '其他流量',
            { gw: 62, numSize: 18 }
          ),
          gaugeCard('phone.fill', C_VOICE, ds.voice, showUsed ? '已用语音' : '剩余语音', {
            gw: 62,
            numSize: 18,
          }),
        ],
      },
      glass(
        [
          {
            type: 'stack',
            direction: 'row',
            alignItems: 'center',
            gap: 4,
            children: [
              { type: 'image', src: 'sf-symbol:chart.bar.fill', width: 10, height: 10, color: C_FLOW },
              t('近 7 天流量', 10, 'semibold', TXT, { minScale: 1 }),
              { type: 'spacer' },
              t(`今日 ${fmtMB(ins.todayMB)} · 日均可用 ${fmtMB(ins.dailyMB)}`, 9, 'medium', SUB, {
                minScale: 0.8,
              }),
            ],
          },
          { type: 'image', src: sparkSvg(ins.hist, C_FLOW, 290, 40), width: 290, height: 40 },
          {
            type: 'stack',
            direction: 'row',
            alignItems: 'center',
            gap: 0,
            children: labels.map((l) => ({
              type: 'stack',
              direction: 'row',
              flex: 1,
              children: [{ type: 'spacer' }, t(l, 8, 'medium', SUB, { minScale: 1 }), { type: 'spacer' }],
            })),
          },
        ],
        { gap: 5, padding: [9, 12], borderRadius: 16 }
      ),
      { type: 'spacer' },
    ],
  };
}

function buildLockScreen(title, ds, family, ctx) {
  const ins = insights(ctx, ds);
  if (family === 'accessoryInline') {
    return {
      type: 'widget',
      children: [
        {
          type: 'text',
          text: `¥${ds.fee.number} · ${ds.generalFlow.number}${ds.generalFlow.unit} · ${ds.voice.number}分`,
          maxLines: 1,
          minScale: 0.6,
        },
      ],
    };
  }
  if (family === 'accessoryCircular') {
    return {
      type: 'widget',
      children: [
        {
          type: 'text',
          text: `¥${ds.fee.number}`,
          font: { size: 'body', weight: 'semibold' },
          textAlign: 'center',
        },
      ],
    };
  }
  return {
    type: 'widget',
    padding: [2, 4],
    gap: 2,
    children: [
      {
        type: 'text',
        text: `¥${ds.fee.number}${ins.lowFee ? ' · 话费不足' : ''}`,
        font: { size: 'footnote', weight: 'bold' },
        maxLines: 1,
        minScale: 0.6,
      },
      {
        type: 'text',
        text: `流量 ${ds.generalFlow.number} ${ds.generalFlow.unit} · 语音 ${ds.voice.number}分`,
        font: { size: 'caption2', weight: 'semibold' },
        maxLines: 1,
        minScale: 0.6,
      },
      {
        type: 'text',
        text:
          ins.todayMB != null
            ? `今日 ${fmtMB(ins.todayMB)} · 日均 ${fmtMB(ins.dailyMB)}`
            : `还剩 ${ins.daysLeft} 天`,
        font: { size: 'caption2' },
        opacity: 0.7,
        maxLines: 1,
        minScale: 0.6,
      },
    ],
  };
}

function buildError(title, message, url) {
  const w = {
    type: 'widget',
    padding: 14,
    gap: 6,
    backgroundGradient: bg(),
    children: [
      t(title, 'footnote', 'semibold'),
      { type: 'spacer' },
      {
        type: 'image',
        src: 'sf-symbol:exclamationmark.triangle.fill',
        width: 22,
        height: 22,
        color: C_FEE,
      },
      t(message, 'caption1', 'medium', TXT, { maxLines: 4, minScale: 0.7 }),
      { type: 'spacer' },
    ],
  };
  if (url) w.url = url;
  return w;
}

/* ---------- 登录捕获（request 脚本模式） ---------- */

// 在 Safari/浏览器里登录 e.dlife.cn 成功时，Egern 会经过 loginMiddle 请求，
// 在此自动捕获登录地址存入存储，小组件下次运行自动读取，全程无需手动操作。
// 不返回值 = 透传，不影响登录请求本身。
/* 从请求头里取 Cookie，兼容 plain object / Headers 实例等形态，忽略大小写 */
function getReqCookie(headers) {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return headers.get('cookie') || headers.get('Cookie') || '';
  }
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() === 'cookie') return headers[k] || '';
  }
  return '';
}

async function handleCapture(ctx) {
  const req = ctx.request || {};
  const url = req.url || '';
  if (!url.includes('e.dlife.cn')) return; // 非电信请求直接透传

  // 1) 登录握手地址：记下来，并标记"刚刚登录过"（10 分钟内有效）
  if (url.includes('/user/loginMiddle')) {
    const loginUrl = (url.match(/(http.+)&sign/) || [])[1] || url;
    if (loginUrl && ctx.storage.get('ct_login_url') !== loginUrl) {
      ctx.storage.set('ct_login_url', loginUrl);
    }
    ctx.storage.set('ct_login_ts', String(Date.now()));
    return;
  }

  // 2) 主要方式：直接从登录后的真实请求里抓 Cookie，比回放握手地址可靠
  const cookie = String(getReqCookie(req.headers) || '').trim();
  if (!cookie || ctx.storage.get('ct_cookie') === cookie) return;
  ctx.storage.set('ct_cookie', cookie);

  // 只有"刚登录过"才打扰用户（成功信号）；后台静默续期不通知
  const ts = Number(ctx.storage.get('ct_login_ts') || 0);
  if (Date.now() - ts < 10 * 60 * 1000) {
    ctx.storage.delete('ct_login_ts');
    ctx.notify({
      title: '中国电信',
      body: '登录成功，小组件将自动更新',
      // 兜底：如果小组件没自动读到，点通知手动复制 cookie
      action: { type: 'clipboard', text: cookie },
    });
  }
}

/* ---------- 小组件（generic 脚本模式） ---------- */

async function handleWidget(ctx) {
  const title = (ctx.env.CT_TITLE || '中国电信').trim() || '中国电信';
  const { configured, ds, fromCache, cookieDead } = await loadData(ctx);

  if (!configured) {
    return buildError(
      title,
      '未登录：在 Safari 打开 e.dlife.cn 登录一次',
      URLS.login
    );
  }
  if (!ds) {
    return buildError(title, cookieDead ? '登录已失效，请重新登录' : '数据获取失败，请检查网络或重新登录', URLS.login);
  }

  const family = ctx.widgetFamily || 'systemSmall';
  let w;
  if (family === 'systemLarge' || family === 'systemExtraLarge') {
    w = buildLarge(title, ds, fromCache, ctx, cookieDead);
  } else if (family === 'systemMedium') {
    w = buildMedium(title, ds, fromCache, ctx, cookieDead);
  } else if (family.startsWith('accessory')) {
    w = buildLockScreen(title, ds, family, ctx);
  } else {
    w = buildSmall(title, ds, fromCache, ctx, cookieDead);
  }
  // cookie 失效时点小组件直接跳去登录页
  if (cookieDead) w.url = URLS.login;
  return w;
}

/* ---------- 入口：单文件双模式 ---------- */

export default async function (ctx) {
  // request 脚本条目 → 捕获登录；generic 脚本条目 → 渲染小组件
  //（ctx.request 仅在 request/response 脚本中可用）
  if (ctx.request && ctx.request.url) {
    return handleCapture(ctx);
  }
  // schedule 定时保活 → 轻量 ping 一次续 session，不渲染小组件
  // 只发一个请求：完整 loadData 最坏要串行发多个请求，容易超过定时任务超时；
  // 保活只需要一次真实触达，利用服务端 session 滑动过期机制续命
  if (ctx.cron || !ctx.widgetFamily) {
    const keep = String(ctx.env?.CT_KEEPALIVE || '').toLowerCase();
    if (keep === 'false' || keep === '0') return { type: 'text', text: 'keepalive disabled' };
    await ctKeepAlive(ctx);
    return { type: 'text', text: 'keepalive done' };
  }
  return handleWidget(ctx);
}

// 定时保活：轻量 ping 一次续 session，成功/失败都不通知不写缓存
async function ctKeepAlive(ctx) {
  const cookie =
    (ctx.env.CT_COOKIE || '').trim() ||
    ctx.storage.get('ct_cookie') ||
    '';
  if (!cookie) return;
  try {
    const resp = await ctx.http.get(URLS.detail, {
      headers: {
        'Cookie': cookie,
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      },
      timeout: 10000,
      credentials: 'omit',
    });
    // 滑动续期：保活响应若带 Set-Cookie 也合并进存储
    harvestSetCookie(ctx, resp, cookie);
  } catch (e) {}
}
