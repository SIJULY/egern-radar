/**
 * 中国电信小组件 (Scriptable 独立版)
 * 转换自仓库内 Egern 版 china-telecom.js（原版源自 2Ya&脑瓜 / gumson）
 *
 * 功能特性：
 * 1. 双通道登录支持：
 *    - 通道一（推荐）：电信 App 登录链（手机号 + 服务密码 + 16位 AndroidID），自动续期重登
 *    - 通道二：网页版 e.dlife.cn Cookie / 登录 URL（支持内置网页登录尝试提取或抓包填入）
 * 2. 支持 3 卡（话费/通用/语音）与 4 卡（话费/通用/定向/语音）自动或强制切换，支持剩余/已用切换
 * 3. 支持透明背景设置：空白桌面截图自动裁切、相册选图、深浅磨砂蒙版、透明背景字体颜色切换（纯白高亮字+阴影 / 深邃浓黑字 / 跟随系统）
 * 4. 完整适配小号 (Small)、中号 (Medium)、大号 (Large) 及锁屏小组件 (Accessory)
 */

const NS = 'china-telecom:scriptable:v1:'
const URLS = {
  login: 'https://e.dlife.cn/index.do',
  detail: 'https://e.dlife.cn/user/package_detail.do',
  balance: 'https://e.dlife.cn/user/balance.do',
}

const DEFAULTS = {
  title: '中国电信',
  phone: '',
  password: '',
  androidId: '',
  cookie: '',
  loginUrl: '',
  showUsedFlow: false, // true: 显示已用流量/语音, false: 显示剩余
  showDirect: 'auto',  // 'auto': 有定向数据才显示4卡, 'true': 强制4卡, 'false': 强制3卡
  bgTextMode: 'light', // 'light': 纯白高亮字+立体阴影(默认), 'dark': 深色浓黑字, 'auto': 跟随系统
  refreshMinutes: 30,  // 桌面小组件自动刷新间隔（分钟）
}

// ─── Keychain 与持久化存储工具 ───
function getStore(key, fallback = '') {
  const fullKey = NS + key
  try {
    if (Keychain.contains(fullKey)) {
      const v = Keychain.get(fullKey)
      if (v != null) return v
    }
  } catch (_) {}
  return fallback
}

function setStore(key, val) {
  const fullKey = NS + key
  try {
    if (val === undefined || val === null || val === '') {
      if (Keychain.contains(fullKey)) Keychain.remove(fullKey)
    } else {
      Keychain.set(fullKey, String(val))
    }
  } catch (_) {}
}

function getStoreJSON(key, fallback = null) {
  const raw = getStore(key, '')
  if (!raw) return fallback
  try {
    return JSON.parse(raw)
  } catch (_) {
    return fallback
  }
}

function setStoreJSON(key, obj) {
  try {
    setStore(key, JSON.stringify(obj))
  } catch (_) {}
}

function settings() {
  const saved = getStoreJSON('settings', {}) || {}
  const merged = Object.assign({}, DEFAULTS, saved)
  // 支持通过桌面 Widget Parameter 临时覆盖标题（如填入自定义标题）
  const param = String(args.widgetParameter || '').trim()
  if (param) merged.title = param
  return merged
}

function saveSettings(patch) {
  const next = Object.assign({}, settings(), patch || {})
  setStoreJSON('settings', next)
  return next
}

/* ================= 工具与加解密函数（App 登录链） ================= */

function cdtCaesar2(s) {
  return [...String(s)].map(c => String.fromCharCode((c.charCodeAt(0) + 2) & 0xffff)).join('')
}

function cdtTs14(d) {
  d = d || new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function cdtHexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function cdtBytesToHex(b) {
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('')
}

function cdtUtf8Bytes(str) {
  const out = []
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1)
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00)
        i++
      }
    }
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
  }
  return Uint8Array.from(out)
}

const CDT_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function cdtBase64Encode(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i],
      b1 = i + 1 < bytes.length ? bytes[i + 1] : 0,
      b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += CDT_B64[b0 >> 2] + CDT_B64[((b0 & 3) << 4) | (b1 >> 4)]
    out += i + 1 < bytes.length ? CDT_B64[((b1 & 15) << 2) | (b2 >> 6)] : '='
    out += i + 2 < bytes.length ? CDT_B64[b2 & 63] : '='
  }
  return out
}

/* ================= RSA（PKCS#1 v1.5） ================= */

const CDT_RSA_N_HEX =
  'c190b4f5e53855833ebf34e97ab3c18d3e87dd5b359b0a45a791a026eced8b8e43351fb74cbf3922a9dc54d368da9864472d7fd934c0971e73dc5bfb0386214204dd7ca85bf2f20e9561bf50b6ba08d3d7b5efab3e642b62bfb85b8a7d9c0938fdf625299c4968666d7d9701f2a3af6ee543223cca6ad3f5ca04ef2562137f83'
const CDT_RSA_E = 65537n
const CDT_RSA_N = BigInt('0x' + CDT_RSA_N_HEX)
const CDT_RSA_KEY_BYTES = 128

function cdtModPow(base, exp, mod) {
  let result = 1n
  let b = base % mod
  let e = exp
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod
    b = (b * b) % mod
    e >>= 1n
  }
  return result
}

function cdtBigintToBytes(v, len) {
  const out = new Uint8Array(len)
  let x = v
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn)
    x >>= 8n
  }
  return out
}

function cdtRsaEncryptPkcs1(msg) {
  const m = cdtUtf8Bytes(msg)
  if (m.length > CDT_RSA_KEY_BYTES - 11) throw new Error('RSA 明文过长')
  const psLen = CDT_RSA_KEY_BYTES - 3 - m.length
  const block = new Uint8Array(CDT_RSA_KEY_BYTES)
  block[0] = 0x00
  block[1] = 0x02
  for (let i = 0; i < psLen; i++) {
    let b = 0
    while (b === 0) b = Math.floor(Math.random() * 256)
    block[2 + i] = b
  }
  block[2 + psLen] = 0x00
  block.set(m, 3 + psLen)
  let v = 0n
  for (const b of block) v = (v << 8n) | BigInt(b)
  const c = cdtModPow(v, CDT_RSA_E, CDT_RSA_N)
  const cBytes = cdtBigintToBytes(c, CDT_RSA_KEY_BYTES)
  return cdtBase64Encode(cBytes)
}

/* ================= TripleDES-CBC ================= */

const CDT_DES_IP = [58,50,42,34,26,18,10,2,60,52,44,36,28,20,12,4,62,54,46,38,30,22,14,6,64,56,48,40,32,24,16,8,57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,61,53,45,37,29,21,13,5,63,55,47,39,31,23,15,7]
const CDT_DES_FP = [40,8,48,16,56,24,64,32,39,7,47,15,55,23,63,31,38,6,46,14,54,22,62,30,37,5,45,13,53,21,61,29,36,4,44,12,52,20,60,28,35,3,43,11,51,19,59,27,34,2,42,10,50,18,58,26,33,1,41,9,49,17,57,25]
const CDT_DES_E = [32,1,2,3,4,5,4,5,6,7,8,9,8,9,10,11,12,13,12,13,14,15,16,17,16,17,18,19,20,21,20,21,22,23,24,25,24,25,26,27,28,29,28,29,30,31,32,1]
const CDT_DES_P = [16,7,20,21,29,12,28,17,1,15,23,26,5,18,31,10,2,8,24,14,32,27,3,9,19,13,30,6,22,11,4,25]
const CDT_DES_PC1 = [57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,60,52,44,36,63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,28,20,12,4]
const CDT_DES_PC2 = [14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32]
const CDT_DES_ROT = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1]
const CDT_DES_SBOX = [
  [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
  [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
  [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
  [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
  [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
  [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
  [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
  [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11],
]

function cdtDesBytesToBits(b) {
  const out = []
  for (const byte of b) for (let i = 7; i >= 0; i--) out.push((byte >> i) & 1)
  return out
}
function cdtDesBitsToBytes(bits) {
  const out = new Uint8Array(bits.length / 8)
  for (let i = 0; i < out.length; i++) {
    let v = 0
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j]
    out[i] = v
  }
  return out
}
function cdtDesPerm(bits, table) {
  return table.map(p => bits[p - 1])
}
function cdtDesXor(a, b) {
  return a.map((v, i) => v ^ b[i])
}
function cdtDesRotL(bits, n) {
  return bits.slice(n).concat(bits.slice(0, n))
}

function cdtDesKeySchedule(key8) {
  const k56 = cdtDesPerm(cdtDesBytesToBits(key8), CDT_DES_PC1)
  let c = k56.slice(0, 28),
    d = k56.slice(28)
  const subs = []
  for (let i = 0; i < 16; i++) {
    c = cdtDesRotL(c, CDT_DES_ROT[i])
    d = cdtDesRotL(d, CDT_DES_ROT[i])
    subs.push(cdtDesPerm(c.concat(d), CDT_DES_PC2))
  }
  return subs
}

function cdtDesFeistel(r32, sub) {
  const e48 = cdtDesPerm(r32, CDT_DES_E)
  const x = cdtDesXor(e48, sub)
  const s32 = []
  for (let s = 0; s < 8; s++) {
    const chunk = x.slice(s * 6, s * 6 + 6)
    const row = (chunk[0] << 1) | chunk[5]
    const col = (chunk[1] << 3) | (chunk[2] << 2) | (chunk[3] << 1) | chunk[4]
    const v = CDT_DES_SBOX[s][row * 16 + col]
    for (let i = 3; i >= 0; i--) s32.push((v >> i) & 1)
  }
  return cdtDesPerm(s32, CDT_DES_P)
}

function cdtDesBlock(block8, subs, decrypt) {
  const ip = cdtDesPerm(cdtDesBytesToBits(block8), CDT_DES_IP)
  let l = ip.slice(0, 32),
    r = ip.slice(32)
  for (let i = 0; i < 16; i++) {
    const sub = decrypt ? subs[15 - i] : subs[i]
    const nl = r,
      nr = cdtDesXor(l, cdtDesFeistel(r, sub))
    l = nl
    r = nr
  }
  return cdtDesBitsToBytes(cdtDesPerm(r.concat(l), CDT_DES_FP))
}

function cdtTripleDesCbc(data, key24, iv8, encrypt) {
  const k1 = cdtDesKeySchedule(key24.slice(0, 8))
  const k2 = cdtDesKeySchedule(key24.slice(8, 16))
  const k3 = cdtDesKeySchedule(key24.slice(16, 24))
  const single = (blk, ks, dec) => cdtDesBlock(blk, ks, dec)
  const ede = (blk, dec) =>
    dec
      ? single(single(single(blk, k3, true), k2, false), k1, true)
      : single(single(single(blk, k1, false), k2, true), k3, false)
  let input
  if (encrypt) {
    const pad = 8 - (data.length % 8)
    input = new Uint8Array(data.length + pad)
    input.set(data)
    input.fill(pad, data.length)
  } else {
    input = data
  }
  const out = new Uint8Array(input.length)
  let prev = iv8
  for (let off = 0; off < input.length; off += 8) {
    const blk = input.slice(off, off + 8)
    if (encrypt) {
      const x = new Uint8Array(8)
      for (let i = 0; i < 8; i++) x[i] = blk[i] ^ prev[i]
      const c = ede(x, false)
      out.set(c, off)
      prev = c
    } else {
      const p = ede(blk, true)
      for (let i = 0; i < 8; i++) out[off + i] = p[i] ^ prev[i]
      prev = blk
    }
  }
  if (!encrypt) {
    const pad = out[out.length - 1]
    if (pad < 1 || pad > 8) throw new Error('3DES 解密填充错误')
    return out.slice(0, out.length - pad)
  }
  return out
}

/* ================= AES-128-ECB（PKCS7） ================= */

const CDT_AES_SBOX = [
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
]
const CDT_AES_RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36]

function cdtAesXtime(a) {
  return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff
}

function cdtAesExpandKey(key) {
  const ek = new Uint8Array(176)
  ek.set(key)
  for (let i = 16; i < 176; i += 4) {
    let t0 = ek[i - 4], t1 = ek[i - 3], t2 = ek[i - 2], t3 = ek[i - 1]
    if (i % 16 === 0) {
      const u = CDT_AES_SBOX[t1]
      t1 = CDT_AES_SBOX[t2]
      t2 = CDT_AES_SBOX[t3]
      t3 = CDT_AES_SBOX[t0]
      t0 = u ^ CDT_AES_RCON[i / 16 - 1]
    }
    ek[i] = ek[i - 16] ^ t0
    ek[i + 1] = ek[i - 15] ^ t1
    ek[i + 2] = ek[i - 14] ^ t2
    ek[i + 3] = ek[i - 13] ^ t3
  }
  return ek
}

function cdtAesEncryptBlock(block, ek) {
  const s = new Uint8Array(16)
  for (let i = 0; i < 16; i++) s[i] = block[i] ^ ek[i]
  for (let round = 1; round <= 10; round++) {
    for (let i = 0; i < 16; i++) s[i] = CDT_AES_SBOX[s[i]]
    let t
    t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t
    t = s[2]; s[2] = s[10]; s[10] = t
    t = s[6]; s[6] = s[14]; s[14] = t
    t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t
    if (round < 10) {
      for (let c = 0; c < 4; c++) {
        const i = c * 4
        const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3]
        const b0 = cdtAesXtime(a0), b1 = cdtAesXtime(a1), b2 = cdtAesXtime(a2), b3 = cdtAesXtime(a3)
        s[i] = b0 ^ a1 ^ b1 ^ a2 ^ a3
        s[i + 1] = a0 ^ b1 ^ a2 ^ b2 ^ a3
        s[i + 2] = a0 ^ a1 ^ b2 ^ a3 ^ b3
        s[i + 3] = a0 ^ b0 ^ a1 ^ a2 ^ b3
      }
    }
    const off = round * 16
    for (let i = 0; i < 16; i++) s[i] ^= ek[off + i]
  }
  return s
}

function cdtAes128EcbPkcs7Base64(plaintext, keyStr) {
  const key = cdtUtf8Bytes(keyStr)
  if (key.length !== 16) throw new Error('AES-128 需要 16 字节 key')
  const ek = cdtAesExpandKey(key)
  const pt = cdtUtf8Bytes(plaintext)
  const padLen = 16 - (pt.length % 16)
  const data = new Uint8Array(pt.length + padLen)
  data.set(pt)
  data.fill(padLen, pt.length)
  const out = new Uint8Array(data.length)
  for (let off = 0; off < data.length; off += 16) {
    out.set(cdtAesEncryptBlock(data.subarray(off, off + 16), ek), off)
  }
  return cdtBase64Encode(out)
}

/* ================= 电信 App 协议封装与三步登录链（与 china-telecom.js 1:1 对齐） ================= */

const CDT_LOGIN_UA =
  'Mozilla/5.0 (Linux; U; Android 12; zh-cn) AppleWebKit/533.1 (KHTML, like Gecko) Version/5.0 Mobile Safari/533.1'
const CDT_DES3_KEY_STR = '1234567`90koiuyhgtfrdews'
const CDT_AES_LOGIN_KEY = 'telecom_wap_2018'
const CDT_APP_CLIENT_TYPE = '#11.0.0#channel8#Xiaomi 20#'
const CDT_APPFUWU_UA = 'P216010901'

function cdtExplainCode(rc) {
  if (rc === '3001') return '（手机号或密码有误；若确认无误，可能是账号被临时锁定，请等 1-2 小时再试）'
  if (rc === '3006') return '（服务端风控拒绝；可能是设备指纹异常或账号被锁定，请等 1-2 小时再试）'
  return ''
}

function cdtTsMin(d) {
  d = d || new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}00`
}

async function cdtHttpPost(url, body, contentType, customHeaders) {
  const req = new Request(url)
  req.method = 'POST'
  req.timeoutInterval = 30
  req.headers = Object.assign(
    {
      'Content-Type': contentType || 'application/json',
      'User-Agent': CDT_LOGIN_UA,
    },
    customHeaders || {}
  )
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body)
  req.body = Data.fromString(rawBody)
  const text = await req.loadString()
  const status = req.response && req.response.statusCode ? req.response.statusCode : 200
  let json = null
  try {
    json = JSON.parse(text)
  } catch (_) {}
  return { status, text, json }
}

async function cdtRunLoginChain(phoneInput, passwdInput, androidIdInput) {
  const steps = []
  const fail = msg => {
    steps.push({ ok: false, msg })
    return { steps }
  }

  const phone = String(phoneInput || '').trim()
  const passwd = String(passwdInput || '').trim()
  const androidId = String(androidIdInput || '').trim().toLowerCase()
  if (!/^1\d{10}$/.test(phone)) return fail('① 手机号格式不对，应为 11 位数字')
  if (!passwd) return fail('① 服务密码不能为空')
  if (!/^[0-9a-f]{16}$/.test(androidId)) return fail('① AndroidID 格式不对，应为 16 位十六进制字符')

  const t = cdtTs14()
  const plain = `Xiaomi 20 8.0.0.${androidId.slice(0, 12)}${phone}${t}${passwd}0$$$0.`
  let cipherB64
  try {
    cipherB64 = cdtRsaEncryptPkcs1(plain)
  } catch (e) {
    return fail(`① RSA 加密失败: ${e && e.message}`)
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
  }
  let r1
  try {
    r1 = await cdtHttpPost('https://appgologin.189.cn:9031/login/client/userLoginNormal', body1)
  } catch (e) {
    return fail(`① 登录请求网络异常: ${e && e.message}`)
  }
  const respData = (r1.json && r1.json.responseData) || {}
  const rc1 = String(respData.resultCode || '')
  if (rc1 !== '0000') {
    const msg = (r1.json && r1.json.msg) || respData.resultDetail || respData.resultDesc || ''
    return fail(`① 登录失败 resultCode=${rc1} ${msg}${cdtExplainCode(rc1)}`)
  }
  const loginData = respData.data && respData.data.loginSuccessResult
  if (!loginData || !loginData.token) {
    return fail('① 登录响应缺少 token')
  }
  const userId = loginData.userId
  const token = loginData.token
  steps.push({ ok: true, msg: `① 登录成功 userId=${userId}` })

  const des3key = cdtUtf8Bytes(CDT_DES3_KEY_STR)
  const iv8 = new Uint8Array(8)
  let targetIdHex
  try {
    targetIdHex = cdtBytesToHex(cdtTripleDesCbc(cdtUtf8Bytes(String(userId)), des3key, iv8, true))
  } catch (e) {
    return fail(`② 3DES 加密失败: ${e && e.message}`)
  }
  const xml = `<Request>
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
</Request>`
  let r2
  try {
    r2 = await cdtHttpPost('https://appgologin.189.cn:9031/map/clientXML', xml, 'application/xml')
  } catch (e) {
    return fail(`② 换 ticket 请求网络异常: ${e && e.message}`)
  }
  if (typeof r2.text !== 'string' || !r2.text.includes('<Ticket>')) {
    return fail('② 未取到 Ticket')
  }
  let ticketHex, uid
  try {
    ticketHex = r2.text.split('<Ticket>')[1].split('</Ticket>')[0]
    const dec = cdtTripleDesCbc(cdtHexToBytes(ticketHex), des3key, iv8, false)
    uid = String.fromCharCode(...dec)
  } catch (e) {
    return fail(`② Ticket 解密失败: ${e && e.message}`)
  }
  if (!uid) return fail('② Ticket 解密结果为空')
  steps.push({ ok: true, msg: '② 拿到 ticket' })

  const authPlain = JSON.stringify({
    ticket: uid,
    backUrl: 'https%3A%2F%2Fwapact.189.cn%3A9001',
    platformCode: 'P201010301',
    loginType: 2,
  })
  let authBody
  try {
    authBody = cdtAes128EcbPkcs7Base64(authPlain, CDT_AES_LOGIN_KEY)
  } catch (e) {
    return fail(`③ AES 加密失败: ${e && e.message}`)
  }
  let r3
  try {
    r3 = await cdtHttpPost('https://wapact.189.cn:9001/unified/user/login', authBody)
  } catch (e) {
    return fail(`③ 统一登录请求网络异常: ${e && e.message}`)
  }
  let bearer = ''
  if (r3.json && r3.json.code === 0 && r3.json.biz && r3.json.biz.token) {
    bearer = `Bearer ${r3.json.biz.token}`
    steps.push({ ok: true, msg: '③ 统一登录成功，拿到 Bearer' })
  } else {
    steps.push({ ok: false, msg: `③ 统一登录未拿到 Bearer (code=${r3.json && r3.json.code})，但前两步已通` })
  }
  return { steps, userId: String(userId), token: String(token), ticket: ticketHex, uid, bearer }
}

/* ================= App 接口查数据（与 china-telecom.js 1:1 对齐） ================= */

async function cdtFetchImportantData(token, phone) {
  const t = cdtTsMin()
  const encPhone = cdtCaesar2(phone)
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
  }
  const r = await cdtHttpPost('https://appfuwu.189.cn:9021/query/qryImportantData', body, 'application/json; charset=UTF-8', {
    Accept: 'application/json',
    'user-agent': CDT_APPFUWU_UA,
  })
  const rd = r.json && r.json.responseData
  if (!rd || rd.resultCode !== '0000') {
    const err = new Error(`resultCode=${rd && rd.resultCode} | ${String(r.text || '').slice(0, 160)}`)
    err.needRelogin = true
    throw err
  }
  const d = rd.data
  const num = v => {
    const n = parseInt(String(v != null ? v : '0'), 10)
    return isNaN(n) ? 0 : n
  }
  const total = (d && d.flowInfo && d.flowInfo.totalAmount) || {}
  const common = (d && d.flowInfo && d.flowInfo.commonFlow) || {}
  const special = (d && d.flowInfo && d.flowInfo.specialAmount) || {}
  const voice = (d && d.voiceInfo && d.voiceInfo.voiceDataInfo) || {}
  const balStr =
    (d && d.balanceInfo && d.balanceInfo.indexBalanceDataInfo && d.balanceInfo.indexBalanceDataInfo.balance) != null
      ? d.balanceInfo.indexBalanceDataInfo.balance
      : '0'
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
  }
}

function cdtAppDataToParsed(apiData) {
  const feeFen = apiData.balanceFen || 0
  const feeBalance = (feeFen / 100).toFixed(2)
  const flowUsed = apiData.commonUsedKB || 0
  const flowBalance = apiData.commonBalanceKB || 0
  const flowTotal = flowUsed + flowBalance
  const dirUsed = apiData.specialUsedKB || 0
  const dirBalance = apiData.specialBalanceKB || 0
  const dirTotal = dirUsed + dirBalance
  const voiceTotal = apiData.voiceTotal || 0
  const voiceBalance = apiData.voiceBalance || 0
  const voiceUsage = apiData.voiceUsed != null ? apiData.voiceUsed : Math.max(0, voiceTotal - voiceBalance)
  return {
    feeBalance,
    voiceBalance: Math.round(voiceBalance),
    voiceUsage: Math.round(voiceUsage),
    voiceTotal: Math.round(voiceTotal || voiceBalance + voiceUsage),
    flowUsed,
    flowBalance,
    flowTotal,
    dirUsed,
    dirBalance,
    dirTotal,
    hasDir: dirTotal > 0 || dirBalance > 0 || dirUsed > 0,
    pkgName: '',
    channel: 'app',
    updatedAt: Date.now(),
  }
}

async function fetchViaAppChannel(phone, password, androidId, forceRelogin = false) {
  let token = forceRelogin ? '' : getStore('app_token', '')
  const savedPhone = getStore('app_phone', '')
  if (savedPhone && savedPhone !== phone) token = ''

  let apiData = null
  if (token) {
    try {
      apiData = await cdtFetchImportantData(token, phone)
    } catch (_) {
      token = ''
    }
  }
  if (!apiData) {
    const r = await cdtRunLoginChain(phone, password, androidId)
    const allOk = r.steps && r.steps.length >= 2 && r.steps.slice(0, 2).every(s => s.ok)
    if (!allOk || !r.token) {
      const msg = (r.steps || []).filter(s => !s.ok).map(s => s.msg).join('; ') || 'App登录失败'
      throw new Error(msg)
    }
    setStore('app_token', r.token)
    setStore('app_phone', phone)
    apiData = await cdtFetchImportantData(r.token, phone)
  }
  return cdtAppDataToParsed(apiData)
}

/* ================= 网页版 Cookie 与数据拉取/解析 ================= */

function parseCookieMap(cookieStr) {
  const map = new Map()
  if (!cookieStr) return map
  for (const part of String(cookieStr).split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (!k) continue
    if (/^(path|domain|expires|max-age|secure|httponly|samesite)$/i.test(k)) continue
    map.set(k, v)
  }
  return map
}

function stringifyCookieMap(map) {
  const arr = []
  for (const [k, v] of map.entries()) arr.push(`${k}=${v}`)
  return arr.join('; ')
}

function extractSetCookieString(headers) {
  if (!headers) return ''
  let raw = ''
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() === 'set-cookie') {
      const val = headers[k]
      raw = Array.isArray(val) ? val.join('\n') : String(val || '')
      break
    }
  }
  if (!raw) return ''
  const lines = raw.split(/\r?\n|,(?=\s*[A-Za-z0-9_\-]+=)/)
  const map = new Map()
  for (const line of lines) {
    const firstPair = line.split(';')[0].trim()
    const idx = firstPair.indexOf('=')
    if (idx > 0) {
      const k = firstPair.slice(0, idx).trim()
      const v = firstPair.slice(idx + 1).trim()
      if (k) map.set(k, v)
    }
  }
  return stringifyCookieMap(map)
}

function mergeCookies(oldCookie, newCookie) {
  const map = parseCookieMap(oldCookie)
  const add = parseCookieMap(newCookie)
  for (const [k, v] of add.entries()) map.set(k, v)
  return stringifyCookieMap(map)
}

async function refreshCookieByUrl(loginUrl, currentCookie) {
  if (!loginUrl) return currentCookie
  try {
    const req = new Request(loginUrl)
    req.method = 'GET'
    req.timeoutInterval = 12
    req.headers = {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148;CtClient;11.0.0;iOS;17.0;',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    }
    if (currentCookie) req.headers.Cookie = currentCookie
    await req.loadString()
    const setCookie = extractSetCookieString(req.response && req.response.headers)
    if (setCookie) {
      const merged = mergeCookies(currentCookie, setCookie)
      saveSettings({ cookie: merged })
      return merged
    }
  } catch (_) {}
  return currentCookie
}

async function httpGetJson(url, cookie) {
  const req = new Request(url)
  req.method = 'GET'
  req.timeoutInterval = 12
  req.headers = {
    Cookie: cookie || '',
    'User-Agent':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148;CtClient;11.0.0;iOS;17.0;',
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://e.dlife.cn/user/package_detail.do',
  }
  const text = await req.loadString()
  const setCookie = extractSetCookieString(req.response && req.response.headers)
  if (setCookie) {
    const merged = mergeCookies(cookie, setCookie)
    saveSettings({ cookie: merged })
  }
  let data = null
  try {
    data = JSON.parse(text)
  } catch (_) {
    throw new Error('COOKIE_EXPIRED')
  }
  if (!data || typeof data !== 'object') throw new Error('COOKIE_EXPIRED')
  if (data.result === -10002 || data.result === '-10002') throw new Error('COOKIE_EXPIRED')
  return data
}

const SPECIAL_TYPES = new Set(['34', '334', '335', '336', '337'])

function toNum(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function fmtFlow(kb) {
  const n = Math.max(0, toNum(kb))
  const mb = n / 1024
  if (mb < 1024) return { value: mb >= 100 ? mb.toFixed(0) : mb.toFixed(2), unit: 'MB' }
  const gb = mb / 1024
  return { value: gb.toFixed(2), unit: 'GB' }
}

function fmtNum(v, digits = 2) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '0'
  return String(Number(n.toFixed(digits)))
}

function fmtTime(ts) {
  const d = ts ? new Date(ts) : new Date()
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function parseTelecom(detailJson, balanceJson) {
  let voiceBalance = 0
  let voiceUsage = 0
  let voiceTotal = 0

  let flowUsed = 0
  let flowBalance = 0
  let flowTotal = 0

  let dirUsed = 0
  let dirBalance = 0
  let dirTotal = 0

  const pkgNames = []

  const items = Array.isArray(detailJson && detailJson.items) ? detailJson.items : []
  for (const group of items) {
    if (!group || group.offerType === 19) continue
    if (group.productOFFName && !pkgNames.includes(group.productOFFName)) {
      pkgNames.push(group.productOFFName)
    }
    const subItems = Array.isArray(group.items) ? group.items : []
    for (const it of subItems) {
      if (!it) continue
      const unitTypeId = String(it.unitTypeId != null ? it.unitTypeId : '')
      const unit = String(it.unit != null ? it.unit : '')
      const t = String(it.ratableResourceType != null ? it.ratableResourceType : '')
      const name = String(it.ratableResourcename || '')
      const used = toNum(it.usageAmount)
      const bal = toNum(it.balanceAmount)
      const tot = toNum(it.ratableAmount)
      const isInvalid = String(it.balanceAmount) === '999999999999'

      if (unitTypeId === '3' || unit === '1') {
        const isDirect = SPECIAL_TYPES.has(t) || /定向|专用|专属|免流/.test(name)
        if (!(used === 0 && bal === 0) && !isInvalid) {
          if (isDirect) {
            dirTotal += tot
            dirBalance += bal
          } else {
            flowTotal += tot
            flowBalance += bal
          }
        }
        if (isDirect) dirUsed += used
        else flowUsed += used
      } else if (unitTypeId === '1' || unit === '0' || t === '11' || /语音|通话|分钟/.test(name)) {
        if (!(detailJson && detailJson.voiceBalance)) {
          voiceUsage += used
          voiceBalance += bal
          voiceTotal += tot
        }
      }
    }
  }

  if (detailJson && detailJson.voiceAmount && detailJson.voiceBalance) {
    voiceTotal = toNum(detailJson.voiceAmount)
    voiceBalance = toNum(detailJson.voiceBalance)
    voiceUsage = Math.max(0, voiceTotal - voiceBalance)
  } else if (voiceTotal === 0 && (voiceBalance > 0 || voiceUsage > 0)) {
    voiceTotal = voiceBalance + voiceUsage
  } else if (voiceUsage === 0 && voiceTotal > voiceBalance) {
    voiceUsage = Math.max(0, voiceTotal - voiceBalance)
  }

  const rawBal =
    balanceJson && balanceJson.totalBalanceAvailable !== undefined
      ? balanceJson.totalBalanceAvailable
      : balanceJson && balanceJson.balanceAvailable
  const feeNum = Number(rawBal)
  // 兼容分(如 5280 -> 52.80)与元小数(如 "52.80")
  const feeYuan =
    Number.isFinite(feeNum) && !String(rawBal).includes('.') ? (feeNum / 100).toFixed(2) : fmtNum(rawBal, 2)

  return {
    feeBalance: feeYuan,
    voiceBalance: Math.round(voiceBalance),
    voiceUsage: Math.round(voiceUsage),
    voiceTotal: Math.round(voiceTotal),
    flowUsed,
    flowBalance,
    flowTotal: flowTotal || flowUsed + flowBalance,
    dirUsed,
    dirBalance,
    dirTotal: dirTotal || dirUsed + dirBalance,
    hasDir: dirUsed > 0 || dirBalance > 0 || dirTotal > 0,
    pkgName: pkgNames[0] || '',
    updatedAt: Date.now(),
  }
}

async function getTelecomData(forceRefresh = false) {
  const s = settings()
  const phone = String(s.phone || '').trim()
  const password = String(s.password || '').trim()
  const androidId = String(s.androidId || '').trim()
  const loginUrl = String(s.loginUrl || '').trim()
  let cookie = String(s.cookie || '').trim()

  const useAppChannel = !!(phone && password && androidId)
  const cached = getStoreJSON('cache', null)

  if (!useAppChannel && !cookie && !loginUrl) {
    return {
      data: cached,
      fromCache: !!cached,
      expired: false,
      noCreds: true,
      channel: 'none',
      errMsg: '未配置电信账号或 Cookie',
    }
  }

  try {
    if (useAppChannel) {
      const parsed = await fetchViaAppChannel(phone, password, androidId, forceRefresh)
      setStoreJSON('cache', parsed)
      return { data: parsed, fromCache: false, expired: false, noCreds: false, channel: 'app' }
    } else {
      if (!cookie && loginUrl) {
        cookie = await refreshCookieByUrl(loginUrl, cookie)
      }
      let detailJson, balanceJson
      try {
        ;[detailJson, balanceJson] = await Promise.all([
          httpGetJson(URLS.detail, cookie),
          httpGetJson(URLS.balance, cookie),
        ])
      } catch (firstErr) {
        if (loginUrl) {
          cookie = await refreshCookieByUrl(loginUrl, cookie)
          ;[detailJson, balanceJson] = await Promise.all([
            httpGetJson(URLS.detail, cookie),
            httpGetJson(URLS.balance, cookie),
          ])
        } else {
          throw firstErr
        }
      }
      const parsed = parseTelecom(detailJson, balanceJson)
      parsed.channel = 'cookie'
      setStoreJSON('cache', parsed)
      return { data: parsed, fromCache: false, expired: false, noCreds: false, channel: 'cookie' }
    }
  } catch (e) {
    const msg = String((e && e.message) || e || '')
    const isExpired =
      msg.includes('COOKIE_EXPIRED') ||
      msg.includes('登录失败') ||
      msg.includes('resultCode=') ||
      msg.includes('App登录失败')
    return {
      data: cached,
      fromCache: !!cached,
      expired: isExpired,
      noCreds: false,
      channel: useAppChannel ? 'app' : 'cookie',
      errMsg: msg,
    }
  }
}

/* ================= 主题配色与透明背景裁切引擎 ================= */

const dynColor = (lightHex, darkHex) => Color.dynamic(new Color(lightHex), new Color(darkHex))

function normalizeFamily(family) {
  if (family === 'small' || family === 'systemSmall') return 'small'
  if (family === 'large' || family === 'systemLarge') return 'large'
  return 'medium'
}

function getBgFilePath(family) {
  const fm = FileManager.local()
  const norm = normalizeFamily(family)
  return fm.joinPath(fm.documentsDirectory(), `ct_bg_${norm}.jpg`)
}

function getCustomBgFilePath() {
  const fm = FileManager.local()
  return fm.joinPath(fm.documentsDirectory(), 'ct_bg_custom.jpg')
}

function hasTransparentBg(family) {
  const fm = FileManager.local()
  if (family && fm.fileExists(getBgFilePath(family))) return true
  return (
    fm.fileExists(getBgFilePath('medium')) ||
    fm.fileExists(getBgFilePath('small')) ||
    fm.fileExists(getBgFilePath('large')) ||
    fm.fileExists(getCustomBgFilePath())
  )
}

function resolveThemeColor(lightCardHex, darkCardHex, transLightTextHex, transDarkTextHex) {
  if (!hasTransparentBg()) {
    return dynColor(lightCardHex, darkCardHex)
  }
  const mode = (settings().bgTextMode || 'light').toLowerCase()
  const hiLight = transLightTextHex || darkCardHex
  const hiDark = transDarkTextHex || lightCardHex
  if (mode === 'dark') return new Color(hiDark)
  if (mode === 'auto') return dynColor(hiDark, hiLight)
  return new Color(hiLight)
}

const COLORS = {
  primary: () => resolveThemeColor('#000000', '#FFFFFF', '#FFFFFF', '#111827'),
  sub: () => {
    if (!hasTransparentBg()) {
      return Color.dynamic(new Color('#3C3C43', 0.6), new Color('#EBEBF5', 0.6))
    }
    const mode = (settings().bgTextMode || 'light').toLowerCase()
    if (mode === 'dark') return new Color('#1F2937', 0.85)
    return new Color('#EBEBF5', 0.78)
  },
  muted: () => {
    if (!hasTransparentBg()) {
      return Color.dynamic(new Color('#3C3C43', 0.6), new Color('#EBEBF5', 0.6))
    }
    const mode = (settings().bgTextMode || 'light').toLowerCase()
    if (mode === 'dark') return new Color('#374151', 0.8)
    return new Color('#EBEBF5', 0.72)
  },
  cardBg: () => {
    if (!hasTransparentBg()) {
      return Color.dynamic(new Color('#FFFFFF', 0.65), new Color('#FFFFFF', 0.1))
    }
    const mode = (settings().bgTextMode || 'light').toLowerCase()
    if (mode === 'dark') return new Color('#FFFFFF', 0.35)
    return new Color('#FFFFFF', 0.12)
  },
  fee: () => resolveThemeColor('#FF9F0A', '#FF9F0A', '#FFB340', '#D97706'),
  flow: () => resolveThemeColor('#0A84FF', '#0A84FF', '#409CFF', '#0284C7'),
  dir: () => resolveThemeColor('#0091FF', '#64D2FF', '#64D2FF', '#0284C7'),
  voice: () => resolveThemeColor('#30D158', '#30D158', '#30D158', '#16A34A'),
  ok: () => new Color('#30D158'),
  warn: () => new Color('#FF453A'),
  danger: () => new Color('#FF453A'),
}

const BG_DEVICE_MAP = {
  2868: { small: 510, medium: 1092, large: 1146, left: 78, right: 654, top: 270, middle: 912, bottom: 1554 },
  2796: { small: 510, medium: 1092, large: 1146, left: 99, right: 681, top: 282, middle: 918, bottom: 1554 },
  2778: { small: 510, medium: 1092, large: 1146, left: 96, right: 678, top: 246, middle: 882, bottom: 1518 },
  2688: { small: 507, medium: 1080, large: 1137, left: 81, right: 654, top: 228, middle: 858, bottom: 1488 },
  2622: { small: 486, medium: 1032, large: 1098, left: 87, right: 633, top: 261, middle: 873, bottom: 1485 },
  2556: { small: 474, medium: 1014, large: 1062, left: 82, right: 622, top: 270, middle: 858, bottom: 1446 },
  2532: { small: 474, medium: 1014, large: 1062, left: 78, right: 618, top: 231, middle: 819, bottom: 1407 },
  2436: { small: 465, medium: 987, large: 1035, left: 69, right: 591, top: 213, middle: 783, bottom: 1353 },
  1792: { small: 338, medium: 720, large: 758, left: 54, right: 436, top: 160, middle: 580, bottom: 1000 },
  2208: { small: 471, medium: 1044, large: 1071, left: 99, right: 672, top: 114, middle: 696, bottom: 1278 },
  1334: { small: 296, medium: 642, large: 648, left: 54, right: 400, top: 60, middle: 412, bottom: 764 },
  1136: { small: 282, medium: 584, large: 622, left: 30, right: 332, top: 59, middle: 399, bottom: 739 },
}

function applyOverlayToImage(img, w, h, overlayMode) {
  const dc = new DrawContext()
  dc.size = new Size(w, h)
  dc.opaque = false
  dc.drawImageInRect(img, new Rect(0, 0, w, h))
  if (overlayMode === 'light') {
    dc.setFillColor(new Color('#FFFFFF', 0.22))
    dc.fillRect(new Rect(0, 0, w, h))
  } else if (overlayMode === 'dark') {
    dc.setFillColor(new Color('#0D1624', 0.28))
    dc.fillRect(new Rect(0, 0, w, h))
  }
  return dc.getImage()
}

function cropWallpaperForWidget(img, family, posKey, overlayMode = 'none') {
  const imgW = img.size.width
  const imgH = img.size.height
  const spec = BG_DEVICE_MAP[imgH] || {
    small: Math.round(imgW * 0.395),
    medium: Math.round(imgW * 0.846),
    large: Math.round(imgH * 0.41),
    left: Math.round(imgW * 0.077),
    right: Math.round(imgW * 0.528),
    top: Math.round(imgH * 0.1),
    middle: Math.round(imgH * 0.328),
    bottom: Math.round(imgH * 0.556),
  }

  let x = spec.left
  let y = spec.top
  let w = spec.medium
  let h = spec.small

  const norm = normalizeFamily(family)
  if (norm === 'small') {
    w = spec.small
    h = spec.small
    x = posKey.includes('right') ? spec.right : spec.left
    if (posKey.includes('middle')) y = spec.middle
    else if (posKey.includes('bottom')) y = spec.bottom
    else y = spec.top
  } else if (norm === 'medium') {
    w = spec.medium
    h = spec.small
    x = spec.left
    if (posKey === 'middle') y = spec.middle
    else if (posKey === 'bottom') y = spec.bottom
    else y = spec.top
  } else {
    w = spec.medium
    h = spec.large
    x = spec.left
    y = posKey === 'bottom' ? spec.middle : spec.top
  }

  const dc = new DrawContext()
  dc.size = new Size(w, h)
  dc.opaque = false
  dc.drawImageAtPoint(img, new Point(-x, -y))
  if (overlayMode === 'light') {
    dc.setFillColor(new Color('#FFFFFF', 0.22))
    dc.fillRect(new Rect(0, 0, w, h))
  } else if (overlayMode === 'dark') {
    dc.setFillColor(new Color('#0D1624', 0.28))
    dc.fillRect(new Rect(0, 0, w, h))
  }
  return dc.getImage()
}

function applyWidgetBackground(widget, family = 'medium') {
  const fm = FileManager.local()
  const norm = normalizeFamily(family)
  const bgPath = getBgFilePath(norm)
  if (fm.fileExists(bgPath)) {
    widget.backgroundImage = fm.readImage(bgPath)
    return
  }
  if (fm.fileExists(getCustomBgFilePath())) {
    widget.backgroundImage = fm.readImage(getCustomBgFilePath())
    return
  }
  for (const fallback of ['medium', 'small', 'large']) {
    const p = getBgFilePath(fallback)
    if (fm.fileExists(p)) {
      widget.backgroundImage = fm.readImage(p)
      return
    }
  }
  const grad = new LinearGradient()
  grad.colors = [
    dynColor('#EAF3FF', '#0B1A33'),
    dynColor('#F4F0FF', '#120B24'),
    dynColor('#E9FBF3', '#03140F'),
  ]
  grad.locations = [0, 0.55, 1]
  grad.startPoint = new Point(0, 0)
  grad.endPoint = new Point(1, 1)
  widget.backgroundGradient = grad
}

/* ================= Scriptable 原生 UI 渲染工具 ================= */

function addText(parent, str, opts = {}) {
  const t = parent.addText(String(str))
  const size = opts.size || 11
  if (opts.monospaced && opts.weight === 'bold') {
    t.font = Font.boldMonospacedSystemFont(size)
  } else if (opts.monospaced) {
    t.font = Font.regularMonospacedSystemFont(size)
  } else if (opts.rounded && opts.weight === 'bold') {
    t.font = Font.boldRoundedSystemFont(size)
  } else if (opts.weight === 'bold') {
    t.font = Font.boldSystemFont(size)
  } else if (opts.weight === 'semibold') {
    t.font = Font.semiboldSystemFont(size)
  } else if (opts.weight === 'medium') {
    t.font = Font.mediumSystemFont(size)
  } else {
    t.font = Font.systemFont(size)
  }
  if (opts.color) t.textColor = opts.color
  t.lineLimit = opts.lineLimit != null ? opts.lineLimit : 1
  if (opts.minScale) t.minimumScaleFactor = opts.minScale
  if (hasTransparentBg()) {
    const mode = (settings().bgTextMode || 'light').toLowerCase()
    if (mode === 'dark') {
      t.shadowColor = new Color('#FFFFFF', 0.55)
      t.shadowRadius = 2
      t.shadowOffset = new Point(0, 0.8)
    } else {
      t.shadowColor = new Color('#000000', 0.52)
      t.shadowRadius = 2.5
      t.shadowOffset = new Point(0, 1)
    }
  }
  return t
}

function addSymbol(parent, name, size, tintColor) {
  try {
    const sym = SFSymbol.named(name) || SFSymbol.named('circle.fill')
    if (!sym) return null
    sym.applyFont(Font.systemFont(size))
    const img = parent.addImage(sym.image)
    img.imageSize = new Size(size + 2, size + 2)
    if (tintColor) img.tintColor = tintColor
    return img
  } catch (_) {
    return null
  }
}

function drawProgressBar(width, height, ratio, trackHex, fillHex) {
  const scale = 2
  const w = Math.max(4, Math.round(width * scale))
  const h = Math.max(2, Math.round(height * scale))
  const r = h / 2
  const dc = new DrawContext()
  dc.size = new Size(w, h)
  dc.opaque = false
  dc.respectScreenScale = true

  const trackPath = new Path()
  trackPath.addRoundedRect(new Rect(0, 0, w, h), r, r)
  dc.addPath(trackPath)
  dc.setFillColor(new Color(trackHex))
  dc.fillPath()

  if (ratio != null && ratio > 0) {
    const fw = Math.max(h, Math.min(w, Math.round(w * ratio)))
    const fillPath = new Path()
    fillPath.addRoundedRect(new Rect(0, 0, fw, h), r, r)
    dc.addPath(fillPath)
    dc.setFillColor(new Color(fillHex))
    dc.fillPath()
  }
  return dc.getImage()
}

function fmtMB(mb) {
  if (mb == null || !Number.isFinite(mb)) return '--'
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(0)} MB`
}

function getUsageInsights(data, showDir = true) {
  const now = new Date()
  const p = n => String(n).padStart(2, '0')
  const dayKey = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
  const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const daysLeft = Math.max(1, dim - now.getDate() + 1)

  const genBalMB = toNum(data && data.flowBalance) / 1024
  const dirBalMB = showDir ? toNum(data && data.dirBalance) / 1024 : 0
  const flowMB = Math.max(0, genBalMB + dirBalMB)

  let snap = getStoreJSON('day_snap', null)
  if (!snap || snap.date !== dayKey || flowMB > toNum(snap.start) + 1) {
    snap = { date: dayKey, start: flowMB }
    setStoreJSON('day_snap', snap)
  }
  const todayMB = Math.max(0, toNum(snap.start) - flowMB)

  const h = getStoreJSON('day_hist', {}) || {}
  h[dayKey] = todayMB
  const keep = {}
  const hist = []
  for (let i = 7; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000)
    const k = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    if (h[k] != null) keep[k] = h[k]
    if (i <= 6) hist.push(h[k] == null ? null : h[k])
  }
  setStoreJSON('day_hist', keep)

  let forecast = { text: '用量统计中…', color: COLORS.sub() }
  const past = hist.slice(0, 6).filter(v => v != null && v > 0)
  const vals = past.length ? past : todayMB > 0 ? [todayMB] : []
  if (vals.length) {
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length
    const days = Math.floor(flowMB / avg)
    forecast =
      days >= daysLeft
        ? { text: days > 999 ? '按近期速度 充足' : `预计够用 ${days} 天 ✓`, color: COLORS.voice() }
        : { text: `约 ${days} 天用完 · 早于月底`, color: COLORS.fee() }
  }

  const feeNum = parseFloat(data && data.feeBalance)
  return {
    hist,
    forecast,
    daysLeft,
    todayMB,
    dailyMB: flowMB / daysLeft,
    lowFee: Number.isFinite(feeNum) && feeNum < 10,
  }
}

function drawHalfGauge(pct, colorHex, width = 64) {
  const scale = 2
  const w = width * scale
  const stroke = 12 * scale
  const h = Math.round((width / 2 + 6) * scale)
  const r = (w - stroke) / 2
  const cx = w / 2
  const cy = w / 2

  const dc = new DrawContext()
  dc.size = new Size(w, h)
  dc.opaque = false
  dc.respectScreenScale = true

  const steps = 72
  const p = Math.max(0, Math.min(1, Number(pct) || 0))
  const dotR = stroke / 2

  dc.setFillColor(new Color(colorHex, 0.22))
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI
    const x = cx - r * Math.cos(a)
    const y = cy - r * Math.sin(a)
    dc.fillEllipse(new Rect(x - dotR, y - dotR, stroke, stroke))
  }

  if (p > 0.005) {
    dc.setFillColor(new Color(colorHex, 1))
    const pSteps = Math.max(1, Math.round(steps * p))
    for (let i = 0; i <= pSteps; i++) {
      const a = (i / steps) * Math.PI
      const x = cx - r * Math.cos(a)
      const y = cy - r * Math.sin(a)
      dc.fillEllipse(new Rect(x - dotR, y - dotR, stroke, stroke))
    }
  }

  return dc.getImage()
}

function drawSparkBars(values, colorHex, width = 70, height = 14) {
  const scale = 2
  const w = width * scale
  const h = height * scale
  const vals = values && values.length ? values : [null, null, null, null, null, null, null]
  const n = vals.length
  const gap = 3 * scale
  const bw = (w - gap * (n - 1)) / n
  const max = Math.max(1, ...vals.map(v => v || 0))

  const dc = new DrawContext()
  dc.size = new Size(w, h)
  dc.opaque = false
  dc.respectScreenScale = true

  vals.forEach((v, i) => {
    const bh = v ? Math.max(2 * scale, (v / max) * h) : 2 * scale
    const op = v == null ? 0.15 : i === n - 1 ? 1 : 0.55
    const x = i * (bw + gap)
    const y = h - bh
    const rx = Math.min(2 * scale, bw / 2)
    const path = new Path()
    path.addRoundedRect(new Rect(x, y, bw, bh), rx, rx)
    dc.addPath(path)
    dc.setFillColor(new Color(colorHex, op))
    dc.fillPath()
  })

  return dc.getImage()
}

function getDisplayMetrics(data) {
  const s = settings()
  const showUsed = !!s.showUsedFlow
  const showDirOpt = String(s.showDirect || 'auto').toLowerCase()
  const showDir = showDirOpt === 'false' ? false : showDirOpt === 'true' ? true : !!data.hasDir

  const flowPrimary = fmtFlow(showUsed ? data.flowUsed : data.flowBalance)
  const flowTotal = fmtFlow(data.flowTotal)
  const flowSub = showUsed
    ? `剩 ${fmtFlow(data.flowBalance).value}${fmtFlow(data.flowBalance).unit}`
    : `共 ${flowTotal.value}${flowTotal.unit}`
  const flowPct =
    data.flowTotal > 0
      ? Math.max(0, Math.min(1, (showUsed ? data.flowUsed : data.flowBalance) / data.flowTotal))
      : 0

  const dirPrimary = fmtFlow(showUsed ? data.dirUsed : data.dirBalance)
  const dirTotal = fmtFlow(data.dirTotal)
  const dirSub = showUsed
    ? `剩 ${fmtFlow(data.dirBalance).value}${fmtFlow(data.dirBalance).unit}`
    : `共 ${dirTotal.value}${dirTotal.unit}`
  const dirPct =
    data.dirTotal > 0
      ? Math.max(0, Math.min(1, (showUsed ? data.dirUsed : data.dirBalance) / data.dirTotal))
      : 0

  const voicePrimary = showUsed ? data.voiceUsage : data.voiceBalance
  const voiceSub = showUsed ? `剩 ${data.voiceBalance} 分钟` : `共 ${data.voiceTotal} 分钟`
  const voicePct =
    data.voiceTotal > 0
      ? Math.max(0, Math.min(1, (showUsed ? data.voiceUsage : data.voiceBalance) / data.voiceTotal))
      : 0

  return {
    showUsed,
    showDir,
    flowPrimary,
    flowTotal,
    flowSub,
    flowPct,
    dirPrimary,
    dirTotal,
    dirSub,
    dirPct,
    voicePrimary,
    voiceSub,
    voicePct,
  }
}

function addHeader(w, state, compact = false, rightCustomText = null) {
  const s = settings()
  const { data, fromCache, expired, channel } = state
  const row = w.addStack()
  row.layoutHorizontally()
  row.centerAlignContent()

  addSymbol(row, 'antenna.radiowaves.left.and.right', compact ? 11 : 12, COLORS.flow())
  row.addSpacer(4)
  addText(row, s.title || '中国电信', {
    size: compact ? 11.5 : 13,
    weight: 'semibold',
    color: COLORS.primary(),
    minScale: 0.75,
  })
  row.addSpacer()

  if (rightCustomText != null) {
    addText(row, rightCustomText.text, {
      size: rightCustomText.size || 11,
      weight: rightCustomText.weight || 'bold',
      color: rightCustomText.color || COLORS.fee(),
      minScale: 0.8,
    })
  } else if (!compact) {
    const statusText = expired
      ? channel === 'app'
        ? '⚠️ App登录失效'
        : '⚠️ 登录失效，点我重登'
      : `${fromCache ? '缓存 · ' : ''}更新 ${fmtTime(data && data.updatedAt)}`
    addText(row, statusText, {
      size: 10,
      weight: expired ? 'semibold' : 'regular',
      color: expired ? COLORS.danger() : COLORS.sub(),
      minScale: 0.8,
    })
  }
}

function drawFeeIcon(colorHex, low = false) {
  const s = 40
  const dc = new DrawContext()
  dc.size = new Size(s, s)
  dc.opaque = false
  dc.respectScreenScale = true

  dc.setFillColor(new Color(colorHex, 1))
  dc.fillEllipse(new Rect(2, 2, s - 4, s - 4))

  dc.setFont(Font.boldRoundedSystemFont(23))
  dc.setTextColor(Color.white())
  dc.setTextAlignedCenter()
  dc.drawTextInRect(low ? '!' : '¥', new Rect(0, 6, s, s - 6))
  return dc.getImage()
}

function getMediumInnerWidth() {
  try {
    const scr = Device.screenSize()
    const sw = Math.min(scr.width, scr.height)
    const widgetW = sw >= 428 ? 364 : sw >= 414 ? 348 : sw >= 390 ? 338 : sw >= 375 ? 329 : 292
    return widgetW - 22
  } catch (_) {
    return 316
  }
}

function addFeeGlassCard(parent, data, ins, opts = {}) {
  const width = opts.width || 86
  const height = opts.height || 82
  const numSize = opts.numSize || 22
  const low = ins.lowFee
  const hPad = opts.centerAlign !== false ? 2 : 8

  const card = parent.addStack()
  card.layoutVertically()
  if (width || height) card.size = new Size(width, height)
  card.backgroundColor = COLORS.cardBg()
  card.cornerRadius = 16
  card.setPadding(7, hPad, 7, hPad)

  const topRow = card.addStack()
  topRow.layoutHorizontally()
  topRow.centerAlignContent()
  if (opts.centerAlign !== false) topRow.addSpacer()
  const fImg = topRow.addImage(drawFeeIcon(low ? '#FF453A' : '#FF9F0A', low))
  fImg.imageSize = new Size(11, 11)
  topRow.addSpacer(3)
  addText(topRow, low ? '话费不足' : '剩余话费', {
    size: 9,
    weight: 'medium',
    color: low ? COLORS.danger() : COLORS.sub(),
    minScale: 0.8,
  })
  topRow.addSpacer()

  card.addSpacer()

  const valWrap = card.addStack()
  valWrap.layoutHorizontally()
  valWrap.bottomAlignContent()
  if (opts.centerAlign !== false) valWrap.addSpacer()
  addText(valWrap, '¥', {
    size: 11.5,
    weight: 'semibold',
    color: low ? COLORS.danger() : COLORS.sub(),
    minScale: 0.7,
  })
  valWrap.addSpacer(1)
  addText(valWrap, String(data.feeBalance), {
    size: numSize,
    weight: 'bold',
    rounded: true,
    color: low ? COLORS.danger() : COLORS.primary(),
    minScale: 0.5,
  })
  valWrap.addSpacer()

  card.addSpacer()

  const botRow = card.addStack()
  botRow.layoutHorizontally()
  if (opts.centerAlign !== false) botRow.addSpacer()
  addText(botRow, `本月剩 ${ins.daysLeft} 天`, {
    size: 9,
    weight: 'medium',
    color: COLORS.sub(),
    minScale: 0.75,
  })
  botRow.addSpacer()

  return card
}

function addGaugeGlassCard(parent, opts) {
  const { icon, colorHex, colorObj, title, number, unit, pct, width, height, gw = 46, numSize = 14.5 } = opts
  const card = parent.addStack()
  card.layoutVertically()
  if (width || height) card.size = new Size(width || 0, height || 82)
  card.backgroundColor = COLORS.cardBg()
  card.cornerRadius = 16
  card.setPadding(7, 4, 7, 4)

  const topRow = card.addStack()
  topRow.layoutHorizontally()
  topRow.centerAlignContent()
  topRow.addSpacer()
  addSymbol(topRow, icon, 10, colorObj)
  topRow.addSpacer(3)
  addText(topRow, title, {
    size: 9,
    weight: 'medium',
    color: COLORS.sub(),
    minScale: 0.8,
  })
  topRow.addSpacer()

  card.addSpacer(2)

  const gh = Math.round((gw * 38) / 64)
  const gRow = card.addStack()
  gRow.layoutHorizontally()
  gRow.addSpacer()
  const gImg = gRow.addImage(drawHalfGauge(pct, colorHex, 64))
  gImg.imageSize = new Size(gw, gh)
  gRow.addSpacer()

  const pctVal = pct > 0 ? Math.round(pct * 100) : 0
  const pRow = card.addStack()
  pRow.layoutHorizontally()
  pRow.addSpacer()
  addText(pRow, `${pctVal}%`, {
    size: 9,
    weight: 'bold',
    color: colorObj,
    minScale: 0.8,
  })
  pRow.addSpacer()

  card.addSpacer(1)

  const valRow = card.addStack()
  valRow.layoutHorizontally()
  valRow.bottomAlignContent()
  valRow.addSpacer()
  addText(valRow, String(number), {
    size: numSize,
    weight: 'bold',
    rounded: true,
    color: COLORS.primary(),
    minScale: 0.6,
  })
  if (unit) {
    valRow.addSpacer(2)
    addText(valRow, unit, {
      size: 9,
      weight: 'semibold',
      color: COLORS.sub(),
      minScale: 0.75,
    })
  }
  valRow.addSpacer()

  return card
}

function addStatsStrip(parent, ins, sparkW = 40) {
  const strip = parent.addStack()
  strip.layoutHorizontally()
  strip.centerAlignContent()
  strip.backgroundColor = COLORS.cardBg()
  strip.cornerRadius = 12
  strip.setPadding(6, 9, 6, 9)

  const sImg = strip.addImage(drawSparkBars(ins.hist, '#0A84FF', 70, 14))
  sImg.imageSize = new Size(sparkW, 11)
  strip.addSpacer(6)

  addText(strip, `今日 ${fmtMB(ins.todayMB)}`, {
    size: 9,
    weight: 'semibold',
    color: COLORS.primary(),
    minScale: 0.8,
  })
  strip.addSpacer(6)

  addText(strip, `日均可用 ${fmtMB(ins.dailyMB)}`, {
    size: 9,
    weight: 'medium',
    color: COLORS.sub(),
    minScale: 0.75,
  })
  strip.addSpacer()

  addText(strip, ins.forecast.text, {
    size: 9,
    weight: 'semibold',
    color: ins.forecast.color,
    minScale: 0.75,
  })
  return strip
}

function buildMedium(w, state) {
  const { data } = state
  const m = getDisplayMetrics(data)
  const ins = getUsageInsights(data, m.showDir)

  w.setPadding(10, 11, 10, 11)
  addHeader(w, state, false)
  w.addSpacer(6)

  const row = w.addStack()
  row.layoutHorizontally()
  row.centerAlignContent()

  const fourCards = m.showDir
  const innerW = getMediumInnerWidth()
  // 与 Egern 保持一致：4卡模式下「剩余话费」卡片更宽（约占28%宽度，~88pt），其余3张仪表卡均分剩余宽度
  const feeW = fourCards ? Math.max(86, Math.round(innerW * 0.278)) : Math.floor((innerW - 12) / 3)
  const gaugeW = fourCards
    ? Math.floor((innerW - feeW - 18) / 3)
    : Math.floor((innerW - feeW - 12) / 2)

  addFeeGlassCard(row, data, ins, {
    width: feeW,
    height: 82,
    numSize: fourCards ? 20.5 : 24,
    centerAlign: true,
  })
  row.addSpacer()

  addGaugeGlassCard(row, {
    icon: 'wifi',
    colorHex: '#0A84FF',
    colorObj: COLORS.flow(),
    title: m.showUsed ? '已用流量' : '剩余流量',
    number: m.flowPrimary.value,
    unit: m.flowPrimary.unit,
    pct: m.flowPct,
    width: gaugeW,
    height: 82,
    gw: fourCards ? 44 : 50,
    numSize: fourCards ? 15 : 16.5,
  })

  if (fourCards) {
    row.addSpacer()
    addGaugeGlassCard(row, {
      icon: 'globe.asia.australia.fill',
      colorHex: '#64D2FF',
      colorObj: COLORS.dir(),
      title: m.showUsed ? '已用其他' : '其他流量',
      number: m.dirPrimary.value,
      unit: m.dirPrimary.unit,
      pct: m.dirPct,
      width: gaugeW,
      height: 82,
      gw: 44,
      numSize: 15,
    })
  }

  row.addSpacer()
  addGaugeGlassCard(row, {
    icon: 'phone.fill',
    colorHex: '#30D158',
    colorObj: COLORS.voice(),
    title: m.showUsed ? '已用语音' : '剩余语音',
    number: m.voicePrimary,
    unit: '分钟',
    pct: m.voicePct,
    width: gaugeW,
    height: 82,
    gw: fourCards ? 44 : 50,
    numSize: fourCards ? 15 : 16.5,
  })

  w.addSpacer(6)
  addStatsStrip(w, ins, 42)
}

function buildSmall(w, state) {
  const { data } = state
  const m = getDisplayMetrics(data)
  const ins = getUsageInsights(data, m.showDir)

  w.setPadding(12, 12, 12, 12)
  addHeader(w, state, true, {
    text: `¥${data.feeBalance}`,
    size: 11,
    weight: 'bold',
    color: ins.lowFee ? COLORS.danger() : COLORS.fee(),
  })
  w.addSpacer(5)

  const midRow = w.addStack()
  midRow.layoutHorizontally()
  midRow.centerAlignContent()

  const leftCol = midRow.addStack()
  leftCol.layoutVertically()
  addText(leftCol, m.showUsed ? '已用流量' : '剩余流量', {
    size: 9,
    weight: 'medium',
    color: COLORS.sub(),
  })
  leftCol.addSpacer(1)
  const flowValRow = leftCol.addStack()
  flowValRow.layoutHorizontally()
  flowValRow.bottomAlignContent()
  addText(flowValRow, String(m.flowPrimary.value), {
    size: 21,
    weight: 'bold',
    rounded: true,
    color: COLORS.primary(),
    minScale: 0.6,
  })
  flowValRow.addSpacer(2)
  addText(flowValRow, m.flowPrimary.unit, {
    size: 9,
    weight: 'semibold',
    color: COLORS.sub(),
  })

  midRow.addSpacer()

  const rightCol = midRow.addStack()
  rightCol.layoutVertically()
  rightCol.centerAlignContent()
  const gImg = rightCol.addImage(drawHalfGauge(m.flowPct, '#0A84FF', 64))
  gImg.imageSize = new Size(42, 25)
  addText(rightCol, `${Math.round(m.flowPct * 100)}%`, {
    size: 9,
    weight: 'bold',
    color: COLORS.flow(),
  })

  w.addSpacer(5)

  const sparkRow = w.addStack()
  sparkRow.layoutHorizontally()
  sparkRow.bottomAlignContent()
  const sImg = sparkRow.addImage(drawSparkBars(ins.hist, '#0A84FF', 70, 14))
  sImg.imageSize = new Size(44, 11)
  sparkRow.addSpacer(5)
  addText(sparkRow, `今日 ${fmtMB(ins.todayMB)}`, {
    size: 9,
    weight: 'semibold',
    color: COLORS.primary(),
  })

  w.addSpacer(3)
  const subInfo = m.showDir
    ? `其他 ${m.dirPrimary.value}${m.dirPrimary.unit} · 语音 ${m.voicePrimary}分钟`
    : `语音 ${m.voicePrimary}分钟`
  addText(w, subInfo, {
    size: 9,
    weight: 'medium',
    color: COLORS.sub(),
    minScale: 0.75,
  })

  w.addSpacer(2)
  addText(w, `日均可用 ${fmtMB(ins.dailyMB)} · ${ins.forecast.text}`, {
    size: 9,
    weight: 'semibold',
    color: ins.forecast.color,
    minScale: 0.7,
  })
}

function buildLarge(w, state) {
  const { data } = state
  const m = getDisplayMetrics(data)
  const ins = getUsageInsights(data, m.showDir)
  const s = settings()
  const phone = String(s.phone || '').trim()
  const masked = /^\d{11}$/.test(phone)
    ? `${phone.slice(0, 3)} **** ${phone.slice(7)}`
    : data.pkgName || '中国电信套餐'

  w.setPadding(14, 14, 14, 14)
  addHeader(w, state, false)
  w.addSpacer(9)

  const topRow = w.addStack()
  topRow.layoutHorizontally()
  topRow.centerAlignContent()

  addFeeGlassCard(topRow, data, ins, {
    width: 146,
    height: 74,
    numSize: 28,
    centerAlign: false,
  })
  topRow.addSpacer(8)

  const infoCard = topRow.addStack()
  infoCard.layoutVertically()
  infoCard.size = new Size(146, 74)
  infoCard.backgroundColor = COLORS.cardBg()
  infoCard.cornerRadius = 16
  infoCard.setPadding(9, 12, 9, 12)
  addText(infoCard, /^\d{11}$/.test(phone) ? '当前号码' : '当前套餐', {
    size: 9,
    weight: 'medium',
    color: COLORS.sub(),
  })
  infoCard.addSpacer(2)
  addText(infoCard, masked, {
    size: 13,
    weight: 'semibold',
    monospaced: /^\d{11}$/.test(phone),
    color: COLORS.primary(),
    minScale: 0.7,
  })
  infoCard.addSpacer()
  addText(infoCard, ins.forecast.text, {
    size: 10,
    weight: 'semibold',
    color: ins.forecast.color,
    minScale: 0.7,
  })

  w.addSpacer(9)

  const gaugeRow = w.addStack()
  gaugeRow.layoutHorizontally()
  gaugeRow.centerAlignContent()

  addGaugeGlassCard(gaugeRow, {
    icon: 'wifi',
    colorHex: '#0A84FF',
    colorObj: COLORS.flow(),
    title: m.showUsed ? '已用流量' : '剩余流量',
    number: m.flowPrimary.value,
    unit: m.flowPrimary.unit,
    pct: m.flowPct,
    width: 95,
    height: 92,
    gw: 58,
    numSize: 16.5,
  })
  gaugeRow.addSpacer(8)

  addGaugeGlassCard(gaugeRow, {
    icon: 'globe.asia.australia.fill',
    colorHex: '#64D2FF',
    colorObj: COLORS.dir(),
    title: m.showUsed ? '已用其他' : '其他流量',
    number: m.dirPrimary.value,
    unit: m.dirPrimary.unit,
    pct: m.dirPct,
    width: 95,
    height: 92,
    gw: 58,
    numSize: 16.5,
  })
  gaugeRow.addSpacer(8)

  addGaugeGlassCard(gaugeRow, {
    icon: 'phone.fill',
    colorHex: '#30D158',
    colorObj: COLORS.voice(),
    title: m.showUsed ? '已用语音' : '剩余语音',
    number: m.voicePrimary,
    unit: '分钟',
    pct: m.voicePct,
    width: 95,
    height: 92,
    gw: 58,
    numSize: 16.5,
  })

  w.addSpacer(9)

  const chartCard = w.addStack()
  chartCard.layoutVertically()
  chartCard.backgroundColor = COLORS.cardBg()
  chartCard.cornerRadius = 16
  chartCard.setPadding(9, 12, 9, 12)

  const chartHead = chartCard.addStack()
  chartHead.layoutHorizontally()
  chartHead.centerAlignContent()
  addSymbol(chartHead, 'chart.bar.fill', 10, COLORS.flow())
  chartHead.addSpacer(4)
  addText(chartHead, '近 7 天流量', {
    size: 10,
    weight: 'semibold',
    color: COLORS.primary(),
  })
  chartHead.addSpacer()
  addText(chartHead, `今日 ${fmtMB(ins.todayMB)} · 日均可用 ${fmtMB(ins.dailyMB)}`, {
    size: 9,
    weight: 'medium',
    color: COLORS.sub(),
    minScale: 0.8,
  })

  chartCard.addSpacer(6)
  const bigSpark = chartCard.addImage(drawSparkBars(ins.hist, '#0A84FF', 276, 38))
  bigSpark.imageSize = new Size(276, 38)
  chartCard.addSpacer(4)

  const labelRow = chartCard.addStack()
  labelRow.layoutHorizontally()
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000)
    const lbl = i === 0 ? '今' : `${d.getDate()}`
    const cell = labelRow.addStack()
    cell.layoutHorizontally()
    cell.addSpacer()
    addText(cell, lbl, { size: 8, weight: 'medium', color: COLORS.sub() })
    cell.addSpacer()
  }
}

function buildAccessory(w, state, family) {
  const { data } = state
  const m = getDisplayMetrics(data)
  const ins = getUsageInsights(data, m.showDir)
  if (family === 'accessoryInline') {
    addText(w, `¥${data.feeBalance} · ${m.flowPrimary.value}${m.flowPrimary.unit} · ${m.voicePrimary}分`, {
      size: 12,
      weight: 'medium',
      minScale: 0.6,
    })
    return
  }
  if (family === 'accessoryCircular') {
    w.addSpacer()
    addSymbol(w, 'antenna.radiowaves.left.and.right', 13)
    addText(w, `${m.flowPrimary.value}`, { size: 13, weight: 'bold', rounded: true })
    addText(w, m.flowPrimary.unit, { size: 8 })
    w.addSpacer()
    return
  }
  addText(w, `¥${data.feeBalance}${ins.lowFee ? ' · 话费不足' : ''}`, { size: 12, weight: 'bold' })
  w.addSpacer(2)
  addText(w, `流量 ${m.flowPrimary.value} ${m.flowPrimary.unit} · 语音 ${m.voicePrimary}分`, {
    size: 11,
    weight: 'semibold',
  })
  addText(
    w,
    ins.todayMB != null ? `今日 ${fmtMB(ins.todayMB)} · 日均 ${fmtMB(ins.dailyMB)}` : `还剩 ${ins.daysLeft} 天`,
    { size: 10.5 }
  )
}

function createEmptyWidget(state, family = 'medium') {
  const w = new ListWidget()
  applyWidgetBackground(w, family)
  w.setPadding(16, 16, 16, 16)
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000)

  const row = w.addStack()
  row.layoutHorizontally()
  row.centerAlignContent()
  addSymbol(row, 'exclamationmark.triangle.fill', 14, state.noCreds ? COLORS.warn() : COLORS.danger())
  row.addSpacer(6)
  addText(row, state.noCreds ? '未配置电信账号或 Cookie' : '电信登录已失效', {
    size: 14,
    weight: 'bold',
    color: COLORS.primary(),
  })

  w.addSpacer(6)
  addText(
    w,
    state.noCreds
      ? '请打开 Scriptable 点击「中国电信」脚本，配置手机号+服务密码+AndroidID 或网页登录提取 Cookie。'
      : `请打开 Scriptable 点击脚本重新登录或检查凭证（${state.errMsg || '会话过期'}）`,
    { size: 11, color: COLORS.muted(), lineLimit: 3 }
  )
  return w
}

function createTelecomWidget(state, family = 'medium') {
  if (!state || !state.data) {
    return createEmptyWidget(state || { noCreds: true }, family)
  }
  const w = new ListWidget()
  const mins = Math.max(5, Number(settings().refreshMinutes) || 30)
  w.refreshAfterDate = new Date(Date.now() + mins * 60 * 1000)
  if (state.expired && state.channel !== 'app') {
    w.url = URLS.login
  }
  if (family && String(family).startsWith('accessory')) {
    buildAccessory(w, state, family)
    return w
  }
  applyWidgetBackground(w, family)
  const norm = normalizeFamily(family)
  if (norm === 'small') buildSmall(w, state)
  else if (norm === 'large') buildLarge(w, state)
  else buildMedium(w, state)
  return w
}

/* ================= Scriptable App 内可视化设置与预览菜单 ================= */

async function promptField(title, message, placeholder, defaultValue, secure = false) {
  const a = new Alert()
  a.title = title
  a.message = message
  if (secure) {
    a.addSecureTextField(placeholder, defaultValue || '')
  } else {
    a.addTextField(placeholder, defaultValue || '')
  }
  a.addAction('保存')
  a.addCancelAction('取消')
  const idx = await a.presentAlert()
  if (idx === -1) return null
  return a.textFieldValue(0)
}

async function showAlert(title, message) {
  const a = new Alert()
  a.title = title
  a.message = String(message || '')
  a.addAction('确定')
  await a.presentAlert()
}

async function loginViaWebView() {
  const wv = new WebView()
  await wv.loadURL(URLS.detail)
  await wv.present(false)
  try {
    const docCookie = await wv.evaluateJavaScript('document.cookie || ""', false)
    if (docCookie && String(docCookie).trim()) {
      const merged = mergeCookies(settings().cookie, String(docCookie).trim())
      saveSettings({ cookie: merged })
      return merged
    }
  } catch (_) {}
  return ''
}

async function runInAppMenu() {
  let lastState = null
  let statusMsg = '支持 App 服务密码自动续期登录 & 网页 Cookie 双通道'

  const table = new UITable()
  table.showSeparators = true

  function renderTable() {
    table.removeAllRows()
    const s = settings()
    const hasAppCreds = !!(s.phone && s.password && s.androidId)
    const hasCookieCreds = !!(s.cookie || s.loginUrl)

    const titleRow = new UITableRow()
    titleRow.isHeader = true
    titleRow.height = 54
    const tCell = titleRow.addText('📡 中国电信小组件 (Scriptable)', statusMsg)
    tCell.titleFont = Font.boldSystemFont(17)
    tCell.subtitleFont = Font.systemFont(12)
    tCell.subtitleColor = Color.green()
    table.addRow(titleRow)

    const addOption = (title, subtitle, onSelect) => {
      const r = new UITableRow()
      r.height = 52
      r.dismissOnSelect = false
      const c = r.addText(title, subtitle)
      c.titleFont = Font.mediumSystemFont(15)
      c.subtitleFont = Font.systemFont(12)
      c.subtitleColor = Color.gray()
      r.onSelect = onSelect
      table.addRow(r)
    }

    addOption(
      '🔑 通道一：电信 App 账号设置（推荐 · 自动续期）',
      hasAppCreds
        ? `已配置：${s.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2')} · AndroidID: ${s.androidId.slice(0, 6)}...`
        : '点击配置手机号 + 6位服务密码 + 16位 AndroidID（优先使用此通道）',
      async () => {
        const a = new Alert()
        a.title = '配置电信 App 登录凭证'
        a.message =
          '填入手机号、6位服务密码及16位十六进制 AndroidID（如 98791a2e229591ab）。三项填齐后将走 App 接口并自动续期重登；留空保存可切回 Cookie 通道。'
        a.addTextField('11位电信手机号', s.phone || '')
        a.addSecureTextField('6位服务密码', s.password || '')
        a.addTextField('16位 AndroidID（纯16进制可随机填16位0-9a-f）', s.androidId || '')
        a.addAction('保存')
        a.addAction('🎲 自动生成16位 AndroidID 并保存')
        a.addCancelAction('取消')
        const idx = await a.presentAlert()
        if (idx === -1) return
        const phone = a.textFieldValue(0).trim()
        const password = a.textFieldValue(1).trim()
        let androidId = a.textFieldValue(2).trim()
        if (idx === 1 && !androidId) {
          androidId = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
        }
        saveSettings({ phone, password, androidId })
        setStore('app_token', '')
        setStore('app_phone', phone)
        statusMsg = phone && password && androidId ? 'App 登录凭证已保存，点击「立即刷新」可验证登录' : '已清空/更新 App 凭证'
        renderTable()
      }
    )

    addOption(
      '🍪 通道二：网页 Cookie / 登录 URL 设置',
      hasCookieCreds
        ? `Cookie: ${s.cookie ? '已配置(' + s.cookie.length + '字符)' : '未填'} · 登录URL: ${s.loginUrl ? '已配置' : '未填'}`
        : '点击粘贴 e.dlife.cn 的 Cookie、登录 URL，或使用内置网页登录',
      async () => {
        const m = new Alert()
        m.title = '网页 Cookie / 登录 URL 设置'
        m.message = '若未配置通道一（App密码），组件将使用此网页通道查询套餐与余额。'
        m.addAction('📋 手动粘贴 Cookie (e.dlife.cn)')
        m.addAction('🔗 粘贴自动续期登录 URL (CT_LOGIN_URL)')
        m.addAction('🌐 打开内置网页登录 e.dlife.cn (尝试提取非HttpOnly Cookie)')
        m.addDestructiveAction('🗑️ 清空网页 Cookie 与登录 URL')
        m.addCancelAction('取消')
        const idx = await m.presentSheet()
        if (idx === -1) return
        if (idx === 0) {
          const val = await promptField(
            '设置电信 Cookie',
            '请粘贴 https://e.dlife.cn/user/package_detail.do 请求头中的完整 Cookie',
            'JSESSIONID=...; ...',
            s.cookie
          )
          if (val != null) {
            saveSettings({ cookie: val.trim() })
            statusMsg = '网页 Cookie 已更新'
            renderTable()
          }
        } else if (idx === 1) {
          const val = await promptField(
            '设置登录握手 URL (CT_LOGIN_URL)',
            '可选：粘贴登录跳转时的完整 URL，当 Cookie 过期时脚本会自动请求该地址刷新 Set-Cookie',
            'https://e.dlife.cn/...',
            s.loginUrl
          )
          if (val != null) {
            saveSettings({ loginUrl: val.trim() })
            statusMsg = '登录握手 URL 已更新'
            renderTable()
          }
        } else if (idx === 2) {
          const got = await loginViaWebView()
          statusMsg = got ? `已从网页提取 Cookie (${got.length} 字符)` : '网页已关闭（若核心会话为 HttpOnly 建议用通道一或抓包粘贴）'
          renderTable()
        } else if (idx === 3) {
          saveSettings({ cookie: '', loginUrl: '' })
          statusMsg = '已清空网页 Cookie 与登录 URL'
          renderTable()
        }
      }
    )

    const dirModeLabel =
      s.showDirect === 'true' ? '强制4卡(含定向)' : s.showDirect === 'false' ? '强制3卡(隐藏定向)' : '自动(有定向才显示)'
    const refMins = Math.max(5, Number(s.refreshMinutes) || 30)

    addOption(
      '⚙️ 卡片显示偏好与刷新设置',
      `标题：${s.title} · 模式：${s.showUsedFlow ? '显示已用' : '显示剩余'} · 布局：${dirModeLabel} · 刷新：${refMins}分钟`,
      async () => {
        const m = new Alert()
        m.title = '卡片显示偏好与刷新设置'
        m.addAction(`🏷️ 修改小组件标题（当前：${s.title}）`)
        m.addAction(`🔁 切换流量/语音展示（当前：${s.showUsedFlow ? '显示已用' : '显示剩余'}）`)
        m.addAction('📊 定向流量卡片：自动（有定向数据才显示4卡）')
        m.addAction('📊 定向流量卡片：强制 4 卡（始终显示定向）')
        m.addAction('📊 定向流量卡片：强制 3 卡（隐藏定向）')
        m.addAction(`⏱️ 后台自动刷新间隔（当前：${refMins} 分钟）`)
        m.addCancelAction('取消')
        const idx = await m.presentSheet()
        if (idx === -1) return
        if (idx === 0) {
          const val = await promptField('修改小组件标题', '留空将恢复默认「中国电信」', '中国电信', s.title)
          if (val != null) {
            saveSettings({ title: val.trim() || '中国电信' })
            statusMsg = `标题已更新为：${settings().title}`
            renderTable()
          }
        } else if (idx === 1) {
          saveSettings({ showUsedFlow: !s.showUsedFlow })
          statusMsg = `已切换为：${settings().showUsedFlow ? '显示已用流量/语音' : '显示剩余流量/语音'}`
          renderTable()
        } else if (idx === 2) {
          saveSettings({ showDirect: 'auto' })
          statusMsg = '定向卡片已设为：自动判断'
          renderTable()
        } else if (idx === 3) {
          saveSettings({ showDirect: 'true' })
          statusMsg = '定向卡片已设为：强制 4 卡'
          renderTable()
        } else if (idx === 4) {
          saveSettings({ showDirect: 'false' })
          statusMsg = '定向卡片已设为：强制 3 卡'
          renderTable()
        } else if (idx === 5) {
          const rm = new Alert()
          rm.title = '后台自动刷新间隔'
          rm.message =
            '设置桌面小组件的自动刷新时间（refreshAfterDate）。注：iOS 系统会根据亮屏状态与后台刷新权限自动调度执行，无需手动点进脚本。'
          const opts = [15, 30, 60, 120]
          opts.forEach(min => rm.addAction(`${min} 分钟${min === refMins ? ' ✓' : ''}`))
          rm.addCancelAction('取消')
          const rIdx = await rm.presentSheet()
          if (rIdx >= 0 && rIdx < opts.length) {
            saveSettings({ refreshMinutes: opts[rIdx] })
            statusMsg = `后台自动刷新间隔已设为：每 ${opts[rIdx]} 分钟`
            renderTable()
          }
        }
      }
    )

    addOption(
      '🔄 立即刷新电信套餐与余额',
      lastState && lastState.data
        ? `话费 ¥${lastState.data.feeBalance} · 通用剩 ${fmtFlow(lastState.data.flowBalance).value}${fmtFlow(lastState.data.flowBalance).unit} · 语音剩 ${lastState.data.voiceBalance}分`
        : '点击立即请求接口并刷新本地缓存',
      async () => {
        statusMsg = '正在请求电信接口...'
        renderTable()
        const st = await getTelecomData(true)
        lastState = st
        if (st.data && !st.expired && !st.fromCache) {
          statusMsg = `刷新成功 (${st.channel === 'app' ? 'App通道' : '网页通道'}) · 话费 ¥${st.data.feeBalance}`
          renderTable()
        } else {
          statusMsg = `刷新异常：${st.errMsg || '请检查账号或Cookie'}`
          renderTable()
          await showAlert('刷新提示', st.errMsg || '未能获取最新电信数据，请检查凭证配置。')
        }
      }
    )

    const textModeLabel =
      (s.bgTextMode || 'light') === 'dark'
        ? '深邃浓黑字'
        : (s.bgTextMode || 'light') === 'auto'
        ? '跟随系统'
        : '纯白高亮字+立体阴影'

    addOption(
      '🎨 透明 / 自定义背景设置',
      hasTransparentBg()
        ? `当前：已启用透明背景 · 字体：${textModeLabel}（点击可切换字体颜色或重裁壁纸）`
        : '当前：默认浅灰/深色渐变（点击可从空白桌面截图一键裁切透明背景）',
      async () => {
        const menu = new Alert()
        menu.title = '透明 / 自定义背景设置'
        menu.message = '提示：如果透明背景后文字看不清，可点击「切换透明背景字体颜色」或重新裁切时加上深色/浅色蒙版。'
        menu.addAction('🔤 切换透明背景字体颜色（立即生效）')
        menu.addAction('✂️ 从空白桌面截图自动裁切（透明背景）')
        menu.addAction('🏞️ 从相册直接选择背景图')
        menu.addDestructiveAction('🗑️ 清除透明背景（恢复默认渐变）')
        menu.addCancelAction('取消')
        const actionIdx = await menu.presentSheet()
        if (actionIdx === -1) return

        const fm = FileManager.local()

        if (actionIdx === 0) {
          const tmAlert = new Alert()
          tmAlert.title = '选择透明背景字体颜色'
          tmAlert.message = '针对不同明暗度的手机壁纸，选择最清晰的文字与卡片对比度：'
          tmAlert.addAction('🌟 纯白高亮字 + 立体阴影（推荐 · 适配深色/风景/彩色壁纸）')
          tmAlert.addAction('🖤 深邃浓黑字 + 柔白光晕（适配纯白/极浅色壁纸）')
          tmAlert.addAction('🔄 跟随系统白天/夜晚模式')
          tmAlert.addCancelAction('取消')
          const tmIdx = await tmAlert.presentSheet()
          if (tmIdx === -1) return
          const nextMode = tmIdx === 1 ? 'dark' : tmIdx === 2 ? 'auto' : 'light'
          saveSettings({ bgTextMode: nextMode })
          statusMsg = `透明背景字体已切换为：${
            nextMode === 'dark' ? '深邃浓黑字' : nextMode === 'auto' ? '跟随系统' : '纯白高亮字+阴影'
          }`
          renderTable()
          return
        }

        if (actionIdx === 3) {
          ;['small', 'medium', 'large'].forEach(f => {
            const p = getBgFilePath(f)
            if (fm.fileExists(p)) fm.remove(p)
          })
          if (fm.fileExists(getCustomBgFilePath())) fm.remove(getCustomBgFilePath())
          statusMsg = '已恢复默认渐变背景'
          renderTable()
          return
        }

        const maskAlert = new Alert()
        maskAlert.title = '选择背景蒙版效果'
        maskAlert.message = '如果壁纸颜色较杂，叠加一层半透明暗色或浅色蒙版能让文字更清晰'
        maskAlert.addAction('✨ 纯净全透明（不加蒙版）')
        maskAlert.addAction('🌙 深色磨砂蒙版（推荐 · 压暗壁纸让白字更突出）')
        maskAlert.addAction('🌤️ 浅色柔光蒙版（适合配深色文字）')
        maskAlert.addCancelAction('取消')
        const maskIdx = await maskAlert.presentSheet()
        if (maskIdx === -1) return
        const overlayMode = maskIdx === 1 ? 'dark' : maskIdx === 2 ? 'light' : 'none'
        if (overlayMode === 'light') {
          saveSettings({ bgTextMode: 'dark' })
        } else {
          saveSettings({ bgTextMode: 'light' })
        }

        if (actionIdx === 2) {
          try {
            const img = await Photo.fromLibrary()
            if (!img) return
            const processed = applyOverlayToImage(img, img.size.width, img.size.height, overlayMode)
            fm.writeImage(getCustomBgFilePath(), processed)
            statusMsg = '已应用自定义背景图'
            renderTable()
          } catch (_) {}
          return
        }

        if (actionIdx === 1) {
          const guide = new Alert()
          guide.title = '如何获取空白桌面截图？'
          guide.message =
            '1. 长按手机桌面空白处进入「抖动编辑模式」\n2. 向左滑到最右侧的「空白页面」并截图\n3. 点击下方按钮选择刚才的空白桌面截图'
          guide.addAction('选择空白桌面截图')
          guide.addCancelAction('取消')
          if ((await guide.presentAlert()) === -1) return

          try {
            const wallImg = await Photo.fromLibrary()
            if (!wallImg) return

            const sizeAlert = new Alert()
            sizeAlert.title = '选择小组件尺寸'
            sizeAlert.addAction('中号 (Medium · 2×4)')
            sizeAlert.addAction('小号 (Small · 2×2)')
            sizeAlert.addAction('大号 (Large · 4×4)')
            sizeAlert.addCancelAction('取消')
            const sIdx = await sizeAlert.presentSheet()
            if (sIdx === -1) return
            const family = sIdx === 1 ? 'small' : sIdx === 2 ? 'large' : 'medium'

            const posAlert = new Alert()
            posAlert.title = '选择小组件在桌面的位置'
            let posKeys = []
            if (family === 'small') {
              posAlert.addAction('↖️ 左上 (Top Left)')
              posAlert.addAction('↗️ 右上 (Top Right)')
              posAlert.addAction('⬅️ 左中 (Middle Left)')
              posAlert.addAction('➡️ 右中 (Middle Right)')
              posAlert.addAction('↙️ 左下 (Bottom Left)')
              posAlert.addAction('↘️ 右下 (Bottom Right)')
              posKeys = ['top-left', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-right']
            } else if (family === 'medium') {
              posAlert.addAction('⬆️ 顶部 (Top)')
              posAlert.addAction('⏺️ 中部 (Middle)')
              posAlert.addAction('⬇️ 底部 (Bottom)')
              posKeys = ['top', 'middle', 'bottom']
            } else {
              posAlert.addAction('⬆️ 顶部大号 (Top)')
              posAlert.addAction('⬇️ 底部大号 (Bottom)')
              posKeys = ['top', 'bottom']
            }
            posAlert.addCancelAction('取消')
            const pIdx = await posAlert.presentSheet()
            if (pIdx === -1) return

            const cropped = cropWallpaperForWidget(wallImg, family, posKeys[pIdx], overlayMode)
            fm.writeImage(getBgFilePath(family), cropped)
            statusMsg = `已保存 ${family === 'small' ? '小号' : family === 'large' ? '大号' : '中号'} 透明背景！`
            renderTable()
          } catch (_) {}
        }
      }
    )

    addOption('📱 预览中号小组件 (Medium · 推荐)', '主屏幕最常用的三卡/四卡并排样式', async () => {
      if (!lastState) lastState = await getTelecomData(false)
      const w = createTelecomWidget(lastState, 'medium')
      await w.presentMedium()
    })

    addOption('📲 预览小号小组件 (Small · 2×2)', '紧凑 2×2 网格样式', async () => {
      if (!lastState) lastState = await getTelecomData(false)
      const w = createTelecomWidget(lastState, 'small')
      await w.presentSmall()
    })

    addOption('🖥️ 预览大号小组件 (Large · 含用量进度条)', '顶部卡片 + 通用/定向/语音可视化进度条', async () => {
      if (!lastState) lastState = await getTelecomData(false)
      const w = createTelecomWidget(lastState, 'large')
      await w.presentLarge()
    })

    table.reload()
  }

  renderTable()
  getTelecomData(false)
    .then(st => {
      lastState = st
      if (st && st.data) {
        statusMsg = `就绪 (${st.channel === 'app' ? 'App自动续期通道' : '网页Cookie通道'}) · 话费 ¥${st.data.feeBalance}`
      } else if (st && st.noCreds) {
        statusMsg = '请先配置通道一（App密码）或通道二（网页Cookie）'
      } else if (st && st.errMsg) {
        statusMsg = `提示：${st.errMsg}`
      }
      renderTable()
    })
    .catch(() => {})

  await table.present(false)
}

/* ================= 主入口 ================= */

async function main() {
  if (config.runsInWidget) {
    const family = config.widgetFamily || 'medium'
    const state = await getTelecomData(false)
    const widget = createTelecomWidget(state, family)
    Script.setWidget(widget)
    Script.complete()
  } else {
    await runInAppMenu()
    Script.complete()
  }
}

await main()













