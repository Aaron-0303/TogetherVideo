function cleanName(value) {
  return String(value || '访客').trim().replace(/[<>]/g, '').slice(0, 20) || '访客';
}

module.exports = { cleanName };
