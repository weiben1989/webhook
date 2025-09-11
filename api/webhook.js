import fetch from "node-fetch";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    // 获取原始数据
    let raw = "";
    try {
      raw = JSON.stringify(req.body, null, 2);
    } catch {
      raw = String(req.body);
    }

    // 智能识别消息格式
    let content = "";
    
    // 检查是否是预格式化的消息（包含特殊标识）
    if (typeof req.body === "string" && (
        req.body.includes("🚨") || 
        req.body.includes("📊") || 
        req.body.includes("TradingView") ||
        req.body.includes("警报")
    )) {
      // 直接使用预格式化的消息
      content = req.body;
    }
    // 检查是否有现成的content字段
    else if (req.body && req.body.content) {
      content = req.body.content;
    }
    // 检查是否有message字段
    else if (req.body && req.body.message) {
      content = req.body.message;
    }
    // 检查是否有text字段
    else if (req.body && req.body.text) {
      content = req.body.text;
    }
    // 检查是否是简单的键值对对象
    else if (typeof req.body === "object" && req.body !== null) {
      const entries = Object.entries(req.body);
      
      // 如果只有1-3个简单字段，直接格式化
      if (entries.length <= 3 && entries.every(([k, v]) => typeof v !== "object")) {
        content = `🚨 TradingView 警报\n\n${entries.map(([key, value]) => `${key}: ${value}`).join('\n')}`;
      }
      // 复杂对象，显示美化格式+原始数据
      else {
        const formatted = entries.map(([key, value]) => {
          if (typeof value === "object") {
            return `${key}: ${JSON.stringify(value)}`;
          }
          return `${key}: ${value}`;
        }).join('\n');
        
        content = `🚨 TradingView 警报\n\n${formatted}\n\n--- 详细数据 ---\n\`\`\`\n${raw}\n\`\`\``;
      }
    }
    // 纯字符串消息
    else if (typeof req.body === "string") {
      content = req.body.includes("🚨") ? req.body : `🚨 TradingView 警报\n\n${req.body}`;
    }
    // 兜底处理
    else {
      content = `🚨 TradingView 警报\n\n${String(req.body)}`;
    }

    // 消息长度限制
    if (content.length > 2048) {
      content = content.substring(0, 2000) + "\n\n...(消息过长已截断)";
    }

    // 对最终内容进行UTF-8处理
    content = ensureUTF8(content);

    // 发送到企业微信
    const resp = await fetch(process.env.WECHAT_WEBHOOK, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json; charset=utf-8" 
      },
      body: JSON.stringify({
        msgtype: "text",
        text: { content }
      })
    });

    const result = await resp.json();
    res.status(200).json({ ok: true, wechat: result });

  } catch (e) {
    console.error('Webhook error:', e);
    res.status(500).json({ error: e.message });
  }
}
