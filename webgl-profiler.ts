/*
 * This is a utility class for profiling GPU-side operations using the
 * EXT_disjoint_timer_query OpenGL extension.
 *
 * We need to do special profiling GPU-side because CPU-side gl
 * calls are not synchronized with the GPU's actual execution of those
 * commands. Instead, to measure how long things are taking on the GPU, we
 * need to insert special commands into the GPU's command queue telling it
 * when to start a timer and when to stop the timer.
 *
 * This extension has a number of annoying limitations:
 *  - Only one query can be active at a time. This means that we need to
 *    implement nested timers ourselves in order to be able to produce
 *    helpful flamegraphs.
 *  - This currently only works in Desktop Chrome >= 70.
 *    The extension was completedly removed in Chrome in Chrome 65
 *    (https://crbug.com/808744) and Firefox 63 due to a severe security
 *    vulnerability (https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2018-10229).
 *    It was re-introduced in Chrome 70 (https://crbug.com/820891). There's
 *    an open bug for re-exposing this in Android Chrome (https://crbug.com/870491).
 *  - There's no way to ask for a timestamp. This is what `TIMESTAMP_EXT`
 *    was designed for, but it was removed in 2016 (https://crbug.com/595172).
 *    This makes it difficult to see how much time has elapsed between queries,
 *    so instead we need to have queries always running.
 *  - It seems like the elapsed time for every command other than draw calls is
 *    indicated as zero on GPUs I've tested. The total elapsed times still seem
 *    ballpark correct when comparing against active GPU time in a Chrome
 *    performance profile, however. This could either mean that the GPU times of
 *    other commands are negligible, or that the EXT_disjoint_timer_query is lying
 *    in this cases :|
 *
 * Since only one disjoint timer query can be active at a time, in order to create
 * nested timers, we mark "OPEN_FRAME" and "CLOSE_FRAME" events along the timeline
 * by changing the active timer at each event. It should look something like this:
 *
 *                                ---------- Time --------->
 *
 * Queries   q1      q2      q3        q4        q5    q6      q7          q8      q9
 *          <-> <---------> <---> <-----------> <---> <--> <----------> <-------> <->
 *
 * Stack   +---+-----------------------------------------------------------------+---+
 *             |                         Draw Frame                              |
 *             +-----------+-------------------------+----+------------+---------+
 *                         |        Draw Node        |    | Draw Hover |
 *                         +-----+-------------+-----+    +------------+
 *                               | Draw Shadow |
 *                               +-------------+
 *
 * Events
 *    q1 start: profile start
 *    q2 start: OPEN_FRAME "Draw Frame"
 *    q3 start: OPEN_FRAME "Draw Node"
 *    q4 start: OPEN_FRAME "Draw Shadow"
 *    q5 start: CLOSE_FRAME "Draw Shadow"
 *    q6 start: CLOSE_FRAME "Draw Node"
 *    q7 start: OPEN_FRAME "Draw Hover"
 *    q8 start: CLOSE_FRAME "Draw Hover"
 *    q9 start: CLOSE_FRAME "Draw Frame"
 *    q9 end: profile end
 *
 * For each query, the only information we know about it is its duration.
 * Assuming we have timing queries running for the entire duration of the
 * profile, however, this is sufficient to construct a flamegraph as long as
 * we remember what event is associated with the start/end of each query.
 */
class WebGLProfiler {
  private readonly context: WebGLRenderingContext
  private readonly ext: EXTDisjointTimerQuery | null = null
  private activeQuery: WebGLTimerQueryEXT | null = null
  private isRunning = false

  // This list contains events whose beginQueryEXT/endQueryEXT calls have been
  // enqueued in the GPU command buffer, but whose timing results aren't yet
  // available. These are in chronological order.
  private eventsPendingTimestamps: GPUProfilerEventPendingTimestamp[] = []

  // This list contains events whose timestamps have already been inferred based
  // on the durations retrieved from the GPU. These are also in chronological order.
  private resolvedEvents: GPUProfilerResolvedEvent[] = []

  // This is a stack of currently active named contexts. This is used to validate
  // that the pushContext/popContext calls match up properly.
  private namedContextStack: string[] = []

  constructor(context: WebGLRenderingContext) {
    this.context = context
    this.ext = context.getExtension("EXT_disjoint_timer_query") as EXTDisjointTimerQuery | null
  }

  isProfilerRunning(): boolean {
    return this.isRunning
  }

  start(): void {
    if (this.ext == null) {
      throw new Error("EXT_disjoint_timer_query WebGL extension is not available. Cannot start profiler.")
    }
    if (this.isRunning) {
      throw new Error("Profiler is already running")
    }
    const infoExt = this.context.getExtension("WEBGL_debug_renderer_info")
    if (infoExt != null) {
      const renderer: string = this.context.getParameter(infoExt.UNMASKED_RENDERER_WEBGL)
      if (renderer.indexOf("NVIDIA GeForce GT 750M") !== -1) {
        // See: https://twitter.com/jlfwong/status/1058475013546770432
        throw new Error(`${renderer} cards seem to have a buggy implementation of EXT_disjoint_timer_query. Refusing to record to avoid misleading results.`)
      }
    }

    this.isRunning = true
    this.eventsPendingTimestamps = []
    this.resolvedEvents = []

    this.activeQuery = this.ext.createQueryEXT()
    this.ext.beginQueryEXT(this.ext.TIME_ELAPSED_EXT, this.activeQuery)

    this.pushContext("profile")
  }

  stop(): void {
    if (this.ext == null) {
      return
    }
    if (!this.isRunning) {
      throw new Error("Profiler is already stopped")
    }
    this.isRunning = false

    this.popContext("profile")
    this.activeQuery = null
    this.ext.endQueryEXT(this.ext.TIME_ELAPSED_EXT)
  }

  pushContext(name: string): void {
    this.markAction({type: GPUProfilerActionType.OPEN_FRAME, name})
    this.namedContextStack.push(name)
  }

  popContext(name: string): void {
    if (this.namedContextStack.length === 0) {
      throw new Error("Tried to pop a context when the context stack is empty!")
    }
    const popped = this.namedContextStack.pop()
    if (popped !== name) {
      throw new Error(`Expected popContext to be called with ${popped}, but it was called with ${name}`)
    }
    this.markAction({type: GPUProfilerActionType.CLOSE_FRAME, name})
  }

  withContext(name: string, callback: () => void): void {
    this.pushContext(name)
    callback()
    this.popContext(name)
  }

  async exportSpeedscopeProfile(): Promise<string> {
    while (this.eventsPendingTimestamps.length > 0) {
      this.resolveEventsIfPossible()
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }

    return this.toSpeedscopeProfile()
  }

  async downloadWhenReady() {
    const profileText = await this.exportSpeedscopeProfile()

    const link = document.createElement("a")
    link.href = URL.createObjectURL(new Blob([profileText], { "type": "application/json" }))
    link.download = `gpuprofile-${+new Date()}.speedscope.json`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  async stopAndDownload() {
    this.stop()
    await this.downloadWhenReady()
  }

  private markAction(action: GPUProfilerAction): void {
    if (this.ext == null) {
      return
    }

    if (this.activeQuery == null) {
      throw new Error("Cannot mark actions while no profile is active")
    }

    const oldQuery = this.activeQuery
    this.activeQuery = this.ext.createQueryEXT()

    this.ext.endQueryEXT(this.ext.TIME_ELAPSED_EXT)
    this.ext.beginQueryEXT(this.ext.TIME_ELAPSED_EXT, this.activeQuery)

    this.eventsPendingTimestamps.push({action, query: oldQuery})
  }

  private resolveEventsIfPossible(): void {
    if (this.ext == null) {
      return
    }

    let i = 0
    while (i < this.eventsPendingTimestamps.length) {
      let pendingAction = this.eventsPendingTimestamps[i]
      let query = pendingAction.query
      if (!this.ext.getQueryObjectEXT(query, this.ext.QUERY_RESULT_AVAILABLE_EXT)) {
        break
      }

      // I don't totally understand what this means, but apparently if this is true,
      // it means that the GPU timing information is definitely going to unreliable.
      // This is based on this example:
      // https://developer.mozilla.org/en-US/docs/Web/API/EXT_disjoint_timer_query/getQueryObjectEXT#Examples
      if (this.context.getParameter(this.ext.GPU_DISJOINT_EXT)) {
        throw new Error("GPU_DISJOINT_EXT")
      }

      const elapsed = this.ext.getQueryObjectEXT(query, this.ext.QUERY_RESULT_EXT)

      // TODO(jlfwong): If the creation & deletion of queries ends up having non-trivial
      // overhead, we could generate a bunch of queries up-front, and then use a free list
      // instead of needing to call createQueryEXT and deleteQueryEXT all the time.
      this.ext.deleteQueryEXT(query)

      var lastTimestamp = this.resolvedEvents.length === 0 ? 0 : this.resolvedEvents[this.resolvedEvents.length - 1].timestamp
      var timestamp = lastTimestamp + elapsed

      this.resolvedEvents.push({action: pendingAction.action, timestamp})
      i++
    }

    if (i > 0) {
      this.eventsPendingTimestamps = this.eventsPendingTimestamps.slice(i)
    }
  }

  // Convert the currently recorded profile into speedscope's
  // file format.
  private toSpeedscopeProfile(): string {
    const frames: SpeedscopeFrame[] = []
    const speedscopeEvents: (SpeedscopeOpenFrameEvent | SpeedscopeCloseFrameEvent)[] = []

    if (this.resolvedEvents.length === 0) {
      throw new Error("Profile is empty")
    }

    const profile: SpeedscopeEventedProfile = {
      "type": SpeedscopeProfileType.EVENTED,
      "name": "GPU Profile",
      "unit": "nanoseconds",
      "startValue": 0,
      "endValue": this.resolvedEvents[this.resolvedEvents.length - 1].timestamp,
      "events": speedscopeEvents
    }

    const file: SpeedscopeFile = {
      "$schema": "https://www.Speedscopeapp/file-format-schema.json",
      "shared": {
        "frames": frames,
      },
      "profiles": [profile]
    }

    const frameToIndex: {[key: string]: number} = {}


    function getOrInsertFrame(name: string): number {
      if (!(name in frameToIndex)) {
        frameToIndex[name] = frames.length
        frames.push({
          "name": name
        })
      }
      return frameToIndex[name]
    }

    for (let event of this.resolvedEvents) {
      speedscopeEvents.push({
        "type": event.action.type == GPUProfilerActionType.OPEN_FRAME ? SpeedscopeEventType.OPEN_FRAME : SpeedscopeEventType.CLOSE_FRAME,
        "frame": getOrInsertFrame(event.action.name),
        "at": event.timestamp
      } as (SpeedscopeOpenFrameEvent | SpeedscopeCloseFrameEvent))
    }

    return JSON.stringify(file)
  }
}

enum GPUProfilerActionType {
  OPEN_FRAME,
  CLOSE_FRAME
}

interface GPUProfilerAction {
  readonly type: GPUProfilerActionType
  readonly name: string
}

interface GPUProfilerEventPendingTimestamp {
  readonly action: GPUProfilerAction
  readonly query: WebGLTimerQueryEXT
}

interface GPUProfilerResolvedEvent {
  readonly action: GPUProfilerAction
  readonly timestamp: number
}

// DOM APIs
interface WebGLTimerQueryEXT {}

interface EXTDisjointTimerQuery {
  QUERY_COUNTER_BITS_EXT: 0x8864
  CURRENT_QUERY_EXT: 0x8865
  QUERY_RESULT_EXT: 0x8866
  QUERY_RESULT_AVAILABLE_EXT: 0x8867
  TIME_ELAPSED_EXT: 0x88BF
  TIMESTAMP_EXT: 0x8E28
  GPU_DISJOINT_EXT: 0x8FBB

  createQueryEXT(): WebGLTimerQueryEXT
  deleteQueryEXT(query: WebGLTimerQueryEXT): void
  isQueryEXT(query: WebGLTimerQueryEXT): boolean
  beginQueryEXT(target: GLenum, query: WebGLTimerQueryEXT): void
  endQueryEXT(target: GLenum): void
  getQueryEXT(target: GLenum, pname: GLenum): any
  getQueryObjectEXT(query: WebGLTimerQueryEXT, pname: 0x8867 /* QUERY_RESULT_AVAILBLE_EXT */): boolean
  getQueryObjectEXT(query: WebGLTimerQueryEXT, pname: 0x8866 /* QUERY_RESULT_EXT */): number
  getQueryObjectEXT(query: WebGLTimerQueryEXT, pname: GLenum): any
}

// speedscope types (from https://github.com/jlfwong/speedscope/blob/master/src/lib/file-format-spec.ts)
interface SpeedscopeFile {
  $schema: 'https://www.Speedscopeapp/file-format-schema.json'

  // Data shared between profiles
  shared: {
    frames: SpeedscopeFrame[]
  }

  // List of profile definitions
  profiles: SpeedscopeEventedProfile[]

  // The name of the contained profile group. If omitted, will use the name of
  // the file itself.
  // Added in 0.6.0
  name?: string

  // The index into the `profiles` array that should be displayed upon file
  // load. If omitted, will default to displaying the first profile in the
  // file.
  //
  // Added in 0.6.0
  activeProfileIndex?: number

  // The name of the the program which exported this profile. This isn't
  // consumed but can be helpful for debugging generated data by seeing what
  // was generating it! Recommended format is "name@version". e.g. when the
  // file was exported by speedscope v0.6.0 itself, it will be
  // "speedscope@0.6.0"
  //
  // Added in 0.6.0
  exporter?: string
}

interface SpeedscopeFrame {
  name: string
  file?: string
  line?: number
  col?: number
}

enum SpeedscopeProfileType {
  EVENTED = 'evented',
  SAMPLED = 'sampled',
}

interface SpeedscopeEventedProfile {
  type: SpeedscopeProfileType.EVENTED

  // Name of the profile. Typically a filename for the source of the profile.
  name: string

  // Unit which all value are specified using in the profile.
  unit: SpeedscopeValueUnit

  // The starting value of the profile. This will typically be a timestamp.
  // All event values will be relative to this startValue.
  startValue: number

  // The final value of the profile. This will typically be a timestamp. This
  // must be greater than or equal to the startValue. This is useful in
  // situations where the recorded profile extends past the end of the recorded
  // events, which may happen if nothing was happening at the end of the
  // profile.
  endValue: number

  // List of events that occured as part of this profile.
  // The "at" field of every event must be in non-decreasing order.
  events: (SpeedscopeOpenFrameEvent | SpeedscopeCloseFrameEvent)[]
}

type SpeedscopeValueUnit =
  | 'none'
  | 'nanoseconds'
  | 'microseconds'
  | 'milliseconds'
  | 'seconds'
  | 'bytes'

enum SpeedscopeEventType {
  OPEN_FRAME = 'O',
  CLOSE_FRAME = 'C',
}

// Indicates a stack frame opened. Every opened stack frame must have a
// corresponding close frame event, and the ordering must be balanced.
interface SpeedscopeOpenFrameEvent {
  type: SpeedscopeEventType.OPEN_FRAME
  // An index into the frames array in the shared data within the profile
  frame: number
}

interface SpeedscopeCloseFrameEvent {
  type: SpeedscopeEventType.CLOSE_FRAME
  // An index into the frames array in the shared data within the profile
  frame: number
}