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
 *   CT_PHONE                手机号（配 CT_PASSWORD 后走 App 官方 API 登录，无需 MITM/cookie）
 *   CT_PASSWORD             电信服务密码（与 CT_PHONE 配合，token 失效自动重登）
 *   CT_DEVICE_ID            设备 ID（可选，留空自动生成；短信登录授权过的设备 ID 更稳）
 *   CT_LOGIN_URL            电信登录地址（抓包得到的登录 URL，用于自动更新 cookie）
 *   CT_COOKIE               直接填写 cookie（与 CT_LOGIN_URL 二选一，URL 优先）
 *   CT_SHOW_USED_FLOW       'true' 显示已用流量，否则显示剩余流量

 *   CT_SHOW_DIRECT          'false' 隐藏定向卡（3卡模式）；'true' 强制4卡；不填则自动判断
 *   CT_TITLE                小组件标题，默认 "中国电信"
 *
 * 数据来源（按优先级）：
 *   1. App 官方 API（CT_PHONE+CT_PASSWORD）：appgologin.189.cn 登录，
 *      appfuwu.189.cn 查数据；RSA 加密，无需 MITM。注意无定向流量细分。
 *   2. https://e.dlife.cn/user/package_detail.do + balance.do（cookie/MITM 捕获）
 */

const URLS = {
  login: 'https://e.dlife.cn/index.do',
  detail: 'https://e.dlife.cn/user/package_detail.do',
  balance: 'https://e.dlife.cn/user/balance.do',
};


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
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
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
    throw new Error(`HTTP ${resp ? resp.status : 'no-response'}: ${url}`);
  }
  const data = await resp.json();
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


/* ---------- 电信 App 官方 API（RSA 登录，无需 MITM/cookie） ---------- */
// 移植自 2Ya&脑瓜 Scriptable 版（RSA 登录 + appgologin/appfuwu 接口）。
// 配置 CT_PHONE + CT_PASSWORD（电信服务密码）后启用；token 存 storage，失效自动重登。
// 注意：App 接口不返回定向流量细分，走此通道时小组件为 3 卡（话费/通用/语音）。

const CT_RSA_PUB_KEY =
  '-----BEGIN PUBLIC KEY-----\n' +
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDBkLT15ThVgz6/NOl6s8GNPofd\n' +
  'WzWbCkWnkaAm7O2LjkM1H7dMvzkiqdxU02jamGRHLX/ZNMCXHnPcW/sDhiFCBN18\n' +
  'qFvy8g6VYb9QtroI09e176s+ZCtiv7hbin2cCTj99iUpnEloZm19lwHyo69u5UMi\n' +
  'PMpq0/XKBO8lYhN/gwIDAQAB\n' +
  '-----END PUBLIC KEY-----';

const CT_B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function ctB64Encode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += CT_B64_CHARS[(n >> 18) & 63] + CT_B64_CHARS[(n >> 12) & 63] +
      (i + 1 < bytes.length ? CT_B64_CHARS[(n >> 6) & 63] : '=') +
      (i + 2 < bytes.length ? CT_B64_CHARS[n & 63] : '=');
  }
  return out;
}
function ctB64Decode(b64) {
  const clean = String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
  const out = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c = (ch) => (ch === '=' ? 0 : CT_B64_CHARS.indexOf(ch));
    const n = (c(clean[i]) << 18) | (c(clean[i + 1]) << 12) | (c(clean[i + 2]) << 6) | c(clean[i + 3]);
    out.push((n >> 16) & 255);
    if (clean[i + 2] !== '=') out.push((n >> 8) & 255);
    if (clean[i + 3] !== '=') out.push(n & 255);
  }
  return out;
}

// RSA PKCS#1 v1.5 加密（BigInt 自实现，无外部依赖；已用本地密钥对做往返验证）
function ctRsaEncrypt(text) {
  const pem = CT_RSA_PUB_KEY;
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = ctB64Decode(b64);
  let pos = 0;
  const readLen = () => {
    let len = der[pos++];
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = (len << 8) | der[pos++];
    }
    return len;
  };
  const readInt = () => {
    if (der[pos++] !== 0x02) throw new Error('bad key');
    const len = readLen();
    let v = 0n;
    for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(der[pos++]);
    return v;
  };
  if (der[pos++] !== 0x30) throw new Error('bad key');
  readLen();
  if (der[pos++] !== 0x30) throw new Error('bad key');
  const algLen = readLen(); pos += algLen;
  if (der[pos++] !== 0x03) throw new Error('bad key');
  readLen(); pos++; // BIT STRING 头 + unused bits
  if (der[pos++] !== 0x30) throw new Error('bad key');
  readLen();
  const mod = readInt();
  const exp = readInt();
  const k = Number((mod.toString(2).length + 7) >> 3);
  const data = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 127) throw new Error('non-ascii text');
    data.push(code);
  }
  if (data.length > k - 11) throw new Error('text too long');
  const block = new Array(k).fill(0);
  block[0] = 0x00; block[1] = 0x02;
  const psLen = k - data.length - 3;
  for (let i = 0; i < psLen; i++) {
    let r = 0;
    while (r === 0) r = Math.floor(Math.random() * 256);
    block[2 + i] = r;
  }
  block[2 + psLen] = 0x00;
  for (let i = 0; i < data.length; i++) block[3 + psLen + i] = data[i];
  let m = 0n;
  for (const b of block) m = (m << 8n) | BigInt(b);
  let e = exp, base = m % mod, r = 1n;
  while (e > 0n) {
    if (e & 1n) r = (r * base) % mod;
    base = (base * base) % mod;
    e >>= 1n;
  }
  const hex = r.toString(16).padStart(k * 2, '0');
  const out = [];
  for (let i = 0; i < k; i++) out.push(parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  return ctB64Encode(out);
}

function ctTransNumber(str) {
  return [...String(str)].map((c) => String.fromCharCode((c.charCodeAt(0) + 2) & 0xffff)).join('');
}

function ctBeijingTimestamp() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`;
}

async function ctHttpPost(ctx, url, body) {
  const bodyStr = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json; charset=UTF-8' };
  const parse = async (resp) => {
    if (!resp || resp.status !== 200) {
      let snippet = '';
      try {
        const t = await resp.text();
        snippet = String(t).replace(/\s+/g, ' ').slice(0, 120);
      } catch (e) {}
      const e = new Error(`HTTP ${resp ? resp.status : 'no-response'}${snippet ? ' ' + snippet : ''}`);
      e.httpStatus = resp ? resp.status : 0;
      throw e;
    }
    return resp.json();
  };
  const http = ctx.http || {};
  if (typeof http.post === 'function') {
    // 官方文档：post(url, options)，options = {headers, body, timeout}
    // C 为标准写法放首位；A/B 为旧版兼容 fallback
    const attempts = [
      () => http.post(url, { body: bodyStr, headers, timeout: 15000 }),
      () => http.post(url, bodyStr, headers),
      () => http.post(url, bodyStr, { headers, timeout: 15000 }),
    ];
    let lastErr = null;
    for (const fn of attempts) {
      try {
        return await parse(await fn());
      } catch (e) {
        lastErr = e;
        if (!e.httpStatus || e.httpStatus !== 415) break; // 非 415 说明约定对了，是别的问题
      }
    }
    throw lastErr;
  }
  if (typeof http.request === 'function') {
    return parse(await http.request({ method: 'POST', url, body: bodyStr, headers, timeout: 15000 }));
  }
  if (typeof fetch === 'function') {
    return parse(await fetch(url, { method: 'POST', body: bodyStr, headers }));
  }
  throw new Error('Egern 不支持 POST 请求');
}

async function ctAppLogin(ctx) {
  const phone = (ctx.env.CT_PHONE || '').trim();
  const password = (ctx.env.CT_PASSWORD || '').trim();
  const deviceId = (ctx.env.CT_DEVICE_ID || '').trim();
  if (!phone || !password) throw new Error('未配置 CT_PHONE / CT_PASSWORD');
  let deviceUid = ctx.storage.get('ct_device_uid') || '';
  if (!/^\d{16}$/.test(deviceUid)) {
    deviceUid = String(Math.floor(Math.random() * 9e15 + 1e15));
    ctx.storage.set('ct_device_uid', deviceUid);
  }
  const ts = ctBeijingTimestamp();
  const encryptText = `iPhone 14 15.4.0${deviceId || deviceUid.slice(0, 12)}${phone}${ts}${password}0$$$0.`;
  const encrypted = ctRsaEncrypt(encryptText);
  const loginBody = {
    content: {
      fieldData: {
        loginType: '4', accountType: '', isChinatelecom: '',
        systemVersion: '15.4.0', deviceUid: deviceUid.slice(0, 16),
        phoneNum: ctTransNumber(phone), authentication: ctTransNumber(password),
        androidId: deviceId ? ctTransNumber(deviceId) : '',
        loginAuthCipherAsymmertric: encrypted,
      },
      attach: 'iPhone',
    },
    headerInfos: {
      code: 'userLoginNormal', clientType: '#12.2.0#channel50#iPhone 14 Pro#',
      timestamp: ts, shopId: '20002', source: '110003',
      sourcePassword: 'Sid98s', userLoginName: ctTransNumber(phone),
    },
  };
  const data = await ctHttpPost(ctx, 'https://appgologin.189.cn:9031/login/client/userLoginNormal', loginBody);
  if (data?.responseData?.resultCode !== '0000') {
    const rd = data?.responseData;
    if ((rd?.resultDesc || '').includes('频繁')) {
      ctx.storage.set('ct_app_ratelimited_at', String(Date.now()));
    }
    const detail = rd ? `code=${rd.resultCode} desc=${rd.resultDesc || '(空)'}` : `raw=${JSON.stringify(data).slice(0, 90)}`;
    throw new Error(`App 登录失败(${detail})`.slice(0, 90));
  }
  const rs = data.responseData.data.loginSuccessResult || {};
  if (!rs.token) throw new Error('App 登录未返回 token');
  ctx.storage.delete('ct_app_ratelimited_at');
  ctx.storage.set('ct_app_token', rs.token);
  ctx.storage.set('ct_app_city', rs.cityCode || '');
  ctx.storage.set('ct_app_province', rs.provinceCode || '');
  return rs;
}

async function ctAppFetchData(ctx) {
  // 限流冷却：30 分钟内被限流过则直接跳过 App，避免越试封越久
  const limitedAt = parseInt(ctx.storage.get('ct_app_ratelimited_at') || '0', 10);
  if (limitedAt && Date.now() - limitedAt < 30 * 60 * 1000) {
    throw new Error('App 登录限流冷却中');
  }
  const phone = (ctx.env.CT_PHONE || '').trim();
  const doQuery = async (token) => {
    const ts = ctBeijingTimestamp();
    return ctHttpPost(ctx, 'https://appfuwu.189.cn:9021/query/qryImportantData', {
      content: {
        fieldData: {
          provinceCode: ctx.storage.get('ct_app_province') || '',
          cityCode: ctx.storage.get('ct_app_city') || '',
          shopId: '20002', isChinatelecom: '0',
          account: ctTransNumber(phone),
        },
        attach: 'test',
      },
      headerInfos: {
        code: 'qryImportantData', clientType: '#12.2.0#channel50#iPhone 14 Pro#',
        timestamp: ts, shopId: '20002', source: '110003',
        sourcePassword: 'Sid98s', userLoginName: ctTransNumber(phone), token,
      },
    });
  };
  let token = ctx.storage.get('ct_app_token') || '';
  let data = null;
  if (token) {
    try { data = await doQuery(token); } catch (e) { data = null; }
  }
  if (!data?.responseData?.data) {
    const rs = await ctAppLogin(ctx);
    data = await doQuery(rs.token);
  }
  if (!data?.responseData?.data) throw new Error('App 数据获取失败');
  return data.responseData.data;
}

// App API 数据 → buildDs 模型（fee 单位分，流量单位 KB，语音单位分钟）
function ctAppDataToModel(apiData) {
  const safeN = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const balance = safeN(apiData.balanceInfo?.indexBalanceDataInfo?.balance ?? apiData.balance);
  const flowSrc = apiData.flowInfo?.totalAmount || {};
  const genUsed = safeN(flowSrc.used);
  const genBalance = safeN(flowSrc.balance);
  const voiceSrc = apiData.voiceInfo?.voiceDataInfo || {};
  const voiceTotal = safeN(voiceSrc.total);
  const voiceUsed = safeN(voiceSrc.used);
  return {
    feeFen: Math.round(balance * 100),
    genTotal: safeN(flowSrc.total) || genUsed + genBalance,
    genBalance, genUsed,
    dirTotal: 0, dirBalance: 0, dirUsed: 0,
    voiceTotal,
    voiceBalance: safeN(voiceSrc.balance ?? (voiceTotal - voiceUsed)),
    isUnlimitedFlow: false,
  };
}

async function tryAppApi(ctx, settings) {
  const apiData = await ctAppFetchData(ctx);
  const ds = buildDs(ctAppDataToModel(apiData), settings);
  ds.source = 'app';
  ctx.storage.setJSON('ct_datasource', ds);
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
  return ds;
}

async function loadData(ctx) {
  const envCookie = (ctx.env.CT_COOKIE || '').trim();
  const loginUrl =
    (ctx.env.CT_LOGIN_URL || '').trim() || ctx.storage.get('ct_login_url') || '';
  const settings = {
    showUsedFlow: String(ctx.env.CT_SHOW_USED_FLOW || '').toLowerCase() === 'true',
  };
  const storedCookie = ctx.storage.get('ct_cookie') || '';
  const appApiConfigured = !!((ctx.env.CT_PHONE || '').trim() && (ctx.env.CT_PASSWORD || '').trim());
  // 只要配了 App 账号、登录地址/cookie，或之前抓到过 cookie，就视为"已配置"
  const configured = !!(appApiConfigured || envCookie || loginUrl || storedCookie);

  // 0) App 官方 API（RSA 登录，可自动重登，最省心）
  if (appApiConfigured) {
    try {
      const ds = await tryAppApi(ctx, settings);
      ctx.storage.set('ct_app_error', '');
      return { configured, ds, fromCache: false };
    } catch (e) {
      ctx.storage.set('ct_app_error', String((e && e.message) || e).slice(0, 80));
      /* 掉到 cookie 兜底 */
    }
  }
  const appError = appApiConfigured ? (ctx.storage.get('ct_app_error') || '') : '';

  // 1) 优先用已捕获的 cookie（从登录后的真实请求里抓的，最可靠）
  const firstCookie = envCookie || storedCookie;
  if (firstCookie) {
    try {
      const ds = await tryCookie(ctx, firstCookie, settings);
      if (appError) ds.appError = appError;
      return { configured, ds, fromCache: false };
    } catch (e) {
      /* cookie 失效，掉到下一步 */
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
      /* 掉到缓存 */
    }
  }

  // 3) 断网/过期时用缓存顶一下
  const cached = ctx.storage.getJSON('ct_datasource');
  return { configured, ds: cached || null, fromCache: !!cached };
}

/* ---------- 渲染层（Widget DSL） ---------- */

// 四卡图标：话费¥ / 通用蜂窝 / 定向闪电 / 语音电话
const FEE_ICON = 'yensign.circle.fill';
const FEE_ICON_COLOR = '#FF9500';
const GENERAL_ICON = 'antenna.radiowaves.left.and.right';
const GENERAL_ICON_COLOR = '#0A84FF';
const DIRECT_ICON = 'bolt.fill';
const DIRECT_ICON_COLOR = '#AF52DE';
const VOICE_ICON = 'phone.circle.fill';
const VOICE_ICON_COLOR = '#34C759';

// 四卡统一：小图标 / 标题(含单位) / 大数值
// 卡片统一：小图标 / 标题 / 大数值
// fourCard=true（4 卡挤）时：标题不带单位，单位跟在数字后面，数字字号自动缩小
function quadCard(icon, color, data, fourCard) {
  const titleText = fourCard ? data.title : `${data.title}(${data.unit})`;
  const numberText = fourCard ? `${data.number}${data.unit}` : String(data.number);
  return {
    type: 'stack',
    direction: 'column',
    alignItems: 'center',
    flex: 1,
    gap: 2,
    children: [
      { type: 'image', src: `sf-symbol:${icon}`, width: 32, height: 32, color },
      { type: 'text', text: titleText, font: { size: 'caption2' }, opacity: 0.75, maxLines: 1, minScale: 0.8 },
      {
        type: 'text',
        text: numberText,
        font: { size: fourCard ? 'footnote' : 'title2', weight: 'bold' },
        maxLines: 1,
        minScale: fourCard ? 0.9 : 0.7,
      },
    ],
  };
}
// 小尺寸 2x2 紧凑卡
function miniCard(icon, color, data) {
  return {
    type: 'stack',
    direction: 'column',
    alignItems: 'center',
    flex: 1,
    gap: 1,
    children: [
      { type: 'image', src: `sf-symbol:${icon}`, width: 18, height: 18, color },
      {
        type: 'text',
        text: String(data.number),
        font: { size: 'footnote', weight: 'semibold' },
        maxLines: 1,
        minScale: 0.7,
      },
      { type: 'text', text: data.title, font: { size: 'caption2' }, opacity: 0.6, maxLines: 1 },
    ],
  };
}

// 开关2：CT_SHOW_DIRECT=false → 3卡模式（隐藏定向）；=true → 强制4卡；不填 → 有定向数据才显示
function showDirectCard(ctx, ds) {
  const v = String(ctx?.env?.CT_SHOW_DIRECT || '').toLowerCase();
  if (v === 'false') return false;
  if (v === 'true') return true;
  return !!ds.hasDirectFlow;
}

function headerRow(title, ds, fromCache) {
  const t = ds && ds.updatedAt ? fmtTime(ds.updatedAt) : '--:--';
  const srcLabel = ds && ds.source === 'app' ? 'App' : ds && ds.source === 'cookie' ? 'Cookie' : '';
  const suffix = srcLabel ? ` · ${srcLabel}` : '';
  const appErr = ds && ds.appError ? `（App：${ds.appError}）` : '';
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    children: [
      { type: 'text', text: title, font: { size: 'footnote', weight: 'semibold' } },
      { type: 'spacer' },
      {
        type: 'text',
        text: fromCache ? `缓存 ${t}${suffix}${appErr}` : `更新 ${t}${suffix}${appErr}`,
        font: { size: 'caption2' },
        opacity: 0.55,
      },
    ],
  };
}

function buildSmall(title, ds, fromCache, ctx) {
  const cards3 = !showDirectCard(ctx, ds);
  const row4 = (a, b) => ({
    type: 'stack',
    direction: 'row',
    gap: 6,
    children: [miniCard(a[0], a[1], a[2]), miniCard(b[0], b[1], b[2])],
  });
  const body = cards3
    ? [
        {
          type: 'stack',
          direction: 'row',
          gap: 6,
          children: [miniCard(FEE_ICON, FEE_ICON_COLOR, ds.fee)],
        },
        row4([GENERAL_ICON, GENERAL_ICON_COLOR, ds.generalFlow], [VOICE_ICON, VOICE_ICON_COLOR, ds.voice]),
      ]
    : [
        row4([FEE_ICON, FEE_ICON_COLOR, ds.fee], [GENERAL_ICON, GENERAL_ICON_COLOR, ds.generalFlow]),
        row4([DIRECT_ICON, DIRECT_ICON_COLOR, ds.directFlow], [VOICE_ICON, VOICE_ICON_COLOR, ds.voice]),
      ];
  return {
    type: 'widget',
    padding: 12,
    gap: 6,
    refreshAfter: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    children: [headerRow(title, ds, fromCache), ...body],
  };
}

function buildMedium(title, ds, fromCache, ctx) {


  return {
    type: 'widget',
    padding: 12,
    gap: 8,
    refreshAfter: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    children: [
      headerRow(title, ds, fromCache),
      {
        type: 'stack',
        direction: 'row',
        gap: 12,
        children: (() => {
          const four = showDirectCard(ctx, ds);
          return [
            quadCard(FEE_ICON, FEE_ICON_COLOR, ds.fee, four),
            quadCard(GENERAL_ICON, GENERAL_ICON_COLOR, ds.generalFlow, four),
            ...(four ? [quadCard(DIRECT_ICON, DIRECT_ICON_COLOR, ds.directFlow, four)] : []),
            quadCard(VOICE_ICON, VOICE_ICON_COLOR, ds.voice, four),
          ];
        })(),
      },
    ],
  };
}

function buildLockScreen(title, ds, family) {
  if (family === 'accessoryCircular' || family === 'accessoryInline') {
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
  // accessoryRectangular
  return {
    type: 'widget',
    padding: 8,
    gap: 4,
    children: [
      { type: 'text', text: title, font: { size: 'caption2', weight: 'semibold' } },
      {
        type: 'text',
        text: `¥${ds.fee.number} · ${ds.generalFlow.number}${ds.generalFlow.unit} · ${ds.voice.number}分`,
        font: { size: 'footnote' },
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
    children: [
      { type: 'text', text: title, font: { size: 'footnote', weight: 'semibold' } },
      {
        type: 'image',
        src: 'sf-symbol:exclamationmark.triangle',
        width: 22,
        height: 22,
        color: '#FF9500',
      },
      { type: 'text', text: message, font: { size: 'caption1' }, opacity: 0.7 },
    ],
  };
  if (url) w.url = url; // 点小组件直接跳转（比如跳到登录页）
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
  const { configured, ds, fromCache } = await loadData(ctx);

  if (!configured) {
    return buildError(
      title,
      '未登录：在 Safari 打开 e.dlife.cn 登录一次',
      URLS.login
    );
  }
  if (!ds) {
    return buildError(title, '数据获取失败，请检查网络或重新登录');
  }

  const family = ctx.widgetFamily || 'systemSmall';
  if (family === 'systemMedium' || family === 'systemLarge' || family === 'systemExtraLarge') {
    return buildMedium(title, ds, fromCache, ctx);
  }
  if (family.startsWith('accessory')) {
    return buildLockScreen(title, ds, family);
  }
  return buildSmall(title, ds, fromCache, ctx);
}

/* ---------- 入口：单文件双模式 ---------- */

export default async function (ctx) {
  // request 脚本条目 → 捕获登录；generic 脚本条目 → 渲染小组件
  //（ctx.request 仅在 request/response 脚本中可用）
  if (ctx.request && ctx.request.url) {
    return handleCapture(ctx);
  }
  return handleWidget(ctx);
}
