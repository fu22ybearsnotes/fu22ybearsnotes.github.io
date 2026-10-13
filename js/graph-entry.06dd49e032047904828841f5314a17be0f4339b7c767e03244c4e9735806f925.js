(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.GraphEntry = api;
})(typeof globalThis === 'undefined' ? null : globalThis, function () {
  // Strict, single decoding: URLSearchParams silently repairs malformed UTF-8.
  function resolve(fragment, ids) {
    const values = [];
    for (const pair of fragment.replace(/^#/, '').split('&')) {
      const separator = pair.indexOf('=');
      const key = separator < 0 ? pair : pair.slice(0, separator);
      let decodedKey;
      try { decodedKey = decodeURIComponent(key); } catch { continue; }
      if (decodedKey === 'post') values.push(separator < 0 ? '' : pair.slice(separator + 1));
    }
    if (!values.length) return { type: 'absent' };
    if (values.length !== 1) return { type: 'invalid' };
    let id;
    try { id = decodeURIComponent(values[0]); } catch { return { type: 'invalid' }; }
    return id && ids.has(id) ? { type: 'valid', id } : { type: 'invalid' };
  }

  return { resolve };
});
