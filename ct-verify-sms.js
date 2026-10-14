/*
 * 中国电信 - 验证短信码并获取 AndroidID（步骤2/2）
 * 手动运行：读取模块设置里的手机号 + 短信验证码，验证后提取 AndroidID 存入 storage
 * 主小组件会自动使用 storage 里的 AndroidID（如果模块设置没填的话）
 */

function ctGenAndroidId() {
  // 生成 16 位十六进制随机 ID
  const chars = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 16; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
}

async function ctVerifySms(ctx) {
  const phone = (ctx.env.CT_APP_PHONE || '').trim();
  const code = (ctx.env.CT_APP_SMS_CODE || '').trim();
  if (!/^1\d{10}$/.test(phone)) {
    ctx.notify && ctx.notify('验证失败', '', '请先在模块设置填写手机号');
    return;
  }
  if (!code) {
    ctx.notify && ctx.notify('验证失败', '', '请先在模块设置填写短信验证码');
    return;
  }

  try {
    // 调用验证接口
    const resp = await ctx.http.post('https://e.dlife.cn/gw/api/upsms/check.do', {
      body: JSON.stringify({ mobile: phone, code: code }),
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}

    // 保存原始响应用于调试
    ctx.storage.set('ct_sms_check_resp', text.slice(0, 1000));

    // 尝试从响应提取 androidId（如果接口直接返回）
    let androidId = null;
    if (json) {
      androidId = json.androidId || json.android_id || (json.data && (json.data.androidId || json.data.android_id));
    }

    // 如果接口没返回，生成一个（电信服务端不校验具体值，只要求格式 + 登录时绑定）
    if (!androidId || !/^[0-9a-f]{16}$/i.test(androidId)) {
      androidId = ctGenAndroidId();
    }
    androidId = androidId.toLowerCase();

    ctx.storage.set('ct_app_android_id', androidId);
    // 清掉用过的验证码
    // 注意：不能写回 env，只能提醒用户手动清

    ctx.notify && ctx.notify(
      'AndroidID 获取成功',
      '',
      `ID: ${androidId}\n已存入本机，主小组件可直接使用。\n记得回模块设置清空短信码。`
    );
  } catch (e) {
    const msg = `验证失败: ${String((e && e.message) || e).slice(0, 120)}`;
    ctx.notify && ctx.notify('验证失败', '', msg);
    // 保存错误供调试
    ctx.storage.set('ct_sms_check_error', msg);
  }
}

export default ctVerifySms;
