import fetch from "node-fetch";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    // 判断消息类型：JSON对象 or 普通文本
    let content = "";

    if (typeof req.body === "object") {
      // JSON 格式的消息，美化输出
      content = Object.entries(req.body)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n');
    } else {
      // 普通字符串消息，直接输出
      content = String(req.body);
    }

    // 调用企业微信 webhook 接口发送消息
    const resp = await fetch(process.env.WECHAT_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: { content }
      }),
    });

    const result = await resp.json();
    res.status(200).json({ ok: true, wechat: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
