
if (typeof module === "object" && typeof module.exports === "object") {
  module.exports = WebGLProfiler
} else if (typeof window !== 'undefined') {
  window['WebGLProfiler'] = WebGLProfiler
}
})();