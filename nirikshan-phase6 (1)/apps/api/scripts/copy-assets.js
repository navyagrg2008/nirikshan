const fs = require('fs'); const path = require('path');
const src = path.join(__dirname, '..', 'src', 'db', 'migrations'); const dst = path.join(__dirname, '..', 'dist', 'db', 'migrations');
fs.mkdirSync(dst, { recursive: true });
for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dst, f));
console.log('copied migrations');
