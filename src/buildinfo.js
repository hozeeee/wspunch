'use strict';

/**
 * 构建期注入的信息。
 *
 * 打包时 build.js 会用 esbuild 的 define 把 __BUNDLED__ / __VERSION__ 替换成字面量；
 * 直接跑源码时这两个标识符不存在，靠 typeof 兜底成 dev 模式。
 */

const BUNDLED = typeof __BUNDLED__ !== 'undefined' && __BUNDLED__ === true;
const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : 'dev';

/** 可执行脚本的名字，帮助文本与下载文件名都用它。 */
const NAME = 'wsfwd';

module.exports = { BUNDLED, VERSION, NAME };
