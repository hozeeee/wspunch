#!/usr/bin/env node
'use strict';

/**
 * 演示用的「目标服务」，扮演内网里那台只有 expose 端能访问的机器。
 *
 *   node examples/origin-server.js [port]      默认 9000
 *
 * 路由：
 *   GET  /            返回一段文本
 *   GET  /big?mb=32   返回指定大小的数据，用来验证大流量与背压
 *   POST /echo        把请求体原样回显，用来验证上行
 */

const http = require('node:http');

const port = Number(process.argv[2] || 9000);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/echo') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    req.pipe(res);
    return;
  }

  if (url.pathname === '/big') {
    const mb = Math.max(1, Math.min(Number(url.searchParams.get('mb') || 8), 512));
    const total = mb * 1024 * 1024;
    const chunk = Buffer.alloc(64 * 1024, 'x');
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(total) });
    let sent = 0;
    const pump = () => {
      while (sent < total) {
        const piece = sent + chunk.length > total ? chunk.subarray(0, total - sent) : chunk;
        sent += piece.length;
        if (!res.write(piece)) {
          res.once('drain', pump);
          return;
        }
      }
      res.end();
    };
    pump();
    return;
  }

  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`hello from origin server :${port}\n你访问的是 ${req.method} ${req.url}\n`);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[origin] 监听 http://127.0.0.1:${port}\n`);
});
