/*
 * 中国电信 - 发送短信验证码（步骤1/2）
 * 手动运行：读取模块设置里的手机号，调用电信接口发送短信验证码
 * 发完后把收到的验证码填到模块设置的 CT_APP_SMS_CODE，再手动运行 ct-verify-sms.js
 */

async function ctSendSms(ctx) {
  const phone = (ctx.env.CT_APP_PHONE || '').trim();
  if (!/^1\d{10}$/.test(phone)) {
    ctx.notify && ctx.notify('发送失败', '', '请先在模块设置填写正确的 11 位手机号');
    return;
  }

  try {
    // 尝试获取验证码（upsms 接口）
    const resp = await ctx.http.post('https://e.dlife.cn/gw/api/upsms/getCode.do', {
      body: JSON.stringify({ mobile: phone }),
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}

    // 保存会话信息供验证步骤使用
    ctx.storage.set('ct_sms_phone', phone);
    ctx.storage.set('ct_sms_getcode_resp', text.slice(0, 500));
    ctx.storage.set('ct_sms_time', String(Date.now()));

    const msg = json && json.data
      ? '验证码请求已发送，请查收短信'
      : `接口返回异常: ${text.slice(0, 100)}`;
    ctx.notify && ctx.notify('短信验证码', '', msg);
  } catch (e) {
    const msg = `发送失败: ${String((e && e.message) || e).slice(0, 100)}`;
    ctx.notify && ctx.notify('发送失败', '', msg);
  }
}

export default ctSendSms;
