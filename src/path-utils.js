const path = require('path');

function normalizeRoot(value) {
  let root = String(value || '/').trim().replace(/\\/g, '/');
  if (!root.startsWith('/')) root = `/${root}`;
  root = path.posix.normalize(root);
  if (root === '.') root = '/';
  if (root.length > 1) root = root.replace(/\/+$/, '');
  return root || '/';
}

module.exports = { normalizeRoot };
