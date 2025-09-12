import fetch from "node-fetch";

// Vercel/Next.js API route config
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
  },
};

export default async function handler(req, res) {
  try {
    // 1. 安全检查：只接受 POST 请求
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // 企业微信 webhook 地址 (注意：直接写入代码中存在安全风险，建议最终部署时使用环境变量)
    const webhookURL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=cee69a01-8397-486c-a820-f44cd5181313';

    // 2. 智能解析请求体，生成最终消息内容
    let messageBody;
    const contentType = req.headers['content-type'] || '';
    const rawBody = req.body;

    // Case A: 如果请求是 JSON 格式
    if (contentType.includes('application/json')) {
      messageBody = Object.entries(rawBody)
        .map(([key, value]) => {
          const displayValue = typeof value === 'object' && value !== null ? JSON.stringify(value) : value;
          return `${key}: ${displayValue}`;
        })
        .join('\n');
    } 
    // Case B: 如果请求是纯文本
    else if (contentType.includes('text/plain') || contentType.includes('application/x-www-form-urlencoded')) {
      // 尝试按 JSON 解析。如果成功，说明是JSON格式的文本
      try {
        const alertData = JSON.parse(rawBody);
        messageBody = Object.entries(alertData)
          .map(([key, value]) => {
            const displayValue = typeof value === 'object' && value !== null ? JSON.stringify(value) : value;
            return `${key}: ${displayValue}`;
          })
          .join('\n');
      } catch (e) {
        // 如果解析失败，说明是真正的纯文本，直接使用它
        messageBody = rawBody;
      }
    } 
    // Case C: 其他不支持的格式
    else {
      return res.status(400).json({ error: `Unsupported Content-Type: ${contentType}` });
    }

    // 3. 格式化消息并发送到企业微信 (已移除固定标题和分割线)
    const finalContent = messageBody;

    const wechatResponse = await fetch(webhookURL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: {
          content: finalContent,
        },
      }),
    });

    // 检查企业微信API的响应
    if (!wechatResponse.ok) {
        const wechatResult = await wechatResponse.json();
        console.error("Error sending to WeChat:", wechatResult);
        throw new Error(`Failed to send message to WeChat: ${wechatResult.errmsg || 'Unknown error'}`);
    }

    // 4. 向 TradingView 返回成功响应
    return res.status(200).json({ success: true, message: 'Alert forwarded successfully' });

  } catch (error) {
    // 统一的错误处理
    console.error('Webhook Error:', error.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

