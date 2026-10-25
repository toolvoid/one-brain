const fs = require('fs');
for (const name of fs.readdirSync('release')) {
  const stat = fs.statSync('release/' + name);
  if (stat.isFile()) console.log(name, (stat.size / 1048576).toFixed(1) + ' MiB');
}
