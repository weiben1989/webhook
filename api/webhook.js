export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
      text: true,
    },
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Only POST requests allowed');
  }

  const contentType = req.headers['content-type'] || '';
  let message = {};

  if (contentType.includes('application/json')) {
    message = req.body;
  } else if (contentType.includes('text/plain')) {
    try {
      message = { note: JSON.parse(req.body) }; // 去掉双引号
    } catch {
      message = { note: req.body };
    }
  } else {
    return res.status(400).send('Unsupported content type');
  }

  // 企业微信 webhook 地址
  const webhookURL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=cee69a01-8397-486c-a820-f44cd5181313'; // 记得替换成你的 key

  const content = `📢 TradingView 警报\n\n${Object.entries(message)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}`;

  await fetch(webhookURL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'text',
      text: { content },
    }),
  });

  res.status(200).json({ ok: true });
}
