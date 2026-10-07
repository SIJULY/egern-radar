/*
 * 中国电信（Surge 版，单文件双模式）
 * 移植自 Egern 版 china-telecom.js（作者 小秘书），原 Scriptable 版作者 2Ya&脑瓜
 *
 * 同一个文件，两种用法（见 china-telecom.sgmodule）：
 *   1. type=http-request, pattern=^https://e\.dlife\.cn/
 *      → 登录捕获：Safari 里登录 e.dlife.cn 成功时，自动保存 Cookie 和登录地址
 *   2. type=cron（每天 6:35 / 18:35）
 *      → 定时刷新：用 Cookie 拉取套餐和话费，推送摘要通知；
 *        Cookie 失效时自动回放登录地址续期，续不上则通知你重新登录
 *
 * 注意：Surge 不支持 iOS 桌面小组件，数据通过定时通知呈现。
 * 如需桌面小组件，请用 Egern 版（china-telecom.yaml）。
 *
 * 参数（cron 的 argument 中配置，形如 silent=true&showUsed=false）：
 *   silent=true        成功时不推送摘要（默认推送）
 *   showUsed=true      显示已用流量（默认显示剩余流量）
 *   filterDirec=true   过滤定向流量
 */

const URLS = {
  login: 'https://e.dlife.cn/index.do',
  detail: 'https://e.dlife.cn/user/package_detail.do',
  balance: 'https://e.dlife.cn/user/balance.do',
};

const K = {
  cookie: 'ct_cookie',
  loginUrl: 'ct_login_url',
  loginTs: 'ct_login_ts',
  data: 'ct_data',
};

const FLOW_COLOR = '#FF6620';
const VOICE_COLOR = '#78C100';

/* ---------- 参数 ---------- */

function getArgs() {
  const out = {};
  try {
    String(typeof $argument !== 'undefined' ? $argument : '' || '')
      .split('&')
      .forEach((kv) => {
        const i = kv.indexOf('=');
        if (i > 0) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
      });
  } catch (e) {}
  return out;
}

/* ---------- 工具函数（纯逻辑，与 Egern 版一致） ---------- */

function formatFlow(flow) {
  const remain = flow / 1024;
  if (remain < 1024) {
    return { amount: remain.toFixed(2), unit: 'MB' };
  }
  return { amount: (remain / 1024).toFixed(2), unit: 'GB' };
}

function parseTelecom(detail, balance, opts) {
  const { showUsedFlow, filterOrientateFlow } = opts;
  let totalFlowAmount = 0;
  let totalBalanceFlowAmount = 0;
  let totalUsedFlowAmount = 0;
  let totalVoiceAmount = 0;
  let totalBalanceVoiceAmount = 0;
  let isUnlimitedFlow = false;

  for (const data of detail?.items || []) {
    if (data.offerType === 19) continue;
    for (const item of data.items || []) {
      if (item.unitTypeId == 3) {
        if (!(item.usageAmount == 0 && item.balanceAmount == 0)) {
          const isDirectional = /定向/.test(item.ratableResourcename || '');
          const skip =
            item.balanceAmount == '999999999999' ||
            (filterOrientateFlow && isDirectional);
          if (!skip) {
            totalFlowAmount += parseFloat(item.ratableAmount) || 0;
            totalBalanceFlowAmount += parseFloat(item.balanceAmount) || 0;
          }
        }
        totalUsedFlowAmount += parseFloat(item.usageAmount) || 0;
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

  const balanceFlow = formatFlow(totalBalanceFlowAmount);
  const usedFlow = formatFlow(totalUsedFlowAmount);

  const flow = {
    title: '剩余流量',
    number: balanceFlow.amount,
    unit: balanceFlow.unit,
    percent: +(((totalBalanceFlowAmount / (totalFlowAmount || 1)) * 100).toFixed(2)),
    color: FLOW_COLOR,
  };
  if (showUsedFlow) {
    flow.title = '已用流量';
    flow.number = usedFlow.amount;
    flow.unit = usedFlow.unit;
  }
  if (isUnlimitedFlow) {
    flow.title = '已用流量';
    flow.number = usedFlow.amount;
    flow.unit = usedFlow.unit;
  }

  const voice = {
    title: '剩余语音',
    number: `${totalBalanceVoiceAmount}`,
    unit: '分钟',
    percent: +(((totalBalanceVoiceAmount / (totalVoiceAmount || 1)) * 100).toFixed(2)),
    color: VOICE_COLOR,
  };

  const feeNum = Number(balance?.totalBalanceAvailable);
  const fee = {
    title: '剩余话费',
    number: Number.isFinite(feeNum) ? (feeNum / 100).toFixed(2) : '0.00',
    unit: '元',
  };

  return { fee, flow, voice, updatedAt: Date.now() };
}

/* ---------- Surge API 封装 ---------- */

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    $httpClient.get({ url, headers: headers || {} }, (err, resp, data) => {
      if (err) return reject(err);
      resolve({ status: resp && resp.status, headers: (resp && resp.headers) || {}, data });
    });
  });
}

function readStore(key) {
  try {
    return $persistentStore.read(key) || '';
  } catch (e) {
    return '';
  }
}

function writeStore(key, val) {
  try {
    $persistentStore.write(String(val == null ? '' : val), key);
  } catch (e) {}
}

/* ---------- 数据层 ---------- */

async function fetchData(cookie) {
  const d = await httpGet(URLS.detail, { Cookie: cookie });
  const b = await httpGet(URLS.balance, { Cookie: cookie });
  if (d.status !== 200 || b.status !== 200) {
    throw new Error(`HTTP ${d.status}/${b.status}`);
  }
  const detail = JSON.parse(d.data);
  const balance = JSON.parse(b.data);
  if (!detail || detail.items === undefined) throw new Error('bad data');
  return detail && balance ? { detail, balance } : null;
}

async function refreshCookie() {
  // 回放登录地址换新 Cookie（SSO 会话还活着才能换到）
  const loginUrl = readStore(K.loginUrl);
  if (!loginUrl) return '';
  const url = (loginUrl.match(/(http.+)&sign/) || [])[1] || loginUrl;
  try {
    const r = await httpGet(url, {});
    let setCookies = r.headers['Set-Cookie'] || r.headers['set-cookie'] || [];
    if (!Array.isArray(setCookies)) setCookies = [setCookies];
    const pairs = setCookies
      .map((c) => String(c).split(';')[0].trim())
      .filter(Boolean);
    if (pairs.length > 0) {
      writeStore(K.cookie, pairs.join('; '));
    }
  } catch (e) {}
  return readStore(K.cookie);
}

/* ---------- http-request 模式：登录捕获 ---------- */

async function handleCapture() {
  const url = ($request && $request.url) || '';
  if (url.indexOf('e.dlife.cn') === -1) {
    $done({});
    return;
  }

  // 1) 登录握手地址：记下来，并标记"刚刚登录过"（10 分钟内有效）
  if (url.indexOf('/user/loginMiddle') !== -1) {
    const m = url.match(/(http.+)&sign/);
    const loginUrl = (m && m[1]) || url;
    if (loginUrl && readStore(K.loginUrl) !== loginUrl) {
      writeStore(K.loginUrl, loginUrl);
    }
    writeStore(K.loginTs, String(Date.now()));
    $done({});
    return;
  }

  // 2) 主要方式：直接从登录后的真实请求里抓 Cookie
  const headers = ($request && $request.headers) || {};
  const cookie = String(headers['Cookie'] || headers['cookie'] || '').trim();
  if (!cookie || readStore(K.cookie) === cookie) {
    $done({});
    return;
  }
  writeStore(K.cookie, cookie);

  // 只有"刚登录过"才通知；后台静默续期不打扰
  const ts = Number(readStore(K.loginTs) || 0);
  if (Date.now() - ts < 10 * 60 * 1000) {
    writeStore(K.loginTs, '');
    $notification.post('中国电信', '', '登录成功，Cookie 已保存，定时任务将自动推送数据');
  }
  $done({});
}

/* ---------- cron 模式：定时刷新 + 推送 ---------- */

async function handleCron() {
  const args = getArgs();
  const opts = {
    showUsedFlow: args.showUsed === 'true',
    filterOrientateFlow: args.filterDirec === 'true',
  };

  let cookie = readStore(K.cookie);
  let got = null;

  if (cookie) {
    try {
      got = await fetchData(cookie);
    } catch (e) {
      got = null;
    }
  }
  // Cookie 失效 → 回放登录地址续期后重试
  if (!got) {
    const fresh = await refreshCookie();
    if (fresh && fresh !== cookie) {
      try {
        got = await fetchData(fresh);
      } catch (e) {
        got = null;
      }
    } else if (fresh && !cookie) {
      try {
        got = await fetchData(fresh);
      } catch (e) {
        got = null;
      }
    }
  }

  if (got) {
    const ds = parseTelecom(got.detail, got.balance, opts);
    writeStore(K.data, JSON.stringify(ds));
    if (args.silent !== 'true') {
      const body =
        `话费 ¥${ds.fee.number} | ${ds.flow.title} ${ds.flow.number}${ds.flow.unit} | ${ds.voice.title} ${ds.voice.number}${ds.voice.unit}`;
      $notification.post('中国电信', '', body);
    }
  } else {
    $notification.post(
      '中国电信',
      '',
      '登录已失效，请在 Safari 打开 https://e.dlife.cn 重新登录一次'
    );
  }
  $done();
}

/* ---------- 入口 ---------- */

(async () => {
  try {
    if (typeof $request !== 'undefined' && $request) {
      await handleCapture();
    } else {
      await handleCron();
    }
  } catch (e) {
    try {
      if (typeof $request !== 'undefined' && $request) $done({});
      else $done();
    } catch (_) {}
  }
})();
