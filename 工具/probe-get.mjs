// 临时探针：验证 GET /mcp 是否返回 200 + text/event-stream 并保持连接
// 用法: node probe-get.mjs
import http from 'node:http';
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8'));

const req = http.request(
  {
    host: '127.0.0.1',
    port: cfg.port,
    path: '/mcp',
    method: 'GET',
    headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'text/event-stream' },
  },
  (res) => {
    console.log('HTTP', res.statusCode, '| content-type:', res.headers['content-type']);
    let n = 0;
    res.on('data', (d) => {
      n++;
      console.log('  收到第', n, '块:', JSON.stringify(d.toString()));
    });
    setTimeout(() => {
      console.log('  1.5 秒后连接仍然打开 => 正确');
      res.destroy();
      process.exit(0);
    }, 1500);
  },
);

req.on('error', (e) => {
  console.log('ERR', e.message);
  process.exit(1);
});

req.end();
