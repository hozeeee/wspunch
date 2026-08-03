#!/usr/bin/env node
'use strict';

/**
 * 把 src/ 和 node_modules 里的依赖打成一个可执行的单文件：dist/wsfwd.js
 *
 *   node build.js            构建
 *   node build.js --minify   顺手压缩（默认不压，方便对端 review 拿到的代码）
 *
 * 两个要点：
 *   1. bufferutil / utf-8-validate 是 ws 的可选原生依赖，它自己用 try/catch 包着，
 *      标成 external 后打包产物里的 require 失败也只会被 ws 吞掉，不影响功能；
 *   2. 用 define 注入 __BUNDLED__ / __VERSION__，运行时据此决定 /download
 *      能不能把自己吐出去（见 src/http-routes.js）。
 */

const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const pkg = require('./package.json');
const OUT_DIR = path.join(__dirname, 'dist');
const OUT_FILE = path.join(OUT_DIR, 'wsfwd.js');

async function main() {
  const minify = process.argv.includes('--minify');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(__dirname, 'src', 'cli.js')],
    outfile: OUT_FILE,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    minify,
    legalComments: 'none',
    external: ['bufferutil', 'utf-8-validate'],
    define: {
      __BUNDLED__: 'true',
      __VERSION__: JSON.stringify(pkg.version),
    },
    // src/cli.js 的 shebang 会被 esbuild 原样提到产物最前面，这里只补一行出处说明
    banner: {
      js: `// wsfwd ${pkg.version} —— 单文件构建产物，源码见项目的 src/ 目录\n`,
    },
  });

  fs.chmodSync(OUT_FILE, 0o755);
  const { size } = fs.statSync(OUT_FILE);
  process.stdout.write(
    `构建完成：${path.relative(__dirname, OUT_FILE)}（${(size / 1024).toFixed(1)} KB${minify ? '，已压缩' : ''}）\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`构建失败：${err.message}\n`);
  process.exit(1);
});
