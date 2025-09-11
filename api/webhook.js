import fetch from "node-fetch";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }
    
    let raw = "";
    try {
      raw = JSON.stringify(req.body, null, 2);
    } catch {
      raw = String(req.body);
    }
    
    const content = `**🚨 TradingView 警报（原始内容）**\n\`\`\`\n${raw}\n\`\`\``;
    
    const resp = await fetch(process.env.WECHAT_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: { content }
      })
    });
    
    const result = await resp.json();
    res.status(200).json({ ok: true, wechat: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
