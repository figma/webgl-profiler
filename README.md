# WebGL Profiler

This repository contains a small library to enable GPU-side profiling of
WebGL command queues using the `EXT_disjoint_timer_query` OpenGL extension.
The output at the end is a profile that can be dropped into
https://www.speedscope.app/ and viewed as a flamechart.

We need to do special profiling GPU-side because CPU-side gl calls are not
synchronized with the GPU's actual execution of those commands. Instead, to
measure how long things are taking on the GPU, we need to insert special
commands into the GPU's command queue telling it when to start a timer and
when to stop the timer.

This comes with an annoying list of limitations:

- This currently only works in Desktop Chrome >= 70.
  The extension was completedly removed in Chrome in Chrome 65
  (https://crbug.com/808744) and Firefox 63 due to a severe security
  vulnerability (https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2018-10229).
  It was re-introduced in Chrome 70 (https://crbug.com/820891). There's
  an open bug for re-exposing this in Android Chrome (https://crbug.com/870491).

- There's no way to ask for a timestamp. This is what `TIMESTAMP_EXT`
  was designed for, but it was removed in 2016 (https://crbug.com/595172).
  This makes it difficult to see how much time has elapsed between queries,
  so instead we need to have queries always running.

- It seems like the elapsed time for every command other than draw calls is
  indicated as zero on GPUs I've tested. The total elapsed times still seem
  ballpark correct when comparing against active GPU time in a Chrome
  performance profile, however. This could either mean that the GPU times of
  other commands are negligible, or that the EXT_disjoint_timer_query is lying
  in this cases :|

- Some graphics card/driver combinations seem to have unresolvably buggy
  behavior. This unfortunately includes the NVIDIA GeForce GT 750M, which is
  actually the very first card I tested this on, since it's the discrete
  graphics card on my MacBook Pro! If you try to use the profiler with this
  card, it will hard crash to avoid providing confusing information. Other
  cards are probably buggy too. See: https://twitter.com/jlfwong/status/1058475013546770432

## Usage

To use this library, you can either install it as an npm module, or just
include it as a script tag:

```html
  <script src="webgl-profiler.js"></script>
```

If consuming through npm, you can get access to the `WebGLProfiler` class
via `const WebGLProfiler = require('webgl-profiler')`. If you included it
as a script tag, you can access it as a global `WebGLProfiler` variable.

From there, you can construct a profiler for a given `WebGLRenderingContext`,
like so:

```javascript
const gl = canvas.getContext('webgl');
const profiler = new WebGLProfiler(gl)
```

To start a profile, run `profiler.start()`. To stop a profile, wait for the GPU
commands to flush, then download a file that can be imported into
https://www.speedscope.app/, run `profiler.stopAndDownload()`.

Unlike CPU side operations, there's no concept of a "call stack", so we need
to explicitly annotate the GPU command queue with human-readable information.
You can either do this via paired calls to
`profiler.pushContext(contextName)` and `profiler.popContext(contextName)`, or
you can use `profiler.withContext(contextName)`.

Here's the relevant bits of an example usage:

```javascript
var profiler = new WebGLProfiler(gl)
profiler.start()
{
  profiler.pushContext("a")
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  {
    profiler.pushContext("b")
    for (let i = 0; i < 10; i++) {
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    profiler.popContext("b")

    profiler.withContext("c", function() {
      for (let i = 0; i < 10; i++) {
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
    })
  }
  profiler.popContext("a")
}
profiler.stopAndDownload()
```

You can see a full working example in [`example.html`](example.html).